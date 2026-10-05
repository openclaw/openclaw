import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import {
  parseWorkerGitHubLaunchBinding,
  prepareWorkerGitHubBindingGrant,
  writeManagedGitHubProfileFiles,
} from "openclaw/plugin-sdk/github-worker-runtime";
import { afterEach, expect, it, vi, onTestFinished } from "vitest";
import * as attemptExecution from "../../agents/command/attempt-execution.runtime.js";
import { makeAttemptResult } from "../../agents/embedded-agent-runner/run.overflow-compaction.fixture.js";
import { getRegisteredAgentHarness } from "../../agents/harness/registry.js";
import type { AgentHarnessV2 } from "../../agents/harness/types.js";
import { createOriginalIssuerFixture } from "../../agents/main-session-recovery/main-session-recovery-original-issuer.test-support.js";
import { commitMainSessionRecovery } from "../../agents/main-session-recovery/main-session-recovery-store.js";
import { mainSessionRecoveryLog } from "../../agents/main-session-recovery/main-session-restart-recovery-shared.js";
import { refreshPreparedModelRuntimeSnapshots } from "../../agents/prepared-model-runtime.js";
import { makeAgentAssistantMessage } from "../../agents/test-helpers/agent-message-fixtures.js";
import {
  withGatewayToolCallerIdentity,
  getGatewayToolCallerIdentity,
} from "../../agents/tools/gateway-caller-context.js";
import { createCreateGoalTool } from "../../agents/tools/goal-tools.js";
import { clearRuntimeConfigSnapshot } from "../../config/io.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { resetLogger, setLoggerOverride } from "../../logging/logger.js";
import { createDiagnosticLogRecordCapture } from "../../logging/test-helpers/diagnostic-log-capture.js";
import { getActivePluginRegistry } from "../../plugins/runtime.js";
import { getPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { closeSkillsWatchers } from "../../skills/runtime/refresh.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { handleGatewayRequest } from "../server-methods.js";
import { loadSessionEntry as loadGatewayEntry } from "../session-utils.js";
import { prepareGoalRecoveryNativeFixture } from "./session-goal-recovery-native.test-support.js";
import { exerciseNativeStartup } from "./session-recovery-startup.test-support.js";

const nativeAttempt = vi.hoisted(() => vi.fn<AgentHarnessV2["runAttempt"]>());
afterEach(() => closeSkillsWatchers(true));
// mock-isolation: Replace only model execution; importing the real attempt installs the process-global Codex client disposer.
vi.mock("../../../extensions/codex/src/app-server/run-attempt.js", () => ({
  runCodexAppServerAttempt: nativeAttempt,
}));

it.each(["current", "revoked"] as const)(
  "automatically continues an accepted no-goal turn through startup with %s original authority",
  (mode) => exerciseNativeStartup(nativeAttempt, mode),
);

it.each(["goal", "turn"] as const)(
  "carries restored original %s authority through the SDK grant and exact managed worker workspace",
  (intent) =>
    exerciseNativeStartup(
      nativeAttempt,
      "current",
      intent,
      "failed-cleanup",
      undefined,
      false,
      async (input) => {
        const authority = expectDefined(
          getGatewayToolCallerIdentity()?.operatorAuthority ??
            getPluginRuntimeGatewayRequestScope()?.client?.internal?.operatorRunAuthority,
          "current original SDK issuer",
        );
        authority.assertCurrent();
        const grant = expectDefined(
          await prepareWorkerGitHubBindingGrant({
            ...input.workspace,
            agentId: input.agentId,
            operatorAuthority: authority,
            assertCurrent: () => {
              input.assertCurrent();
              return true;
            },
          }),
          "original issuer SDK launch grant",
        );
        const profile = path.join(input.workspace.workspaceDir, ".sdk-github");
        let acquired: Awaited<ReturnType<typeof input.acquireManagedWorkspaceAsync>> | undefined;
        try {
          const assertGrantCurrent = expectDefined(grant.assertCurrent, "current SDK grant guard");
          const assertCurrent = () => {
            input.assertCurrent();
            assertGrantCurrent();
          };
          acquired = await input.acquireManagedWorkspaceAsync(input.workspace);
          assertCurrent();
          const binding = expectDefined(
            parseWorkerGitHubLaunchBinding(grant.binding),
            "canonical node launch binding",
          );
          expect(binding).toMatchObject({
            login: "fixture-original-issuer",
            host: "microsoft.ghe.com",
          });
          await writeManagedGitHubProfileFiles(profile, binding, {
            assertCurrent,
          });
          assertCurrent();
          expect((await fs.stat(path.join(profile, "hosts.yml"))).mode & 0o077).toBe(0);
          await expect(
            input.acquireManagedWorkspaceAsync({
              ...input.workspace,
              sessionId: "different-session",
            }),
          ).rejects.toThrow("does not own");
          await expect(
            input.acquireManagedWorkspaceAsync({
              ...input.workspace,
              ownerEpoch: input.workspace.ownerEpoch + 1,
            }),
          ).rejects.toThrow("does not own");
          const result = await input.runWorkspaceCommand({
            transportRetry: "never",
            argv: [
              "node",
              "-e",
              "process.stdout.write(require('node:fs').readFileSync('accepted.txt', 'utf8'))",
            ],
            timeoutMs: 10_000,
            assertCurrent,
          });
          assertCurrent();
          return result;
        } finally {
          acquired?.release();
          await grant.revoke();
          await fs.rm(profile, { recursive: true, force: true });
        }
      },
    ),
);

it.each(["current", "revoked-after-disposal"] as const)(
  "automatically disposes failed owned compute before recovering the accepted no-goal turn with %s authority",
  (mode) => exerciseNativeStartup(nativeAttempt, mode, "turn", "failed-cleanup"),
);

it.each(["current", "revoked"] as const)(
  "automatically continues an originally active Goal through startup with %s original authority",
  (mode) => exerciseNativeStartup(nativeAttempt, mode, "goal"),
);

it.each(["current", "revoked-after-disposal"] as const)(
  "automatically recovers an active Goal from its FAILED owned source with %s original authority",
  (mode) => exerciseNativeStartup(nativeAttempt, mode, "goal", "failed"),
);

it.each(["warm", "miss", "unknown-claim", "target-replaced"] as const)(
  "continues startup through canonical prepared-worker %s selection with original native authority",
  (scenario) => exerciseNativeStartup(nativeAttempt, "current", "goal", "reclaimed", scenario),
);

it("denies a warm startup native effect after current original role revocation", () =>
  exerciseNativeStartup(nativeAttempt, "revoked", "goal", "reclaimed", "warm"));

it.each(["current", "revoked-after-read"] as const)(
  "fences a delayed original native result through fresh startup with %s authority",
  (mode) => exerciseNativeStartup(nativeAttempt, mode, "goal", "reclaimed", "warm", true),
);

it("acknowledges the reviewed hold atomically with the selected Goal and launches once as its authenticated issuer", async () => {
  vi.stubEnv("FACTORY_AUTH_MODE", "github");
  let starts = 0;
  let attempts = 0;
  let stage = "fixture";
  const diagnosticLogs = createDiagnosticLogRecordCapture();
  onTestFinished(() => {
    diagnosticLogs.cleanup();
    setLoggerOverride(null);
    resetLogger();
  });
  const recoveryWarnings = vi.spyOn(mainSessionRecoveryLog, "warn");
  let native: Awaited<ReturnType<typeof prepareGoalRecoveryNativeFixture>> | undefined;
  let expectedProfileId = "";
  const executionFacts: Array<{ registryMatch: boolean; harnessMatch: boolean }> = [];
  const runAgentAttempt = attemptExecution.runAgentAttempt;
  vi.spyOn(attemptExecution, "runAgentAttempt").mockImplementation((params) => {
    const registry = params.pluginGeneration?.pluginRegistry;
    executionFacts.push({
      registryMatch: registry === getActivePluginRegistry(),
      harnessMatch:
        registry?.agentHarnesses.find((entry) => entry.harness.id === "codex")?.harness
          .runAttempt === native?.harnessAttempts,
    });
    return runAgentAttempt(params);
  });
  onTestFinished(() => {
    console.info(
      "[goal-recovery-fixture]",
      JSON.stringify({
        stage,
        starts,
        nativeCalls: attempts,
        transport: native?.transportCounts(),
        redispatches: native?.redispatches(),
        warnings: recoveryWarnings.mock.calls.map(([message]) => message),
      }),
    );
  });
  nativeAttempt.mockImplementation(async (params) => {
    attempts += 1;
    stage = "native-attempt";
    const scope = expectDefined(
      getPluginRuntimeGatewayRequestScope(),
      "real native placement scope",
    );
    const authority = expectDefined(
      getGatewayToolCallerIdentity()?.operatorAuthority ??
        scope.client?.internal?.operatorRunAuthority,
      "original actor at native effect admission",
    );
    expect(authority.profileId).toBe(expectedProfileId);
    expect(authority?.scopes).toEqual(["operator.read", "operator.write"]);
    expect(authority?.scopes).not.toContain("operator.admin");
    authority!.assertCurrent();
    expect(params.runId).toBe("informed-operation");
    expect(params.sessionId).toBe("informed-session");
    expect(params.agentHarnessId).toBe("codex");
    const placement = expectDefined(
      native?.placements.get(params.sessionId),
      "actual remote-exec claim",
    );
    expect(placement).toMatchObject({
      state: "active",
      executionMode: "remote-exec",
      turnClaim: { owner: "local", runId: params.runId },
    });
    const assertNativeCurrent = expectDefined(
      scope.assertNodeExecutionCurrent,
      "canonical native node effect guard",
    );
    const workspace = {
      workspaceDir: native!.remoteWorkspaceDir,
      environmentId: native!.environment.environmentId,
      ownerEpoch: native!.environment.ownerEpoch,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey!,
    };
    assertNativeCurrent({
      runId: params.runId,
      agentId: "main",
      nodeId: native!.environment.nodeDeviceId!,
      workspace,
    });
    expect(() =>
      assertNativeCurrent({
        runId: params.runId,
        agentId: "main",
        nodeId: "other-node",
        workspace,
      }),
    ).toThrow();
    const current = loadSessionEntry({ agentId: "main", sessionKey: params.sessionKey! })!;
    expect(current.goal?.status).toBe("active");
    expect(current.mainRestartRecovery?.pause).toBeUndefined();
    expect(current.mainRestartRecovery?.goalIntent?.issuer.profileId).toBe(authority!.profileId);
    starts += 1;
    await params.onAgentEvent?.({ stream: "lifecycle", data: { phase: "start" } });
    return makeAttemptResult({
      terminal: { kind: "ok" },
      sessionIdUsed: params.sessionId,
      agentHarnessId: "codex",
      assistantTexts: ["Reviewed native continuation completed"],
      lastAssistant: makeAgentAssistantMessage({
        content: [{ type: "text", text: "Reviewed native continuation completed" }],
        timestamp: Date.now(),
      }),
    });
  });
  try {
    await withOpenClawTestState({ label: "informed-goal-resume" }, async (state) => {
      setLoggerOverride({
        level: "warn",
        consoleLevel: "silent",
        file: state.statePath("native-denial.log"),
      });
      vi.stubEnv("GH_CONFIG_DIR", state.statePath("gh"));
      for (const key of [
        "GH_TOKEN",
        "GH_ENTERPRISE_TOKEN",
        "GITHUB_TOKEN",
        "GITHUB_ENTERPRISE_TOKEN",
      ]) {
        vi.stubEnv(key, undefined);
      }
      const fixture = await createOriginalIssuerFixture(state, 0, "current grant", true);
      expectedProfileId = fixture.profile.id;
      const { client, context, cfg, original, work, runtime, deviceSource } = fixture;
      context.isConnectionActive = (connectionId) => connectionId === client.connId;
      const target = { agentId: "main", sessionKey: "agent:main:informed-goal" };
      const sessionId = "informed-session";
      native = await prepareGoalRecoveryNativeFixture(
        fixture,
        target,
        sessionId,
        state.workspaceDir,
      );
      const internal = expectDefined(client.internal, "original authenticated connection metadata");
      internal.operatorRunAuthority = original!.authority;
      await replaceSessionEntry(target, {
        sessionId,
        updatedAt: Date.now(),
        lifecycleRevision: "informed-lifecycle",
        agentHarnessId: "codex",
        repositoryWorkspaceId: native.repository.workspaceId,
        status: "interrupted",
        abortedLastRun: true,
        totalTokens: 100,
        createdActor: { type: "human", source: "profile", id: fixture.profile.id },
      });
      const tool = createCreateGoalTool({
        agentSessionKey: target.sessionKey,
        sessionAgentId: "main",
        config: cfg,
      });
      await withGatewayToolCallerIdentity(
        {
          ...target,
          operatorAuthority: original!.authority,
          gatewayContextResolver: () => context,
        },
        () =>
          tool.execute!("goal-create", { objective: "Complete accepted work", token_budget: 500 }),
      );
      const created = loadSessionEntry(target)!;
      const storePath = loadGatewayEntry(target.sessionKey, { agentId: "main" }).storePath;
      await commitMainSessionRecovery({
        target: { ...target, storePath },
        requireWriteSuccess: true,
        command: {
          kind: "pause",
          now: Date.now(),
          observation: {
            sessionId,
            cycleId: created.mainRestartRecovery!.cycleId,
            revision: created.mainRestartRecovery!.revision,
          },
          effect: {
            reason: "unverifiable-external-effect",
            toolName: "bash",
            toolCallId: "uncertain-call",
          },
        },
      });
      await refreshPreparedModelRuntimeSnapshots(cfg, {
        gatewayLifecycle: true,
        catalogMode: "static",
      });
      const source = loadSessionEntry(target)!;
      const request = {
        ...target,
        sessionId,
        goalId: source.goal!.id,
        action: "resume",
        operationId: "informed-operation",
        issuedAtMs: Date.now(),
      };
      const invoke = async (params: unknown) => {
        const respond = vi.fn();
        await handleGatewayRequest({
          req: { type: "req", id: "goal-resume", method: "sessions.goal.update", params },
          respond,
          context,
          client,
          isWebchatConnect: () => true,
          hasCurrentClientAuthority: deviceSource.isCurrent,
        });
        return respond;
      };
      try {
        const refusal = await invoke(request);
        expect(refusal).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({
            code: "INVALID_REQUEST",
            details: expect.objectContaining({ code: "GOAL_RECOVERY_DECISION_REQUIRED" }),
          }),
        );
        expect(loadSessionEntry(target)?.mainRestartRecovery?.pause).toBeDefined();
        expect(starts).toBe(0);
        const reference = {
          cycleId: source.mainRestartRecovery!.cycleId,
          revision: source.mainRestartRecovery!.revision,
          pausedAtMs: source.mainRestartRecovery!.pause!.pausedAtMs,
        };
        const changed = await invoke({
          ...request,
          operationId: "changed-ref",
          recoveryDecision: { ...reference, revision: reference.revision + 1 },
        });
        expect(changed).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({ code: "INVALID_REQUEST" }),
        );
        expect(starts).toBe(0);
        const confirmed = { ...request, recoveryDecision: reference };
        internal.syntheticClient = true;
        const synthetic = await invoke({ ...confirmed, operationId: "synthetic-decision" });
        expect(synthetic).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({ code: "INVALID_REQUEST" }),
        );
        expect(starts).toBe(0);
        expect(loadSessionEntry(target)?.mainRestartRecovery?.pause).toBeDefined();
        delete internal.syntheticClient;
        for (const capture of [
          undefined,
          {
            ...source.mainRestartRecovery!.goalIntent!,
            issuer: {
              ...source.mainRestartRecovery!.goalIntent!.issuer,
              factoryActor: { host: "microsoft.ghe.com" as const, accountId: 700101 },
            },
          },
        ]) {
          await replaceSessionEntry(target, {
            ...source,
            mainRestartRecovery: { ...source.mainRestartRecovery!, goalIntent: capture },
          });
          const missingOrForged = await invoke({
            ...confirmed,
            operationId: capture ? "forged-issuer" : "missing-issuer",
          });
          expect(missingOrForged).toHaveBeenCalledWith(
            false,
            undefined,
            expect.objectContaining({ code: "INVALID_REQUEST" }),
          );
          expect(starts).toBe(0);
          expect(native.redispatches()).toBe(0);
          expect(loadSessionEntry(target)?.mainRestartRecovery?.pause).toBeDefined();
        }
        await replaceSessionEntry(target, source);
        stage = "reviewed-admission";
        const response = await invoke(confirmed);
        stage = "response";
        expect(
          response,
          JSON.stringify({
            warnings: recoveryWarnings.mock.calls.map(([message]) => message),
            lastError: loadSessionEntry(target)?.lastRunError,
          }),
        ).toHaveBeenCalledWith(
          true,
          expect.objectContaining({
            goalId: request.goalId,
            sessionId,
            operationId: request.operationId,
            status: "started",
          }),
          undefined,
          expect.anything(),
        );
        await work.runWhenIdle(() => {});
        stage = "joined";
        const runOutcome = await runtime.recovery.waitForAgent({
          runId: request.operationId,
          timeoutMs: 0,
        });
        await diagnosticLogs.flush();
        expect(
          starts,
          JSON.stringify({
            attempts,
            executionFacts,
            grantDenials: diagnosticLogs.records
              .filter((record) => record.message.includes("worker_github_operator_unavailable"))
              .map((record) => record.attributes),
            harnessAttempts: native.harnessAttempts.mock.calls.length,
            sameHarness:
              getRegisteredAgentHarness("codex")?.harness.runAttempt === native.harnessAttempts,
            sameRegistry: getActivePluginRegistry() === fixture.registry,
            runOutcome,
            lastError: loadSessionEntry(target)?.lastRunError,
            lifecycle: loadSessionEntry(target)?.status,
          }),
        ).toBe(1);
        expect(native.redispatches()).toBe(1);
        expect(native.harnessAttempts).toHaveBeenCalledTimes(1);
        expect(native.repositoryProof.proofs.size).toBeGreaterThan(0);
        expect(native.repositoryProof.fetchFixture).toHaveBeenCalled();
        expect(loadSessionEntry(target)?.goal?.id).toBe(request.goalId);
        const replay = await invoke(confirmed);
        expect(replay).toHaveBeenCalledWith(
          true,
          expect.objectContaining({ replayed: true, goalId: request.goalId }),
          undefined,
          expect.anything(),
        );
        await work.runWhenIdle(() => {});
        expect(starts).toBe(1);
      } finally {
        original!.release();
        deviceSource.release();
        runtime.close();
        await work.drain();
        await native.close();
      }
    });
  } finally {
    nativeAttempt.mockReset();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    clearRuntimeConfigSnapshot();
    vi.unstubAllEnvs();
  }
});
