import { expect, it, vi } from "vitest";
import { createSubagentRunRecord } from "../agents/subagent-test-fixtures.test-helpers.js";
import { createLifecycleControllerFixture } from "../agents/subagents/registry/subagent-registry-lifecycle-controller.test-support.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import { saveSubagentRegistryChangesToSqlite } from "../agents/subagents/registry/subagent-registry-state.fixture.test-support.js";
import { settleRestartInterruptedSubagentRun } from "../agents/subagents/registry/subagent-registry-sweep-settle.js";
import { observeRootWork } from "../agents/subagents/registry/subagent-registry.browser-cleanup.test-support.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.sqlite-entry.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import { getPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { ensureGatewayOwnerProfile, ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { QueuedOperatorRecoverySource } from "./operator-run-recovery-source.codec.js";
import {
  createOperatorRecoveryFixture,
  pairedOperator,
} from "./operator-run-recovery.test-support.js";
import { ADMIN_SCOPE, READ_SCOPE, WRITE_SCOPE } from "./operator-scopes.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { createContext } from "./server-plugin-in-process-dispatch.test-support.js";
import { prepareRestartCompletionCustody } from "./session-restart-resume-custody.js";
import {
  discoverRestartSessionStores,
  prepareRestartStores,
} from "./session-restart-resume-discovery.js";

type WokenAs = { profileId?: string; scopes?: readonly string[] };

/** Restores one owed child after a restart and returns the authority its woken parent turn had. */
async function deliverOwedNoticeAfterRestart(params: {
  state: "completed" | "interrupted";
  createdActor?: InternalSessionEntry["createdActor"];
  requesterOperatorSource?: QueuedOperatorRecoverySource;
  context: GatewayRequestContext;
  sessionKey?: string;
}): Promise<WokenAs | undefined> {
  const { state, sessionKey = "agent:main:dashboard:settled-requester" } = params;
  const target = {
    agentId: "main",
    physicalAgentId: "main",
    storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
  };
  const entry = {
    sessionId: "settled-requester",
    lifecycleRevision: "original-revision",
    updatedAt: 1,
    ...(params.createdActor ? { createdActor: params.createdActor } : {}),
  };
  replaceSessionEntrySync({ ...target, sessionKey }, entry);
  const child = createSubagentRunRecord({
    runId: "owed-completion",
    childSessionKey: "agent:main:subagent:finished-child",
    requesterSessionKey: sessionKey,
    requesterAgentId: "main",
    requesterStorePath: target.storePath,
    completionRequesterSessionId: entry.sessionId,
    completionRequesterLifecycleRevision: entry.lifecycleRevision,
    expectsCompletionMessage: true,
    spawnMode: "session",
    completionTarget: "parent",
    ...(params.requesterOperatorSource
      ? { requesterOperatorSource: params.requesterOperatorSource }
      : {}),
    ...(state === "completed"
      ? { endedAt: 1, delivery: { status: "pending" as const } }
      : {
          createdAt: Math.floor(performance.timeOrigin) - 10_000,
          startedAt: Math.floor(performance.timeOrigin) - 9_000,
        }),
  });
  subagentRuns.set(child.runId, child);
  subagentRuns.retireCompletionAuthority(child);
  try {
    const restart = {
      context: params.context,
      signal: new AbortController().signal,
      log: { warn: vi.fn() },
    };
    restart.context.resolveGatewayContext ??= () => restart.context;
    const recover = async () => {
      const stores = await prepareRestartStores(restart, [target]);
      expect(stores?.[0]?.entries.map((row) => row.sessionKey)).toContain(sessionKey);
      await prepareRestartCompletionCustody(restart, stores![0]!);
      expect(restart.log.warn.mock.calls).toEqual([]);
    };
    if (state === "completed") {
      await recover();
      expect(subagentRuns.isCompletionAuthorityRetired(child)).toBe(false);
      return undefined;
    }
    const received: string[] = [];
    let wokenAs: WokenAs | undefined;
    const controller = createLifecycleControllerFixture(
      {
        entry: child,
        runs: subagentRuns,
        realWorker: true,
        runSubagentAnnounceFlow: async (notice) => {
          const client = getPluginRuntimeGatewayRequestScope()?.client;
          wokenAs = {
            profileId: client?.internal?.operatorRunAuthority?.profileId,
            scopes: client?.connect.scopes,
          };
          if (notice.outcome?.status !== "error") {
            throw new Error("Missing interrupted outcome");
          }
          received.push(notice.outcome.error!);
          return "delivered";
        },
      },
      {
        callGateway: vi.fn(),
        cleanupBrowserSessionsForLifecycleEnd: vi.fn(async () => {}),
        ownersByEntry: new Map(),
      },
    );
    saveSubagentRegistryChangesToSqlite(subagentRuns, [child.runId]);
    const settle = async () => {
      const drain = observeRootWork();
      try {
        return await settleRestartInterruptedSubagentRun({
          runId: child.runId,
          entry: subagentRuns.get(child.runId)!,
          complete: controller.completeSubagentRun,
          now: Date.now(),
        });
      } finally {
        await drain();
      }
    };
    expect(await settle()).toBe(false);
    await recover();
    await settle();
    expect(received).toEqual([
      "The Gateway stopped before this subagent finished. Its run did not survive the restart; inspect its saved work before retrying.",
    ]);
    expect(subagentRuns.get(child.runId)?.delivery?.status).toBe("delivered");
    return wokenAs;
  } finally {
    subagentRuns.delete(child.runId);
  }
}

it.each([
  { state: "completed", requester: "profile" },
  { state: "interrupted", requester: "profile" },
  { state: "interrupted", requester: "unattributed" },
] as const)(
  "delivers a restored $state child's owed notice after its legacy $requester requester settled",
  ({ state, requester }) =>
    withOpenClawTestState({ scenario: "minimal" }, async () => {
      setRuntimeConfigSnapshot({});
      const person = ensureGatewayOwnerProfile("Restart custody owner");
      const wokenAs = await deliverOwedNoticeAfterRestart({
        state,
        context: createContext(),
        ...(requester === "profile"
          ? { createdActor: { type: "human", source: "profile", id: person.id } }
          : {}),
      });
      if (state === "interrupted") {
        // A row without a saved requester uses the session principal, else the System write
        // baseline, never admin.
        expect(wokenAs).toMatchObject(
          requester === "profile" ? { profileId: person.id } : { scopes: [WRITE_SCOPE] },
        );
      }
    }),
);

it.each([
  { requester: "owner", scopes: [ADMIN_SCOPE], admin: true },
  { requester: "writer", scopes: [READ_SCOPE, WRITE_SCOPE], admin: false },
])(
  "wakes the parent with the saved $requester requester's scopes after a restart",
  ({ scopes, admin }) =>
    withOpenClawTestState({ scenario: "minimal" }, async ({ stateDir }) => {
      setRuntimeConfigSnapshot({});
      const profile = ensureProfileForEmail("restart-requester@example.test");
      const spawned = await createOperatorRecoveryFixture({
        stateDir,
        profileId: profile.id,
        context: createContext(),
        config: {},
        scopes,
        device: pairedOperator(),
        // The requester's chat; a second chat for the same person would archive it as stale.
        sessionKey: "agent:main:dashboard:settled-requester",
        sessionId: "settled-requester",
      });
      // Stable's fixture has already released the live source, just as restart would.
      const requesterOperatorSource = { kind: "gateway", snapshot: spawned.snapshot } as const;
      const wokenAs = await deliverOwedNoticeAfterRestart({
        state: "interrupted",
        createdActor: { type: "human", source: "profile", id: profile.id },
        requesterOperatorSource,
        context: spawned.context,
      });
      expect(wokenAs?.profileId).toBe(profile.id);
      if (admin) {
        expect(wokenAs?.scopes).toContain(ADMIN_SCOPE);
      } else {
        expect(wokenAs?.scopes).toContain(WRITE_SCOPE);
        expect(wokenAs?.scopes).not.toContain(ADMIN_SCOPE);
      }
    }),
);

it("recovers a sibling child when another child's saved requester is refused", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    setRuntimeConfigSnapshot({});
    const target = {
      agentId: "main",
      physicalAgentId: "main",
      storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
    };
    const sessionKey = "agent:main:dashboard:two-children";
    const entry = { sessionId: "two-children", lifecycleRevision: "rev", updatedAt: 1 };
    replaceSessionEntrySync({ ...target, sessionKey }, entry);
    const [refused, legacy] = (["refused", "legacy"] as const).map((name) =>
      createSubagentRunRecord({
        runId: `${name}-child`,
        childSessionKey: `agent:main:subagent:${name}`,
        requesterSessionKey: sessionKey,
        requesterAgentId: "main",
        requesterStorePath: target.storePath,
        completionRequesterSessionId: entry.sessionId,
        completionRequesterLifecycleRevision: entry.lifecycleRevision,
        expectsCompletionMessage: true,
        spawnMode: "session",
        completionTarget: "parent",
        endedAt: 1,
        delivery: { status: "pending" },
        // A source that current policy refuses, for example a revoked device.
        ...(name === "refused" ? { requesterOperatorSource: { kind: "unavailable" } } : {}),
      }),
    );
    for (const child of [refused!, legacy!]) {
      subagentRuns.set(child.runId, child);
      subagentRuns.retireCompletionAuthority(child);
    }
    try {
      const context = createContext();
      context.resolveGatewayContext = () => context;
      const restart = { context, signal: new AbortController().signal, log: { warn: vi.fn() } };
      const stores = await prepareRestartStores(restart, [target]);
      await prepareRestartCompletionCustody(restart, stores![0]!);
      expect(subagentRuns.isCompletionAuthorityRetired(refused!)).toBe(true);
      expect(subagentRuns.isCompletionAuthorityRetired(legacy!)).toBe(false);
      expect(restart.log.warn).toHaveBeenCalledWith(
        expect.stringContaining("Restart completion recovery failed for refused-child"),
      );
    } finally {
      subagentRuns.delete(refused!.runId);
      subagentRuns.delete(legacy!.runId);
    }
  }));

it.for(["archived", "replaced", "reset"] as const)(
  "does not recover completion custody from a stale %s requester snapshot",
  (change) =>
    withOpenClawTestState({ scenario: "minimal" }, async () => {
      setRuntimeConfigSnapshot({});
      const person = ensureGatewayOwnerProfile("Restart custody owner");
      const target = {
        agentId: "main",
        sessionKey: "agent:main:dashboard:retired-requester",
        storePath: resolveSessionStorePathCore(undefined, { agentId: "main" }),
      };
      const entry: InternalSessionEntry = {
        sessionId: "original-requester",
        lifecycleRevision: "original-revision",
        updatedAt: 1,
        createdActor: { type: "human", source: "profile", id: person.id },
      };
      replaceSessionEntrySync(target, {
        ...entry,
        ...(change === "archived"
          ? { archivedAt: 2 }
          : change === "replaced"
            ? { sessionId: "replacement-requester" }
            : { lifecycleRevision: "reset-revision" }),
      });
      const child = createSubagentRunRecord({
        runId: "retained-child-completion",
        childSessionKey: "agent:main:dashboard:retained-child",
        requesterSessionKey: target.sessionKey,
        requesterAgentId: target.agentId,
        requesterStorePath: target.storePath,
        completionRequesterSessionId: entry.sessionId,
        completionRequesterLifecycleRevision: entry.lifecycleRevision,
        expectsCompletionMessage: true,
        spawnMode: "session",
        completionTarget: "parent",
        endedAt: 1,
        delivery: { status: "pending" },
      });
      subagentRuns.set(child.runId, child);
      subagentRuns.retireCompletionAuthority(child);
      try {
        const warn = vi.fn();
        await prepareRestartCompletionCustody(
          {
            context: createContext(),
            signal: new AbortController().signal,
            log: { warn },
          },
          {
            target: { ...target, physicalAgentId: target.agentId },
            entries: [{ sessionKey: target.sessionKey, entry }],
          },
        );
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining("Restart completion recovery failed"),
        );
        expect(subagentRuns.isCompletionAuthorityRetired(child)).toBe(true);
      } finally {
        subagentRuns.delete(child.runId);
      }
    }),
);

it.for(["default", "explicit"] as const)(
  "retains the captured %s environment for discovered restart stores",
  (mode) =>
    withOpenClawTestState(
      { scenario: "minimal", env: { OPENCLAW_RESTART_CAPTURE_TEST: "captured" } },
      async () => {
        setRuntimeConfigSnapshot({});
        const storePath = resolveSessionStorePathCore(undefined, { agentId: "main" });
        replaceSessionEntrySync(
          { agentId: "main", storePath, sessionKey: "agent:main:restart-env" },
          { sessionId: "restart-env", updatedAt: 1 },
        );
        const supplied = mode === "explicit" ? { ...process.env } : undefined;
        const discovering = discoverRestartSessionStores(
          {
            context: createContext(),
            signal: new AbortController().signal,
            log: { warn: vi.fn() },
          },
          supplied,
        );
        (supplied ?? process.env).OPENCLAW_RESTART_CAPTURE_TEST = "changed-after-capture";
        const targets = await discovering;
        expect(targets.length).toBeGreaterThan(0);
        for (const target of targets) {
          expect(target.env?.OPENCLAW_RESTART_CAPTURE_TEST).toBe("captured");
          expect(target.env).not.toBe(supplied ?? process.env);
        }
      },
    ),
);
