import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOpenClawCodingToolsAsync } from "../../agents/agent-tools.js";
import { persistAuthProfileBatch } from "../../agents/auth-profiles/upsert-with-lock.js";
import { withPreparedEmbeddedGatewayTools } from "../../agents/embedded-agent-runner/run/attempt-gateway-tools.js";
import { applyEmbeddedAttemptToolsAllow } from "../../agents/embedded-agent-runner/run/attempt-tool-construction-plan.js";
import type { RunEmbeddedAgentParams } from "../../agents/embedded-agent-runner/run/params.js";
import { createEmbeddedAgentRunnerOpenAiConfig } from "../../agents/test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { AUTOMATIONS_TOOL_NAME } from "../../agents/tools/automations-tool-name.js";
import {
  captureFinalEffectiveCronCreatorToolAllowlist,
  type CronCreatorToolAllowlistEntry,
  type CronToolsAllowCaptureRef,
} from "../../agents/tools/cron-tool.js";
import {
  getGatewayToolCallerIdentity,
  resolveGatewayToolOperatorSelection,
} from "../../agents/tools/gateway-caller-context.js";
import { setRuntimeConfigSnapshot } from "../../config/config.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { captureGatewayOperatorRunAuthority } from "../../gateway/operator-run-authority.js";
import { createOperatorRecoveryFixture } from "../../gateway/operator-run-recovery.test-support.js";
import { createScheduledGatewayRunner } from "../../gateway/scheduled-run-gateway-context.js";
import {
  admission,
  cfg,
  cron as creatorCron,
  createCronFixture,
  inRun,
  installRequesterCronAuthorityTestHooks,
  SESSION,
  SESSION_ID,
  stateDir,
} from "../../gateway/server-methods/requester-cron-authority.test-support.js";
import {
  bindGatewayContextResolver,
  clearGatewayContextResolver,
  withPluginRuntimeGatewayRequestScope,
} from "../../plugins/runtime/gateway-request-scope.js";
import { getPluginToolMeta } from "../../plugins/tool-metadata.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { setCanonicalUserProfileRole } from "../../state/user-profile-writes.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../../test-utils/gateway-scheduler-clock.js";
import { createCronServiceWithStateForTest, createNoopLogger } from "../service.test-harness.js";
import { onTimer } from "../service/timer.test-support.js";
import { resolveCronSessionTargetSessionKey } from "../session-target.js";
import {
  ensureAgentWorkspaceMock,
  loadRunCronIsolatedAgentTurn,
  loadSessionEntryMock,
  mockRunCronFallbackPassthrough,
  patchSessionEntryMock,
  resetRunCronIsolatedAgentTurnHarness,
  resolveConfiguredModelRefMock,
  resolveCronDeliveryPlanMock,
  resolveCronSessionMock,
  runEmbeddedAgentMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();
const { resolveAgentDir } = await import("./run.runtime.js");
const session = await vi.importActual<typeof import("./session.js")>("./session.js");
const accessor = await vi.importActual<
  typeof import("../../config/sessions/session-accessor.sqlite-entry.js")
>("../../config/sessions/session-accessor.sqlite-entry.js");
installRequesterCronAuthorityTestHooks();

beforeEach(() => {
  resetRunCronIsolatedAgentTurnHarness();
  vi.stubEnv("OPENCLAW_TEST_FAST", "1");
  resolveCronSessionMock.mockImplementation(session.prepareCronSession);
  loadSessionEntryMock.mockImplementation(session.loadCronSessionEntryLatest);
  patchSessionEntryMock.mockImplementation(accessor.patchSessionEntryCore);
  ensureAgentWorkspaceMock.mockImplementation(async ({ dir }: { dir: string }) => ({ dir }));
  resolveCronDeliveryPlanMock.mockReturnValue({ requested: false, mode: "none" });
  mockRunCronFallbackPassthrough();
});
afterEach(() => {
  runEmbeddedAgentMock.mockReset();
  vi.restoreAllMocks();
});

// Existing recovery and manual-run tests miss this scheduled custody transfer:
// authenticated creation, durable reload, a timer without a human request, normal
// admission, and the Gateway tool caller authority every operator-gated tool reads.
// Release adaptation: the main-branch regression observes GitHub inspect/merge, which
// this release line does not ship; the restored operator source is the same owner.
describe("same-conversation scheduled operator continuation", () => {
  it.each([
    "operator",
    "paused force run",
    "guest",
    "legacy attribution",
    "foreign target",
    "current tool deny",
    "role revoked",
    "role revoked during run",
    "session replaced",
  ] as const)("preserves the %s boundary", async (scenario) => {
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    const config: OpenClawConfig = {
      ...cfg,
      models: createEmbeddedAgentRunnerOpenAiConfig(["gpt-4.1"]).models,
      agents: {
        defaults: { skipBootstrap: true, workspace: stateDir, model: "openai/gpt-4.1" },
        entries: { main: { agentDir, workspace: stateDir } },
      },
      auth: {
        profiles: { "openai:continuation": { provider: "openai", mode: "api_key" } },
        order: { openai: ["openai:continuation"] },
      },
      tools: { allow: [AUTOMATIONS_TOOL_NAME, "sessions_list"] },
    };
    setRuntimeConfigSnapshot(config);
    vi.mocked(resolveAgentDir).mockReturnValue(agentDir);
    resolveConfiguredModelRefMock.mockReturnValue({ provider: "openai", model: "gpt-4.1" });
    await persistAuthProfileBatch({
      stateDir,
      profiles: [
        {
          profileId: "openai:continuation",
          credential: { type: "api_key", provider: "openai", key: "synthetic-model-key" },
        },
      ],
    });
    const fixture = createCronFixture(undefined, config);
    const { context } = fixture;
    context.resolveGatewayContext = () => context;
    const profile = ensureProfileForEmail("scheduled-operator@example.test");
    const recovery = await createOperatorRecoveryFixture({
      stateDir,
      context,
      config,
      profileId: profile.id,
      sessionKey: SESSION,
      sessionId: SESSION_ID,
      scopes: scenario === "guest" ? ["operator.sessions.write"] : ["operator.admin"],
    });
    // Capture fresh authenticated admission, not the released recovery fixture authority.
    // The legacy row has identical human attribution but no operator admission.
    const original =
      scenario === "legacy attribution"
        ? undefined
        : expectDefined(
            await captureGatewayOperatorRunAuthority({
              client: recovery.client,
              context,
              sourceAuthority: null,
            }),
            "authenticated creator source",
          );
    const foreignKey = "agent:main:dashboard:foreign-continuation";
    if (scenario === "foreign target") {
      replaceSessionEntrySync(
        { sessionKey: foreignKey },
        {
          sessionId: "foreign-session",
          lifecycleRevision: "foreign",
          updatedAt: Date.now(),
          createdActor: { type: "human", source: "profile", id: "foreign-profile" },
        },
      );
    }
    const targetKey = scenario === "foreign target" ? foreignKey : SESSION;
    const clock = createGatewaySchedulerClock(Date.now());
    try {
      const create = () =>
        inRun(
          "operator-creates-continuation",
          original ? admission("operator-creates-continuation", recovery.client) : undefined,
          async (_identity, admitted, creator) => {
            bindGatewayContextResolver(admitted, () => context);
            try {
              await withPreparedEmbeddedGatewayTools(
                {
                  admittedRunContext: admitted,
                  cronCreatorAuthorityCapability: creator,
                  agentId: "main",
                  sessionKey: SESSION,
                  sessionId: SESSION_ID,
                  agentHarnessId: "openclaw",
                },
                () => true,
                async () => {
                  expectDefined(getGatewayToolCallerIdentity(), "creator caller");
                  const capturedTools: CronCreatorToolAllowlistEntry[] = [];
                  const capture: CronToolsAllowCaptureRef = {};
                  const tools = await createOpenClawCodingToolsAsync({
                    config,
                    agentId: "main",
                    sessionKey: SESSION,
                    sessionId: SESSION_ID,
                    runId: "operator-creates-continuation",
                    workspaceDir: stateDir,
                    operationalRunInstance: admitted.operationalRunInstance,
                    senderIsOwner: true,
                    cronCreatorToolAllowlistRef: capturedTools,
                    cronCreatorToolAllowlistCaptureRef: capture,
                    toolConstructionPlan: {
                      includeBaseCodingTools: false,
                      includeShellTools: false,
                      includeChannelTools: false,
                      includeOpenClawTools: true,
                      includePluginTools: false,
                    },
                  });
                  captureFinalEffectiveCronCreatorToolAllowlist(
                    capturedTools,
                    capture,
                    tools,
                    getPluginToolMeta,
                  );
                  const automations = expectDefined(
                    tools.find((tool) => tool.name === AUTOMATIONS_TOOL_NAME),
                    "creator automations",
                  );
                  await automations.execute("schedule-continuation", {
                    action: "add",
                    job: {
                      name: "Finish authorized work",
                      enabled: scenario !== "paused force run",
                      schedule: {
                        kind: "at",
                        at: new Date(clock.clock.now() + 60_000).toISOString(),
                      },
                      sessionTarget: "session:" + targetKey,
                      payload: {
                        kind: "agentTurn",
                        message: "Finish the authorized task",
                        toolsAllow: ["sessions_list"],
                      },
                      delivery: { mode: "none" },
                      deleteAfterRun: false,
                    },
                  });
                },
              );
            } finally {
              clearGatewayContextResolver(admitted);
            }
          },
          original?.authority,
        );
      if (original) {
        const creation = withPluginRuntimeGatewayRequestScope(
          {
            client: recovery.client,
            context,
            isWebchatConnect: () => false,
          },
          create,
        );
        if (scenario === "guest") {
          await expect(creation).rejects.toThrow("missing scope: operator.admin");
          expect(await fixture.read()).toEqual([]);
          return;
        }
        await creation;
      } else {
        await create();
      }
    } finally {
      original?.release();
      fixture.context.cron.stop();
      await creatorCron.waitForIdle();
    }
    // No operator request, original admitted run or human follow-up survives this point.
    const job = expectDefined((await fixture.read())[0], "durably stored continuation");
    if (scenario === "foreign target" || scenario === "legacy attribution") {
      expect(job.operatorSource).toBeUndefined();
    } else {
      expect(job.operatorSource?.source.sessionKey).toBe(SESSION);
    }
    if (original) {
      expect(() => original.authority.assertCurrent()).toThrow();
    }
    if (scenario === "current tool deny") {
      config.tools = { ...config.tools, deny: ["sessions_list"] };
      setRuntimeConfigSnapshot(config);
    } else if (scenario === "role revoked") {
      await setCanonicalUserProfileRole(profile.id, "blocked");
    } else if (scenario === "session replaced") {
      replaceSessionEntrySync(
        { sessionKey: SESSION },
        {
          ...recovery.entry,
          sessionId: "replacement-session",
          lifecycleRevision: "replacement",
        },
      );
    }

    let entered = 0;
    let offered: unknown;
    let restored: { profileId: string; scopes: readonly string[] } | undefined;
    let revokedDuringRun: string | undefined;
    runEmbeddedAgentMock.mockImplementation(async (params: RunEmbeddedAgentParams) => {
      entered++;
      const admitted = await expectDefined(
        params.preparedRunAdmission,
        "scheduled admission",
      ).admit("gateway", params.runId);
      return withPreparedEmbeddedGatewayTools(
        {
          admittedRunContext: admitted,
          agentId: "main",
          sessionKey: targetKey,
          sessionId: params.sessionId,
          agentHarnessId: "openclaw",
        },
        () => true,
        async () => {
          expectDefined(getGatewayToolCallerIdentity(), "scheduled caller");
          const tools = applyEmbeddedAttemptToolsAllow(
            await createOpenClawCodingToolsAsync({
              config: params.config,
              agentId: "main",
              sessionKey: targetKey,
              sessionId: params.sessionId,
              runId: params.runId,
              operationalRunInstance: admitted.operationalRunInstance,
              workspaceDir: params.workspaceDir,
              cwd: params.cwd,
              abortSignal: params.abortSignal,
              runtimeToolAllowlist: params.toolsAllow,
              scheduledToolPolicy: params.scheduledToolPolicy,
              toolConstructionPlan: {
                includeBaseCodingTools: false,
                includeShellTools: false,
                includeChannelTools: false,
                includeOpenClawTools: true,
                includePluginTools: false,
              },
            }),
            params.toolsAllow,
            { toolMeta: getPluginToolMeta },
          );
          offered = tools.find((tool) => tool.name === "sessions_list")?.parameters;
          // Operator-gated tools resolve their requester through this selection owner.
          const selection = resolveGatewayToolOperatorSelection();
          const authority = selection.operatorAuthority;
          if (authority) {
            selection.assertCurrent();
            restored = { profileId: authority.profileId, scopes: [...authority.scopes] };
            if (scenario === "role revoked during run") {
              await setCanonicalUserProfileRole(profile.id, "blocked");
              try {
                selection.assertCurrent();
              } catch (error) {
                revokedDuringRun = String(error);
              }
            }
          }
          return { payloads: [{ text: "Continuation complete" }], meta: { agentMeta: {} } };
        },
      );
    });
    const finished = createDeferredCore();
    const { cron: execution, state: schedulerState } = createCronServiceWithStateForTest({
      onEvent: (event) => {
        if (event.action === "finished" && event.jobId === job.id) {
          finished.resolve();
        }
      },
      scheduler: createTestGatewayScheduler(clock.clock),
      nowMs: clock.clock.now,
      storePath: path.join(stateDir, "cron", "jobs.json"),
      cronEnabled: true,
      defaultAgentId: "main",
      log: createNoopLogger(),
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runSchedulerOwned: createScheduledGatewayRunner(() => context),
      runIsolatedAgentJob: (request) =>
        runCronIsolatedAgentTurn({
          ...request,
          cfg: config,
          deps: {},
          agentId: "main",
          sessionKey:
            resolveCronSessionTargetSessionKey(request.job.sessionTarget) ??
            "cron:" + request.job.id,
        }),
    });
    context.cron = execution;
    try {
      await execution.start();
      expect(entered).toBe(0);
      const reloaded = expectDefined(execution.getJob(job.id), "reloaded scheduled job");
      if (scenario === "paused force run") {
        expect(reloaded.enabled).toBe(false);
        await execution.run(job.id, "force");
      } else {
        clock.setTime(expectDefined(reloaded.state.nextRunAtMs, "scheduled timer"));
        await onTimer(schedulerState);
      }
      await finished.promise;
      await execution.waitForIdle();
      const state = expectDefined(execution.getJob(job.id), "finished scheduled job").state;
      if (scenario === "role revoked" || scenario === "session replaced") {
        expect(entered).toBe(0);
        expect(state.lastRunStatus, state.lastError).toBe("error");
        expect(state.lastError).toMatch(
          scenario === "role revoked"
            ? /operator identity changed/i
            : /authority|source|conversation|session|role/i,
        );
        expect(restored).toBeUndefined();
        return;
      }
      expect(state.lastRunStatus, state.lastError).toBe("ok");
      expect(entered).toBe(1);
      if (scenario === "foreign target" || scenario === "legacy attribution") {
        expect(restored).toBeUndefined();
      } else {
        expect(restored).toEqual({ profileId: profile.id, scopes: ["operator.admin"] });
      }
      if (scenario === "role revoked during run") {
        expect(revokedDuringRun).toMatch(/operator/i);
      }
      if (scenario === "current tool deny") {
        expect(offered).toBeUndefined();
      } else {
        expect(offered).toBeDefined();
      }
      if (scenario === "paused force run") {
        expect(execution.getJob(job.id)).toMatchObject({
          enabled: false,
          schedule: job.schedule,
        });
      }
    } finally {
      execution.stop();
      await execution.waitForIdle();
    }
  });
});
