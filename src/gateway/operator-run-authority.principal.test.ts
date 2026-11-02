import "../test-utils/prepare-compiled-subprocesses.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
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
import {
  assignSessionOwner,
  deleteSessionEntryLifecycle,
  patchSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.sqlite-entry.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { GatewayOperatorRoleDefinition } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as workerAdmission from "../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe } from "../infra/sqlite-worker-owner-probe.test-support.js";
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
    expect(accepted.authority.assertCurrent).toThrow();

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

it("retains current session access through run custody and revokes it before later effects", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    const { profile, entry, admit } = fixture();
    const accepted = await admit();
    const releaseRun = accepted.authority.retain?.();
    try {
      accepted.release();
      await patchSessionEntryCore(scope, () => ({ sessionId: "compacted-transcript" }), {
        skipMaintenance: true,
      });
      expect(accepted.authority.assertCurrent).not.toThrow();
      setUserProfileRole(profile.id, "reader");
      expect(accepted.authority.assertCurrent).toThrow();
      expect(accepted.authority.signal?.aborted).toBe(true);
    } finally {
      releaseRun?.();
      accepted.release();
    }

    setUserProfileRole(profile.id, "writer");
    replaceSessionEntrySync(scope, entry);
    for (const change of ["reset", "archive", "delete"] as const) {
      replaceSessionEntrySync(scope, entry);
      using next = await admit();
      if (change === "delete") {
        await deleteSessionEntryLifecycle({
          agentId: scope.agentId,
          storePath: resolveSessionStorePathCore(undefined, { agentId: scope.agentId }),
          archiveTranscript: false,
          target: { canonicalKey: scope.sessionKey, storeKeys: [scope.sessionKey] },
        });
      } else {
        replaceSessionEntrySync(scope, {
          ...entry,
          ...(change === "reset" ? { lifecycleRevision: "reset-incarnation" } : { archivedAt: 1 }),
        });
      }
      expect(next.authority.assertCurrent).toThrow();
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
])("checks retained principal authority during $change publication", ({ change, patch, allowed }) =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    const { admit } = fixture();
    using accepted = await admit();
    const independently = AsyncLocalStorage.snapshot();
    let commitChecks = 0;
    let pendingChecks = 0;
    const expectCurrentAuthority = () => {
      if (allowed) {
        expect(accepted.authority.assertCurrent).not.toThrow();
        expect(accepted.authority.signal?.aborted).toBe(false);
      } else {
        expect(accepted.authority.assertCurrent).toThrow(Error);
      }
    };
    using _ = sqliteWorkerOwnerProbe.admission(workerAdmission, (request, grant, check) => {
      if (request.stage === "commit") {
        commitChecks++;
      }
      const publication = asOptionalRecord(asOptionalRecord(request.facts)?.publication);
      if (
        change === "own sharing" ||
        request.stage !== "commit" ||
        publication?.kind !== "session-entry-patch-committed"
      ) {
        check(request, grant);
        return;
      }
      check(request, (beforeRelease) =>
        grant(() => {
          beforeRelease?.();
          // Observe the real staged publication outside the competing writer's source context.
          independently(() => {
            pendingChecks++;
            expectCurrentAuthority();
          });
        }),
      );
    });
    const committed = await patchSessionEntryCore(scope, () => patch, {
      skipMaintenance: true,
      workerGuard:
        change === "own sharing" ? { source: accepted.authority.assertCurrent } : undefined,
    });
    expect(commitChecks).toBeGreaterThan(0);
    expect(committed).toMatchObject(patch);
    expect(pendingChecks).toBe(change === "own sharing" ? 0 : 1);
    expectCurrentAuthority();
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
  "exec completion retains $caller $scopes and checks revocation at effect",
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
        // The child executor checks the supplied authority after preparation, before launching.
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
              tool.execute("revoked-spawn", { task: "Continue requested work" }),
            ).rejects.toThrow(/access changed|authority|role|aborted/i);
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
        status: caller === "guest" ? "cancelled" : "completed",
        executionStarted: true,
      });
      expect(spawn).toHaveBeenCalledTimes(2);
      expect(effects).toEqual(["spawned"]);
    });
  },
);
