import "../test-utils/prepare-compiled-subprocesses.js";
import { expect, it, vi } from "vitest";
import { acceptCompactionSuccessor } from "../agents/embedded-agent-runner/compaction-successor.js";
import { runEmbeddedAgent } from "../agents/embedded-agent.js";
import { resolveGatewayToolOperatorSelection } from "../agents/tools/gateway-caller-context.js";
import {
  captureSessionEventTargetForHost,
  enqueueSessionEventForHost,
} from "../auto-reply/reply/session-event-handoff.js";
import {
  configureEventState,
  openEventToolHost,
  runEventFixture,
} from "../auto-reply/reply/session-event.test-support.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import { assignSessionOwner, patchSessionEntryCore } from "../config/sessions/session-accessor.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.sqlite-entry.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { GatewayOperatorRoleDefinition } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withPluginRuntimeGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import {
  beginSessionEffect,
  captureSessionTarget,
} from "../sessions/session-controller.lifecycle.js";
import { acknowledgeSessionEffectTransition } from "../sessions/session-controller.owner-context.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { linkEmail, setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureGatewayOwnerProfile, ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createGatewayRequestContext } from "./server-request-context.js";
import { makeContextParams } from "./server-request-context.test-support.js";
import { prepareSessionPrincipalRunAuthority } from "./session-sharing-authorization-async.js";
// mock-isolation: Only model execution and the final child launch are synthetic.
vi.mock("../agents/embedded-agent-runner/run.js", () => ({ runEmbeddedAgent: vi.fn() }));
const spawn = vi.hoisted(() => vi.fn());
vi.mock("../agents/subagents/spawn/subagent-spawn.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/subagents/spawn/subagent-spawn.js")>()),
  spawnSubagentDirect: spawn,
}));
await import("../auto-reply/reply/get-reply-from-config.runtime.js").then((runtime) =>
  runtime.prewarmConfigDrivenReplyRuntime(),
);
const scope = { agentId: "main", sessionKey: "agent:main:resume-principal" };
const sessionId = "resume-principal-session";
const writerScopes: GatewayOperatorRoleDefinition["scopes"] = ["operator.read", "operator.write"];
const config = {
  gateway: {
    roles: {
      default: "writer",
      definitions: {
        writer: {
          scopes: writerScopes,
          agents: "*",
          sessions: { others: "none" },
        },
        reader: {
          scopes: ["operator.read"],
          agents: "*",
          sessions: { others: "none" },
        },
      },
    },
  },
} satisfies OpenClawConfig;

function principalContext(cfg: OpenClawConfig) {
  const context = createGatewayRequestContext(makeContextParams());
  context.getRuntimeConfig = () => cfg;
  context.getCommittedRuntimeConfig = () => cfg;
  return context;
}

async function admitPrincipal(params: Parameters<typeof prepareSessionPrincipalRunAuthority>[0]) {
  const admitted = await prepareSessionPrincipalRunAuthority(params);
  return { ...admitted, [Symbol.dispose]: admitted.release };
}

function fixture(cfg: OpenClawConfig = config) {
  setRuntimeConfigSnapshot(cfg);
  const profile = ensureProfileForEmail("resume-principal@example.test");
  const entry: SessionEntry = {
    sessionId,
    lifecycleRevision: "principal-incarnation",
    updatedAt: 1,
    visibility: "draft",
    createdActor: { type: "human", source: "profile", id: profile.id },
  };
  replaceSessionEntrySync(scope, entry);
  return {
    profile,
    entry,
    admit: (storePath = resolveOpenClawAgentSqlitePath({ agentId: scope.agentId })) =>
      admitPrincipal({
        ...scope,
        profileId: profile.id,
        sessionId,
        storePath,
        context: principalContext(cfg),
      }),
  };
}

it("admits a recorded person's current role and refuses revoked, demoted, archived and foreign targets", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    const { profile, entry, admit } = fixture();
    const accepted = await admit();
    expect(accepted.authority.profileId).toBe(profile.id);
    expect(accepted.authority.scopes).toEqual(["operator.read", "operator.write"]);
    expect(accepted.authority.assertCurrent).not.toThrow();
    accepted.release();

    const logical = await admit(resolveSessionStorePathCore(undefined, { agentId: scope.agentId }));
    expect(logical.authority.assertCurrent).not.toThrow();
    logical.release();
    await expect(
      admit(resolveOpenClawAgentSqlitePath({ agentId: "foreign-principal-store" })),
    ).rejects.toThrow("Session is unavailable");

    setUserProfileRole(profile.id, "reader");
    await expect(admit()).rejects.toThrow("no current run authority");
    setUserProfileRole(profile.id, "writer");

    replaceSessionEntrySync(scope, { ...entry, archivedAt: 1 });
    await expect(admit()).rejects.toThrow("Session is unavailable");
    const foreign = { ...scope, sessionKey: "agent:main:foreign-principal" };
    const other = ensureProfileForEmail("foreign-principal@example.test");
    replaceSessionEntrySync(foreign, {
      ...entry,
      sessionId: "foreign-session",
      createdActor: { type: "human", source: "profile", id: other.id },
    });
    await expect(
      prepareSessionPrincipalRunAuthority({
        ...foreign,
        profileId: profile.id,
        sessionId: "foreign-session",
        context: principalContext(config),
      }),
    ).rejects.toThrow();
    replaceSessionEntrySync(scope, entry);

    const replacement = ensureProfileForEmail("replacement-principal@example.test");
    linkEmail("resume-principal@example.test", replacement.id);
    await expect(admit()).rejects.toThrow();
  }));

it("retains admitted session access across row progress and later role edits", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    const { profile, admit } = fixture();
    const accepted = await admit();
    const releaseRun = accepted.authority.retain?.();
    try {
      accepted.release();
      await patchSessionEntryCore(scope, () => ({ sessionId: "compacted-transcript" }), {
        skipMaintenance: true,
      });
      expect(accepted.authority.assertCurrent).not.toThrow();
      setUserProfileRole(profile.id, "reader");
      expect(accepted.authority.assertCurrent).not.toThrow();
      expect(accepted.authority.signal?.aborted).toBe(false);
    } finally {
      releaseRun?.();
      accepted.release();
    }
  }));

it.each([
  { change: "own sharing", patch: { visibility: "shared" as const }, allowed: true },
  {
    change: "run bookkeeping",
    patch: { lifecycleRunId: "resumed-run", activeWriterRunId: "resumed-run" },
    allowed: true,
  },
  { change: "archive", patch: { archivedAt: 1 }, allowed: false },
])(
  "commits $change under the admitted principal and checks fresh starts",
  ({ change, patch, allowed }) =>
    withOpenClawTestState({ scenario: "minimal" }, async () => {
      const { admit } = fixture();
      using accepted = await admit();
      const committed = await patchSessionEntryCore(scope, () => patch, {
        skipMaintenance: true,
        workerGuard:
          change === "own sharing" ? { source: accepted.authority.assertCurrent } : undefined,
      });
      expect(committed).toMatchObject(patch);
      if (!allowed) {
        await expect(admit()).rejects.toThrow("Session is unavailable");
      }
    }),
);

it("admits the recorded Gateway owner without roles and never substitutes it for another person", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    setRuntimeConfigSnapshot({});
    const owner = ensureGatewayOwnerProfile("Gateway owner");
    replaceSessionEntrySync(scope, {
      sessionId,
      updatedAt: 1,
      createdActor: { type: "human", source: "profile", id: owner.id },
    });
    const params = {
      ...scope,
      sessionId,
      storePath: resolveOpenClawAgentSqlitePath({ agentId: scope.agentId }),
      context: principalContext({}),
    };
    using accepted = await admitPrincipal({ ...params, profileId: owner.id });
    expect(accepted.authority.profileId).toBe(owner.id);
    expect(accepted.authority.scopes).toEqual(["operator.admin"]);
    expect(accepted.authority.assertCurrent).not.toThrow();
    expect(accepted.authority.recoverySnapshot).toBeUndefined();
    // Existing sessions may predate lifecycle revisions; reset still creates a new revision.
    const target = captureSessionTarget({
      storeScope: resolveSessionStorePathCore(undefined, { agentId: scope.agentId }),
      physicalStorePath: params.storePath,
      ...scope,
      incarnation: sessionId,
    });
    const effect = await beginSessionEffect({ target });
    try {
      await effect.run(async () => {
        accepted.authority.assertCurrent();
        const compacted = await acceptCompactionSuccessor({
          currentTarget: params,
          expectedEntry: {
            sessionId,
            lifecycleRevision: undefined,
            activeWriterRunId: undefined,
          },
          assertActive: accepted.authority.assertCurrent,
          result: {
            ok: true,
            compacted: true,
            result: { sessionId: "legacy-compacted-transcript", tokensBefore: 0 },
          },
          onCommitted: ({ admissionTransition }) => {
            if (admissionTransition) {
              acknowledgeSessionEffectTransition(target, admissionTransition);
            }
          },
        });
        expect(compacted.entry.sessionId).toBe("legacy-compacted-transcript");
        accepted.authority.assertCurrent();
        // Ordinary initialization also acknowledges unchanged identity. Its nested
        // preparation must not take custody away from the retained outer turn.
        const preparation = await beginSessionEffect({ target });
        try {
          await preparation.run(() => {
            accepted.authority.assertCurrent();
            acknowledgeSessionEffectTransition(target, {
              previous: compacted.entry,
              current: compacted.entry,
            });
            return Promise.resolve();
          });
        } finally {
          preparation.release();
          await preparation.released;
        }
        accepted.authority.assertCurrent();
      });
    } finally {
      effect.release();
      await effect.released;
    }
    const other = ensureProfileForEmail("roleless@example.test");
    await expect(
      prepareSessionPrincipalRunAuthority({ ...params, profileId: other.id }),
    ).rejects.toThrow("no current run authority");
  }));

it.for([
  { caller: "principal", scopes: ["operator.admin"], owner: true },
  { caller: "principal", scopes: ["operator.read", "operator.write"], owner: false },
  { caller: "principal", scopes: ["operator.sessions.write"], owner: false },
  { caller: "guest", scopes: ["operator.read", "operator.write"], owner: false },
] as const)(
  "exec completion retains $caller $scopes across later role edits",
  async ({ caller, scopes, owner }, { signal, onTestFinished }) => {
    await runEventFixture("event-principal", onTestFinished, async (state) => {
      const policy = structuredClone(config);
      policy.gateway.roles.definitions.writer.scopes = [...scopes];
      const cfg = await configureEventState(state, {
        ...policy,
        tools: { profile: "coding", codeMode: false, toolSearch: false },
      });
      const { profile: principal, admit } = fixture(cfg);
      assignSessionOwner(scope, {
        owner: {
          type: "human",
          id: caller === "guest" ? ensureGatewayOwnerProfile("Gateway owner").id : principal.id,
        },
        assignedBy: { type: "system", id: "exec-completion-fixture" },
      });
      const effects: string[] = [];
      spawn.mockReset().mockImplementation(async (_request, context) => {
        expect(resolveGatewayToolOperatorSelection().operatorAuthority).toMatchObject({
          profileId: principal.id,
          scopes,
        });
        if (effects.length) {
          setUserProfileRole(principal.id, "reader");
        }
        // A role edit does not revoke an already admitted completion turn.
        context.assertActive();
        effects.push("spawned");
        return { status: "accepted", runId: "event-child" };
      });
      vi.mocked(runEmbeddedAgent)
        .mockReset()
        .mockImplementation(async (params) => {
          expect(params.senderIsOwner).toBe(owner);
          expect(params.inputProvenance).toMatchObject({
            kind: "internal_system",
            sourceTool: "exec",
          });
          const { tools, close } = await openEventToolHost(params, "exec completion admission", {
            includeOpenClawTools: true,
          });
          try {
            const tool = tools.find((candidate) => candidate.name === "sessions_spawn")!;
            await expect(
              tool.execute("event-spawn", { task: "Continue requested work" }),
            ).resolves.toMatchObject({ details: { status: "accepted" } });
            await expect(
              tool.execute("later-spawn", { task: "Continue requested work" }),
            ).resolves.toMatchObject({ details: { status: "accepted" } });
          } finally {
            close();
          }
          return { payloads: [{ text: "Completion processed" }], meta: { durationMs: 1 } };
        });
      const context = principalContext(cfg);
      using origin = caller === "guest" ? await admit() : undefined;
      const target = await captureSessionEventTargetForHost(scope.agentId, scope.sessionKey, {
        operatorAuthority: origin?.authority,
      });
      const receipt = withPluginRuntimeGatewayContextResolver(
        () => context,
        () =>
          enqueueSessionEventForHost("Process completed; continue requested work.", {
            ...scope,
            source: "exec",
            expectedTarget: target,
            abortSignal: signal,
            deliver: false,
          }),
      );
      const outcome = await receipt.settled;
      expect(outcome, outcome.error).toMatchObject({
        status: "completed",
        executionStarted: true,
      });
      expect(spawn).toHaveBeenCalledTimes(2);
      expect(effects).toEqual(["spawned", "spawned"]);
    });
  },
);
