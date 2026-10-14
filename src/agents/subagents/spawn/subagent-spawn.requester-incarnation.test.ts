import "./subagent-spawn-model.mocks.shared.js";
// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { installSpawnAuthorityFixture } from "./subagent-spawn.authority.test-support.js";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { AcpRuntime } from "@openclaw/acp-core/runtime/types";
import { expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../../test/helpers/sqlite-statement-execution-counter.js";
import {
  getAcpSessionManager,
  testing as managerTesting,
} from "../../../acp/control-plane/manager.js";
import { disposeAcpSessionManagerInstance } from "../../../acp/control-plane/manager.lifecycle.js";
import {
  registerAcpRuntimeBackend,
  unregisterAcpRuntimeBackend,
} from "../../../acp/runtime/registry.js";
import {
  captureRuntimeConfigAsyncReader,
  clearConfigCache,
  clearRuntimeConfigSnapshot,
  getRuntimeConfig,
} from "../../../config/config.js";
import {
  loadSessionEntryReadOnly,
  replaceSessionEntrySync,
  upsertSessionEntryCore,
} from "../../../config/sessions/session-accessor.js";
import { LegacyContextEngine } from "../../../context-engine/legacy.js";
import { recordSessionParticipantBestEffort } from "../../../sessions/session-participant-recording.js";
import { AsyncWorkScope } from "../../../shared/async-work-scope.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { resolveOpenClawAgentSqlitePath } from "../../../state/openclaw-agent-db.paths.js";
import { runOpenClawAgentWriteAdmission } from "../../../state/openclaw-agent-write-admission.js";
import { maybeSpawnVisibleSession } from "../../tools/sessions-spawn-visible.js";
import { loadSubagentRegistryFromSqlite } from "../registry/subagent-registry-state.fixture.test-support.js";
import {
  settleSubagentRegistryPersistenceWork,
  writeSubagentSessionEntry,
} from "../registry/subagent-registry.persistence.test-support.js";
import { spawnAcpDirect } from "./acp-spawn.js";
import { resolveSubagentChildPlan } from "./subagent-spawn-child-plan.js";
import { resolveSubagentSpawnRequest } from "./subagent-spawn-request.js";
import { createInitialSubagentSession } from "./subagent-spawn-session-patch.js";
import { spawnSubagentDirect } from "./subagent-spawn.js";
import { testing as spawnTesting } from "./subagent-spawn.test-support.js";

const fixture = installSpawnAuthorityFixture();
const backendId = "requester-incarnation-fixture";

it.each([false, true])(
  "plans children without host reads and sees committed requester preferences (proxied completion=%s)",
  async (proxiedCompletion) => {
    const completionOwnerKey = "agent:main:completion-owner";
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: completionOwnerKey },
      {
        sessionId: "completion-owner",
        updatedAt: 1,
        sandbox: "required",
        createdActor: { type: "human", source: "profile", id: "completion-profile" },
      },
    );
    const request = { task: "inherit requester preferences", context: "isolated" as const };
    const ctx = {
      agentSessionKey: fixture.parentSessionKey,
      ...(proxiedCompletion ? { completionOwnerKey } : {}),
    };
    for (const [thinkingLevel, fastMode] of [
      ["low", false],
      ["high", true],
    ] as const) {
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: fixture.parentSessionKey },
        { sessionId: "controller", updatedAt: 1, thinkingLevel, fastMode },
      );
      const preparation = await resolveSubagentSpawnRequest(request, ctx);
      if (!preparation.ok) {
        throw new Error(JSON.stringify(preparation.result));
      }
      const sql = observeHostDataSql();
      try {
        const plan = await resolveSubagentChildPlan({
          ...preparation.resolved,
          request,
          ctx,
          sandboxMode: "inherit",
          swarmEnabled: true,
        });
        expect(sql.queries).toEqual([]);
        if (!plan.ok) {
          throw new Error(JSON.stringify(plan.result));
        }
        expect(plan.resolved).toMatchObject({
          childRuntimeSandboxed: false,
          creationPolicy: { actor: { type: "agent", id: "main" } },
          modelPlan: { initialSessionPatch: { thinkingLevel, fastMode } },
        });
      } finally {
        sql.restore();
        preparation.resolved.admissionReservation?.release();
      }
    }
  },
);

it("rejects a spawn cancelled during requester acquisition before starting effects", async () => {
  await writeSubagentSessionEntry({
    stateDir: fixture.stateDir,
    agentId: "main",
    sessionKey: fixture.parentSessionKey,
    defaultSessionId: "cancelled-requester",
  });
  const abort = new AbortController();
  const effectsStarted = vi.fn();
  const pending = spawnSubagentDirect(
    { task: "cancel before admission", context: "isolated" },
    {
      agentSessionKey: fixture.parentSessionKey,
      assertActive: () => abort.signal.throwIfAborted(),
      onSpawnEffectsStart: effectsStarted,
    },
  );
  abort.abort(new Error("requester acquisition cancelled"));
  expect(await pending).toEqual({
    status: "error",
    error: "sessions_spawn could not read the requester session: requester acquisition cancelled",
  });
  expect(effectsStarted).not.toHaveBeenCalled();
});

it.each([
  { backend: "native", originalSessionId: "original-requester", globalRequester: false },
  { backend: "acp", originalSessionId: "original-requester", globalRequester: false },
  { backend: "native", originalSessionId: undefined, globalRequester: false },
  { backend: "visible", originalSessionId: "original-requester", globalRequester: true },
] as const)(
  "keeps the birth requester window through async $backend launch (original=$originalSessionId, global=$globalRequester)",
  async ({ backend, originalSessionId, globalRequester }) => {
    const requesterSessionKey = globalRequester ? "global" : "agent:main:completion-owner";
    const controllerSessionKey = globalRequester
      ? "agent:main:dashboard:controller"
      : fixture.parentSessionKey;
    const originalLifecycleRevision = originalSessionId
      ? "original-requester-lifecycle"
      : undefined;
    const replacementLifecycleRevision = "replacement-requester-lifecycle";
    if (globalRequester) {
      const cfg = getRuntimeConfig();
      await writeFile(
        path.join(fixture.stateDir, "openclaw.json"),
        JSON.stringify({
          ...cfg,
          session: { ...cfg.session, scope: "global" },
          agents: {
            ...cfg.agents,
            ownership: "explicit",
            entries: { main: { subagents: { allowAgents: ["worker"] } }, worker: {} },
          },
        }),
      );
      clearConfigCache();
      clearRuntimeConfigSnapshot();
      await captureRuntimeConfigAsyncReader()();
      await writeSubagentSessionEntry({
        stateDir: fixture.stateDir,
        agentId: "worker",
        sessionKey: "global",
        defaultSessionId: "foreign-child-owner",
      });
    }
    await writeSubagentSessionEntry({
      stateDir: fixture.stateDir,
      agentId: "main",
      sessionKey: controllerSessionKey,
      defaultSessionId: "controller-session",
    });
    if (originalSessionId) {
      await writeSubagentSessionEntry({
        stateDir: fixture.stateDir,
        agentId: "main",
        sessionKey: requesterSessionKey,
        defaultSessionId: originalSessionId,
        lifecycleRevision: originalLifecycleRevision,
      });
    }
    if (backend === "acp") {
      const cfg = getRuntimeConfig();
      await writeFile(
        path.join(fixture.stateDir, "openclaw.json"),
        JSON.stringify({
          ...cfg,
          acp: { enabled: true, backend: backendId, allowedAgents: ["main"] },
          agents: {
            ...cfg.agents,
            defaults: { ...cfg.agents?.defaults, model: undefined },
          },
        }),
      );
      clearConfigCache();
      clearRuntimeConfigSnapshot();
      await captureRuntimeConfigAsyncReader()();
      managerTesting.resetAcpSessionManagerForTests();
      const runtime: AcpRuntime = {
        ownerAwareSessions: 1,
        async ensureSession(input) {
          return {
            sessionKey: input.sessionKey,
            agentId: input.agentId,
            backend: backendId,
            runtimeSessionName: input.sessionKey,
            backendSessionId: `fixture:${input.sessionKey}`,
          };
        },
        runTurn() {
          throw new Error("No external harness turn belongs in this boundary test");
        },
        async cancel() {},
        async close() {},
      };
      registerAcpRuntimeBackend({ id: backendId, runtime });
    }
    spawnTesting.setDepsForTest({
      hasInProcessGatewayContext: () => true,
      resolveContextEngine: async () => new LegacyContextEngine(),
      dispatchGatewayMethodInProcess: async <T>(
        method: string,
        params: Record<string, unknown>,
      ) => {
        if (method !== "agent") {
          throw new Error(`Unexpected spawn RPC ${method}`);
        }
        return { runId: params.idempotencyKey, status: "accepted" } as T;
      },
    });
    const rotateRequester = vi.fn(() => {
      // Rotate after requester capture and before child creation; completion
      // must retain that captured window even when later launch steps await.
      replaceSessionEntrySync(
        { sessionKey: requesterSessionKey, agentId: "main" },
        {
          sessionId: "replacement-requester",
          lifecycleRevision: replacementLifecycleRevision,
          updatedAt: Date.now(),
        },
      );
    });
    const ctx = {
      agentSessionKey: controllerSessionKey,
      completionOwnerKey: requesterSessionKey,
      onSpawnEffectsStart: rotateRequester,
      ...(globalRequester ? { requesterAgentIdOverride: "main" } : {}),
    };
    try {
      const pending =
        backend === "native"
          ? spawnSubagentDirect({ task: "window-bound work", context: "isolated" }, ctx)
          : backend === "acp"
            ? spawnAcpDirect({ task: "window-bound work", agentId: "main", mode: "run" }, ctx)
            : maybeSpawnVisibleSession({
                raw: { visible: true },
                ...(globalRequester ? { requestedAgentId: "worker" } : {}),
                task: "window-bound work",
                label: "",
                runtime: "subagent",
                sandbox: "inherit",
                expectsCompletionMessage: true,
                options: {
                  ...ctx,
                  config: getRuntimeConfig(),
                  callGateway: async <T>(method: string) => {
                    if (method !== "sessions.create") {
                      throw new Error(`Unexpected visible spawn RPC ${method}`);
                    }
                    const childAgentId = globalRequester ? "worker" : "main";
                    const childSessionKey = `agent:${childAgentId}:dashboard:window-child`;
                    await writeSubagentSessionEntry({
                      stateDir: fixture.stateDir,
                      agentId: childAgentId,
                      sessionKey: childSessionKey,
                      defaultSessionId: "visible-child-session",
                    });
                    return {
                      key: childSessionKey,
                      sessionId: "visible-child-session",
                      runStarted: true,
                      runId: "visible-child-run",
                    } as T;
                  },
                },
              });
      const result = await pending;
      expect(result).toMatchObject({ status: "accepted" });
      expect(rotateRequester).toHaveBeenCalled();
      const runId = result?.runId;
      if (typeof runId !== "string") {
        throw new Error("Expected an accepted child run");
      }
      await settleSubagentRegistryPersistenceWork();
      const restored = loadSubagentRegistryFromSqlite().get(runId);
      expect(restored).toMatchObject({
        runId,
        requesterSessionKey,
        controllerSessionKey,
        expectsCompletionMessage: true,
      });
      expect(restored?.completionRequesterSessionId).toBe(originalSessionId);
      expect(restored?.completionRequesterLifecycleRevision).toBe(originalLifecycleRevision);
      expect(
        loadSessionEntryReadOnly({ sessionKey: requesterSessionKey, agentId: "main" }),
      ).toMatchObject({
        sessionId: "replacement-requester",
        lifecycleRevision: replacementLifecycleRevision,
      });
    } finally {
      if (backend === "acp") {
        await disposeAcpSessionManagerInstance(getAcpSessionManager(), "test-cleanup");
        managerTesting.resetAcpSessionManagerForTests();
        unregisterAcpRuntimeBackend(backendId);
      }
    }
  },
);

it("inherits accepted human credit when participant persistence is still queued", async () => {
  const agentId = "main";
  const sessionKey = fixture.parentSessionKey;
  const childSessionKey = "agent:main:subagent:child";
  const storePath = resolveOpenClawAgentSqlitePath({ agentId });
  const scope = { agentId, sessionKey, storePath };
  await upsertSessionEntryCore(scope, { sessionId: "parent-id", updatedAt: 1 });
  const releaseWriter = createDeferredCore();
  const writerStarted = createDeferredCore();
  const heldWriter = runOpenClawAgentWriteAdmission({ agentId, path: storePath }, async () => {
    writerStarted.resolve();
    await releaseWriter.promise;
  });
  await writerStarted.promise;
  const work = new AsyncWorkScope();
  const errors: unknown[] = [];
  try {
    work.run(() =>
      recordSessionParticipantBestEffort({
        ...scope,
        storePath,
        identity: { type: "profile", id: "human-requester" },
        promptedAt: 1,
        onError: (error) => errors.push(error),
      }),
    );
    // The real recorder defers its write to the next microtask. Keep that original order.
    await Promise.resolve();
    expect(loadSessionEntryReadOnly(scope)?.participants ?? []).toEqual([]);
    const creation = (async () => {
      const request = await resolveSubagentSpawnRequest(
        { task: "inherit accepted credit", context: "isolated" },
        { agentSessionKey: sessionKey },
      );
      if (!request.ok) {
        throw new Error(JSON.stringify(request.result));
      }
      try {
        return await createInitialSubagentSession({
          cfg: request.resolved.cfg,
          requesterAgentId: agentId,
          targetAgentId: agentId,
          childSessionKey,
          incognito: false,
          requesterInternalKey: sessionKey,
          parentTarget: request.resolved.requesterTarget,
          creationPolicy: { actor: { type: "agent", id: agentId } },
          completionOwnerSessionKey: sessionKey,
          modelPatch: {},
          collect: false,
        });
      } finally {
        request.resolved.admissionReservation?.release();
      }
    })();
    releaseWriter.resolve();
    await heldWriter;
    expect(await creation).toMatchObject({ status: "ok" });
    await work.drain();

    expect(errors).toEqual([]);
    expect(loadSessionEntryReadOnly(scope)?.participants).toEqual([
      { identity: { type: "profile", id: "human-requester" } },
    ]);
    const child = loadSessionEntryReadOnly({ ...scope, sessionKey: childSessionKey });
    expect(child?.inheritedGitContributorProfileIds).toEqual(["human-requester"]);
    expect(child?.participants ?? []).toEqual([]);
  } finally {
    releaseWriter.resolve();
    await heldWriter;
    await work.drain();
  }
});
