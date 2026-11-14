import "./subagent-spawn-model.mocks.shared.js";
// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { installSpawnAuthorityFixture } from "./subagent-spawn.authority.test-support.js";
import path from "node:path";
import type { AcpRuntime } from "@openclaw/acp-core/runtime/types";
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, onTestFinished, vi } from "vitest";
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
import { CronService } from "../../../cron/service.js";
import { createNoopLogger } from "../../../cron/service.test-harness.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "../../../gateway/agent-runtime-approval-authority.js";
import { prepareChannelOperatorAuthority } from "../../../gateway/channel-operator-authority.js";
import { resolveMcpLoopbackScopedTools } from "../../../gateway/mcp-http.runtime.js";
import { captureChannelOperatorRunAuthority } from "../../../gateway/operator-run-authority.js";
import { createDirectChatContext } from "../../../gateway/server-chat.agent-events.test-helpers.js";
import { handleGatewayRequest } from "../../../gateway/server-methods.js";
import { resolveGatewayCronCreatorAuthorityAdmission } from "../../../gateway/server-methods/cron-creator-authority-admission.js";
import { cronHandlers } from "../../../gateway/server-methods/cron.js";
import type { RespondFn } from "../../../gateway/server-methods/types.js";
import { createSyntheticPluginRuntimeClient } from "../../../gateway/server-plugin-runtime-client.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
  validateAgentRunDelegatedAuthority,
} from "../../../infra/agent-run-registry.js";
import { recordSessionParticipantBestEffort } from "../../../sessions/session-participant-recording.js";
import { AsyncWorkScope } from "../../../shared/async-work-scope.js";
import { resolveOpenClawAgentSqlitePath } from "../../../state/openclaw-agent-db.paths.js";
import { runOpenClawAgentWriteAdmission } from "../../../state/openclaw-agent-write-admission.js";
import {
  linkUserChannelIdentity,
  unlinkUserChannelIdentity,
} from "../../../state/user-channel-identities.js";
import { publishCanonicalUserChannelPolicy } from "../../../state/user-channel-identity-operations.js";
import { setUserProfileRole } from "../../../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../../state/user-profiles.js";
import { createTestGatewayScheduler } from "../../../test-utils/gateway-scheduler-clock.js";
import {
  createAdmittedRunOperatorAuthority,
  createOperationalRunInstanceRef,
  readAdmittedRunOperatorAuthority,
} from "../../admitted-run-context.js";
import { resolveTurnToolSurface } from "../../agent-tools.turn-authority.js";
import { buildCliMcpGrantContext } from "../../cli-runner/mcp-grant-context.js";
import {
  createCronCreatorAuthorityCapability,
  runWithCronCreatorAuthorityCapability,
} from "../../cron-creator-authority-context.js";
import { createEnteredGate } from "../../entered-gate.test-support.js";
import { createCronTool } from "../../tools/cron-tool.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  getGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../../tools/gateway-caller-context.js";
import * as gatewayTools from "../../tools/gateway.js";
import { prepareSessionPortalToolAccess } from "../../tools/session-portal-target.js";
import { createSessionsSpawnTool } from "../../tools/sessions-spawn-tool.js";
import { maybeSpawnVisibleSession } from "../../tools/sessions-spawn-visible.js";
import { loadSubagentRegistryFromSqlite } from "../registry/subagent-registry-state.fixture.test-support.js";
import { releaseSubagentRun } from "../registry/subagent-registry.test-helpers.js";
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

function inspectChildCredit(profileIds: string[] | undefined, checkActor = false) {
  const inspect = vi.fn(({ sessionKey }: Record<string, unknown>) => {
    if (typeof sessionKey !== "string") {
      throw new Error("Expected a child dispatch key");
    }
    const child = loadSessionEntryReadOnly({ agentId: "main", sessionKey });
    expect(child?.inheritedGitContributorProfileIds).toEqual(profileIds);
    expect(child?.participants ?? []).toEqual([]);
    if (checkActor) {
      expect(child?.createdActor).toEqual({ type: "agent", id: "main" });
    }
  });
  useInProcessSpawns(inspect);
  return inspect;
}

it("preserves a nonowner CLI requester's credit through mediated spawn", async () => {
  const { cfg, admitted, admission, parent } = await fixture.createBoundParent();
  try {
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: fixture.parentSessionKey },
      { inheritedGitContributorProfileIds: ["unrelated-a", "unrelated-b"] },
    );
    // Only model dispatch is external: grant projection, tool construction, and child writes are real.
    const inspectChild = inspectChildCredit(["verified-cli-requester"], true);
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
  const inspectChild = inspectChildCredit(["human-requester"]);
  const storePath = resolveOpenClawAgentSqlitePath({ agentId });
  const scope = { agentId, sessionKey, storePath };
  await upsertSessionEntryCore(scope, { sessionId: "parent-id", updatedAt: 1 });
  const writerGate = createEnteredGate();
  const heldWriter = runOpenClawAgentWriteAdmission({ agentId, path: storePath }, writerGate.wait);
  await writerGate.entered;
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
    writerGate.release();
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
    writerGate.release();
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
    const inspected = inspectChildCredit(gitContributorProfileId ? ["requester-c"] : undefined);
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

it.each(["cancel", "profile-revocation"] as const)(
  "spawns a child that adds the original human reminder after its parent ends (%s)",
  async (revocation) => {
    vi.stubEnv("OPENAI_API_KEY", "synthetic-reminder-fixture-key");
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });
    await configure({
      ...getRuntimeConfig(),
      gateway: {
        roles: {
          default: "member",
          definitions: {
            member: { scopes: ["operator.write"], agents: "*", sessions: { others: "view" } },
          },
        },
      },
    });
    const { cfg, admitted, admission, parent } = await fixture.createBoundParent();
    await publishCanonicalUserChannelPolicy(cfg.gateway);
    const profile = ensureProfileForEmail("reminder-fixture@example.test");
    setUserProfileRole(profile.id, "member");
    const channelIdentity = { channelId: "telegram", accountId: "default", senderId: "human-a" };
    linkUserChannelIdentity(profile.id, channelIdentity);
    const preparedOperator = expectDefined(
      await prepareChannelOperatorAuthority(cfg, channelIdentity),
      "linked Telegram operator",
    );
    expect(preparedOperator.profileId).toBe(profile.id);
    expect(preparedOperator.operatorProfile.scopes).toContain("operator.write");
    expect(preparedOperator.operatorProfile.scopes).not.toContain("operator.admin");
    const linkedOperator = captureChannelOperatorRunAuthority({
      ...preparedOperator.operatorProfile,
      recoveryReference: preparedOperator.recoveryReference,
      getRuntimeConfig: () => cfg,
      signal: preparedOperator.signal,
      assertCurrent: () => {
        if (!preparedOperator.isCurrent(cfg)) {
          throw new Error("linked Telegram profile revoked");
        }
      },
    });
    const sessionKey = fixture.parentSessionKey;
    const parentRunId = fixture.parentRunId;
    const requesterOrigin = { sessionKey, delegatedCreatorProfileId: profile.id };
    const origin = {
      profileId: profile.id,
      agentId: "main",
      sessionKey,
      sessionId: "parent-session",
      accountId: "default",
      to: "group-1",
      threadId: "topic-1",
    };
    const cancellation = new AbortController();
    let holds = 0;
    const operator = createAdmittedRunOperatorAuthority({
      ...linkedOperator,
      retain: () => {
        const release = expectDefined(linkedOperator.retain, "operator retain")();
        holds++;
        return () => {
          release();
          holds--;
        };
      },
    });
    const parentScope = expectDefined(
      createCronCreatorAuthorityCapability(
        parentRunId,
        { kind: "external", channel: "telegram" },
        undefined,
        () => true,
        undefined,
        undefined,
        true,
        origin,
      ),
      "parent reminder scope",
    );
    const accepted: {
      value?: NonNullable<ReturnType<typeof resolveGatewayCronCreatorAuthorityAdmission>>;
    } = {};
    spawnTesting.setDepsForTest({
      hasInProcessGatewayContext: () => true,
      resolveContextEngine: async () => new LegacyContextEngine(),
      dispatchGatewayMethodInProcess: async <T>(
        method: string,
        params: Record<string, unknown>,
        options?: Parameters<
          typeof import("../../../gateway/server-plugins.js").dispatchGatewayMethodInProcess
        >[2],
      ) => {
        expect(method).toBe("agent");
        expect(params.lane).toBe("subagent");
        expect(options?.agentRunTracking).toBe("native_subagent");
        const runId = String(params.idempotencyKey);
        const client = createSyntheticPluginRuntimeClient({
          scopes: ["operator.write"],
          agentRunTracking: options?.agentRunTracking,
          agentToolCaller: expectDefined(options?.agentToolCaller, "spawn caller"),
        });
        accepted.value = resolveGatewayCronCreatorAuthorityAdmission({
          runId,
          resolvedSessionKey: String(params.sessionKey),
          spawnedBy: sessionKey,
          client,
          request: {
            message: String(params.message),
            idempotencyKey: runId,
            lane: params.lane as "subagent",
          },
          hasRestoredCronContinuation: false,
          isOneShotModelRun: false,
        });
        expect(accepted.value?.personalReminder).toEqual(origin);
        return { runId, status: "accepted" } as T;
      },
    });
    const scheduler = createTestGatewayScheduler();
    const cron = new CronService({
      scheduler,
      nowMs: () => Date.now(),
      storePath: path.join(fixture.stateDir, "cron", "jobs.json"),
      cronEnabled: false,
      defaultAgentId: "main",
      log: createNoopLogger(),
      enqueueSystemEvent: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });
    const cronContext = createDirectChatContext({
      cron,
      getRuntimeConfig: () => cfg,
      validateAgentRuntimeApprovalAuthority: createAgentRuntimeApprovalAuthorityValidator(),
    });
    let childAuthority: ReturnType<typeof claimAgentRunDelegatedAuthority> | undefined;
    try {
      await cron.start();
      const spawned = await runWithCronCreatorAuthorityCapability(
        parentScope,
        () =>
          withGatewayToolCallerIdentity(
            {
              ...expectDefined(
                createAdmittedGatewayToolCallerIdentity({
                  agentId: "main",
                  sessionKey,
                  admittedRunContext: admitted,
                  requesterOrigin,
                }),
                "admitted parent tool caller",
              ),
              operatorAuthority: operator,
            },
            async () => {
              const spawn = createSessionsSpawnTool({
                config: cfg,
                agentSessionKey: sessionKey,
                requesterTurnRunId: parentRunId,
                expectedParentSessionId: "parent-session",
              });
              return await spawn.execute("spawn-personal-reminder", { task: "Create a reminder" });
            },
          ),
        cancellation.signal,
      );
      if ((spawned.details as { status?: string }).status !== "accepted") {
        throw new Error(`Spawn was not accepted: ${JSON.stringify(spawned.details)}`);
      }
      const child = expectDefined(accepted.value, "accepted child authority");
      admission.close();
      parent.cleanup();
      expect(child.isCurrent?.()).toBe(true);
      const childInstance = createOperationalRunInstanceRef(child.runId);
      childAuthority = claimAgentRunDelegatedAuthority(childInstance);
      const childScope = expectDefined(
        createCronCreatorAuthorityCapability(
          child.runId,
          child.callerOrigin,
          undefined,
          child.isCurrent,
          undefined,
          undefined,
          child.callerScopedCreation,
          child.personalReminder,
        ),
        "child reminder scope",
      );
      const childSessionKey = (spawned.details as { childSessionKey: string }).childSessionKey;
      expect(
        loadSessionEntryReadOnly({ agentId: "main", sessionKey: childSessionKey }),
      ).toMatchObject({ personalReminderSurface: true });
      const identity = {
        kind: "agentRuntime" as const,
        agentId: "main",
        sessionKey: childSessionKey,
        operationalRunInstance: childInstance,
        delegatedAuthority: { kind: "local" as const, ...childAuthority },
      };
      const gateway = vi
        .spyOn(gatewayTools, "callGatewayTool")
        .mockImplementation(async (method, _options, params) => {
          const client = createSyntheticPluginRuntimeClient({ scopes: ["operator.write"] });
          client.internal = {
            ...client.internal,
            agentRuntimeIdentity: {
              ...identity,
              ...getGatewayToolCallerIdentity(),
            },
          };
          const respond = vi.fn<RespondFn>();
          await handleGatewayRequest({
            req: { type: "req", id: "personal-child", method, params },
            context: cronContext,
            client,
            respond,
            isWebchatConnect: () => false,
            extraHandlers: cronHandlers,
          });
          const response = expectDefined(respond.mock.calls[0], "cron response");
          if (!response[0]) {
            throw new Error(response[2]?.message ?? "automation rejected");
          }
          return response[1] as never;
        });
      try {
        await runWithCronCreatorAuthorityCapability(childScope, () =>
          withGatewayToolCallerIdentity(
            {
              ...identity,
              approvalAuthority: childAuthority,
              receiptAuthority: () => validateAgentRunDelegatedAuthority(childAuthority!),
              requesterOrigin,
            },
            async () => {
              const portal = prepareSessionPortalToolAccess({
                sessionKey: childSessionKey,
                agentId: "main",
                senderIsOwner: false,
                sandboxed: false,
                runId: child.runId,
              });
              const automation = createCronTool({
                config: cfg,
                runId: child.runId,
                agentSessionKey: childSessionKey,
              });
              const surface = resolveTurnToolSurface({
                turnTools: [automation],
                ownerOnlyDenied: new Set(portal.ownerOnlyCoreToolDenylist),
              });
              const add = () =>
                surface.tools[0]!.execute("personal-add", {
                  action: "add",
                  job: {
                    name: "human reminder",
                    enabled: false,
                    schedule: { kind: "at", at: "2030-01-01T00:00:00.000Z" },
                    payload: { kind: "agentTurn", message: "Reminder" },
                  },
                });
              const result = await add();
              expect(result.details).not.toMatchObject({ gated: true });
              expect(await cron.list({ includeDisabled: true })).toEqual(
                expect.arrayContaining([
                  expect.objectContaining({
                    ownerProfileId: profile.id,
                    createdActor: { type: "human", source: "profile", id: profile.id },
                  }),
                ]),
              );
              if (revocation === "cancel") {
                cancellation.abort();
              } else {
                expect(unlinkUserChannelIdentity(profile.id, channelIdentity)).toBe(true);
              }
              await expect(add()).rejects.toThrow();
            },
          ),
        );
      } finally {
        gateway.mockRestore();
        child.release?.();
        await releaseSubagentRun(child.runId);
      }
    } finally {
      accepted.value?.release?.();
      admission.close();
      parent.cleanup();
      if (childAuthority) {
        releaseAgentRunDelegatedAuthority(childAuthority);
      }
      cron.stop();
      await scheduler.stop();
      expect(holds).toBe(0);
    }
  },
);
