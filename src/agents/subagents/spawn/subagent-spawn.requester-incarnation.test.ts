import "./subagent-spawn-model.mocks.shared.js";
// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { installSpawnAuthorityFixture } from "./subagent-spawn.authority.test-support.js";
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
import { getRuntimeConfig } from "../../../config/config.js";
import {
  loadSessionEntryReadOnly,
  replaceSessionEntrySync,
  upsertSessionEntryCore,
} from "../../../config/sessions/session-accessor.js";
import { LegacyContextEngine } from "../../../context-engine/legacy.js";
import { resolveMcpLoopbackScopedTools } from "../../../gateway/mcp-http.runtime.js";
import { recordSessionParticipantBestEffort } from "../../../sessions/session-participant-recording.js";
import { AsyncWorkScope } from "../../../shared/async-work-scope.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { resolveOpenClawAgentSqlitePath } from "../../../state/openclaw-agent-db.paths.js";
import { runOpenClawAgentWriteAdmission } from "../../../state/openclaw-agent-write-admission.js";
import { readAdmittedRunOperatorAuthority } from "../../admitted-run-context.js";
import { buildCliMcpGrantContext } from "../../cli-runner/mcp-grant-context.js";
import { maybeSpawnVisibleSession } from "../../tools/sessions-spawn-visible.js";
import { loadSubagentRegistryFromSqlite } from "../registry/subagent-registry-state.fixture.test-support.js";
import { spawnAcpDirect } from "./acp-spawn.js";
import { resolveSubagentChildPlan } from "./subagent-spawn-child-plan.js";
import { resolveSubagentSpawnRequest } from "./subagent-spawn-request.js";
import { spawnSubagentDirect } from "./subagent-spawn.js";
import { testing as spawnTesting } from "./subagent-spawn.test-support.js";

const fixture = installSpawnAuthorityFixture();
const { writeSession, configure } = fixture;
const backendId = "requester-incarnation-fixture";

function useInProcessSpawns(beforeDispatch?: (params: Record<string, unknown>) => void) {
  spawnTesting.setDepsForTest({
    hasInProcessGatewayContext: () => true,
    resolveContextEngine: async () => new LegacyContextEngine(),
    dispatchGatewayMethodInProcess: async <T>(method: string, params: Record<string, unknown>) => {
      if (method !== "agent") {
        throw new Error(`Unexpected spawn RPC ${method}`);
      }
      beforeDispatch?.(params);
      return { runId: params.idempotencyKey, status: "accepted" } as T;
    },
  });
}

it("preserves a nonowner CLI requester's credit through mediated spawn", async () => {
  const { cfg, admitted, admission, parent } = await fixture.createBoundParent();
  try {
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: fixture.parentSessionKey },
      { inheritedGitContributorProfileIds: ["unrelated-a", "unrelated-b"] },
    );
    const inspectChild = vi.fn(({ sessionKey }: Record<string, unknown>) => {
      if (typeof sessionKey !== "string") {
        throw new Error("Expected a child dispatch key");
      }
      const child = loadSessionEntryReadOnly({ agentId: "main", sessionKey });
      expect(child?.inheritedGitContributorProfileIds).toEqual(["verified-cli-requester"]);
      expect(child?.participants ?? []).toEqual([]);
      expect(child?.createdActor).toEqual({ type: "agent", id: "main" });
    });
    // Only model dispatch is external: grant projection, tool construction, and child writes are real.
    useInProcessSpawns(inspectChild);
    const context = buildCliMcpGrantContext({
      run: {
        sessionId: "parent-session",
        sessionKey: fixture.parentSessionKey,
        sessionFile: "unused-cli-transcript",
        workspaceDir: fixture.stateDir,
        provider: "fixture-cli",
        prompt: "Delegate this task",
        timeoutMs: 1_000,
        runId: fixture.parentRunId,
        senderIsOwner: false,
        gitContributorProfileId: "verified-cli-requester",
      },
      config: cfg,
      requireExplicitMessageTarget: false,
      agentId: "main",
      modelProvider: "openai",
      modelId: "gpt-5.4",
    });
    context.toolsAllow = ["sessions_spawn"];
    const { tools } = await resolveMcpLoopbackScopedTools({
      cfg,
      context,
      admittedRunContext: admitted,
    });
    const spawn = tools.find((tool) => tool.name === "sessions_spawn");
    if (!spawn) {
      throw new Error("Expected the mediated spawn tool");
    }
    const result = await spawn.execute("cli-spawn-credit", { task: "Implement the CLI request" });
    expect(result.details).toMatchObject({ status: "accepted" });
    expect(inspectChild).toHaveBeenCalledOnce();
    expect(readAdmittedRunOperatorAuthority(admitted)).toBeUndefined();
  } finally {
    admission.close();
    parent.cleanup();
  }
});

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
  await writeSession(fixture.parentSessionKey, "cancelled-requester");
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

it.each(["native", "acp", "missing requester", "visible"] as const)(
  "keeps the birth requester window through async %s launch",
  async (scenario) => {
    const backend = scenario === "missing requester" ? "native" : scenario;
    const globalRequester = backend === "visible";
    const originalSessionId = scenario === "missing requester" ? undefined : "original-requester";
    const requesterKey = globalRequester ? "global" : "agent:main:completion-owner";
    const controllerKey = globalRequester
      ? "agent:main:dashboard:controller"
      : fixture.parentSessionKey;
    const originalRevision = originalSessionId ? "original-requester-lifecycle" : undefined;
    const replacement = {
      sessionId: "replacement-requester",
      lifecycleRevision: "replacement-requester-lifecycle",
    };
    if (globalRequester || backend === "acp") {
      const cfg = getRuntimeConfig();
      await configure({
        ...cfg,
        ...(globalRequester
          ? {
              session: { ...cfg.session, scope: "global" },
              agents: {
                ...cfg.agents,
                ownership: "explicit",
                entries: { main: { subagents: { allowAgents: ["worker"] } }, worker: {} },
              },
            }
          : {
              acp: { enabled: true, backend: backendId, allowedAgents: ["main"] },
              agents: { ...cfg.agents, defaults: { ...cfg.agents?.defaults, model: undefined } },
            }),
      });
    }
    if (globalRequester) {
      await writeSession("global", "foreign-child-owner", "worker");
    }
    await writeSession(controllerKey, "controller-session");
    if (originalSessionId) {
      await writeSession(requesterKey, originalSessionId, "main", originalRevision);
    }
    if (backend === "acp") {
      managerTesting.resetAcpSessionManagerForTests();
      const runtime: AcpRuntime = {
        ownerAwareSessions: 1,
        async ensureSession({ sessionKey, agentId }) {
          return {
            sessionKey,
            agentId,
            backend: backendId,
            runtimeSessionName: sessionKey,
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
    useInProcessSpawns();
    const rotateRequester = vi.fn(() => {
      // Rotate after requester capture and before child creation; completion
      // must retain that captured window even when later launch steps await.
      replaceSessionEntrySync(
        { sessionKey: requesterKey, agentId: "main" },
        { ...replacement, updatedAt: Date.now() },
      );
    });
    const ctx = {
      agentSessionKey: controllerKey,
      completionOwnerKey: requesterKey,
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
                requestedAgentId: "worker",
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
                    const childSessionKey = "agent:worker:dashboard:window-child";
                    await writeSession(childSessionKey, "visible-child-session", "worker");
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
      await fixture.settle();
      const restored = loadSubagentRegistryFromSqlite().get(runId);
      expect(restored).toMatchObject({
        runId,
        requesterSessionKey: requesterKey,
        controllerSessionKey: controllerKey,
        expectsCompletionMessage: true,
      });
      expect(restored?.completionRequesterSessionId).toBe(originalSessionId);
      expect(restored?.completionRequesterLifecycleRevision).toBe(originalRevision);
      expect(loadSessionEntryReadOnly({ sessionKey: requesterKey, agentId: "main" })).toMatchObject(
        replacement,
      );
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
  // Dispatch sees initial child credit, before acceptance records its agent participant.
  const inspectChild = vi.fn(({ sessionKey: childKey }: Record<string, unknown>) => {
    if (typeof childKey !== "string") {
      throw new Error("Expected a child dispatch key");
    }
    const child = loadSessionEntryReadOnly({ agentId, sessionKey: childKey });
    expect(child?.inheritedGitContributorProfileIds).toEqual(["human-requester"]);
    expect(child?.participants ?? []).toEqual([]);
  });
  useInProcessSpawns(inspectChild);
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
        identity: { type: "profile", id: "human-requester" },
        promptedAt: 1,
        onError: (error) => errors.push(error),
      }),
    );
    // The real recorder defers its write to the next microtask. Keep that original order.
    await Promise.resolve();
    expect(loadSessionEntryReadOnly(scope)?.participants ?? []).toEqual([]);
    const creation = spawnSubagentDirect(
      { task: "inherit accepted credit", context: "isolated" },
      { agentSessionKey: sessionKey, gitContributorProfileId: "human-requester" },
    );
    releaseWriter.resolve();
    await heldWriter;
    const result = await creation;
    expect(result).toMatchObject({ status: "accepted" });
    expect(inspectChild).toHaveBeenCalledOnce();
    await work.drain();

    expect(errors).toEqual([]);
    expect(loadSessionEntryReadOnly(scope)?.participants).toEqual([
      { identity: { type: "profile", id: "human-requester" } },
    ]);
  } finally {
    releaseWriter.resolve();
    await heldWriter;
    await work.drain();
  }
});

it.each(["requester-c", undefined])(
  "scopes a shared-main native child's credit to the admitted request (%s)",
  async (gitContributorProfileId) => {
    const sessionKey = fixture.parentSessionKey;
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey },
      {
        sessionId: "parent-id",
        updatedAt: 1,
        inheritedGitContributorProfileIds: ["unrelated-a", "unrelated-b"],
      },
    );
    const inspected = vi.fn(({ sessionKey: childKey }: Record<string, unknown>) => {
      if (typeof childKey !== "string") {
        throw new Error("missing child key");
      }
      const child = loadSessionEntryReadOnly({ agentId: "main", sessionKey: childKey });
      expect(child?.inheritedGitContributorProfileIds).toEqual(
        gitContributorProfileId ? ["requester-c"] : undefined,
      );
      expect(child?.participants ?? []).toEqual([]);
    });
    useInProcessSpawns(inspected);
    const result = await spawnSubagentDirect(
      { task: "isolated Discord task", context: "isolated" },
      {
        agentSessionKey: sessionKey,
        agentChannel: "discord",
        agentTo: "channel:synthetic-thread",
        gitContributorProfileId,
      },
    );
    expect(result).toMatchObject({ status: "accepted" });
    expect(inspected).toHaveBeenCalledOnce();
  },
);
