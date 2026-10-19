import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionGitHubPublicationPublished } from "../../../packages/gateway-protocol/src/schema/session-github-publication.js";
import { createOpenClawCodingToolsAsync } from "../../agents/agent-tools.js";
import { persistAuthProfileBatch } from "../../agents/auth-profiles/upsert-with-lock.js";
import { withPreparedEmbeddedGatewayTools } from "../../agents/embedded-agent-runner/run/attempt-gateway-tools.js";
import { applyEmbeddedAttemptToolsAllow } from "../../agents/embedded-agent-runner/run/attempt-tool-construction-plan.js";
import type { RunEmbeddedAgentParams } from "../../agents/embedded-agent-runner/run/params.js";
import { markRestartAbortedMainSessions } from "../../agents/main-session-recovery/main-session-restart-recovery-marking.js";
import { recoverStore } from "../../agents/main-session-recovery/main-session-restart-recovery-store.js";
import {
  createRestartRecoveryRequesterSource,
  readRestartRecoveryRequesterSource,
} from "../../agents/requester-run-recovery-source.js";
import { createAgentRunRestartAbortError } from "../../agents/run-termination.js";
import { createEmbeddedAgentRunnerOpenAiConfig } from "../../agents/test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { AUTOMATIONS_TOOL_NAME } from "../../agents/tools/automations-tool-name.js";
import {
  captureFinalEffectiveCronCreatorToolAllowlist,
  type CronCreatorToolAllowlistEntry,
  type CronToolsAllowCaptureRef,
} from "../../agents/tools/cron-tool.js";
import { getGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import { setRuntimeConfigSnapshot } from "../../config/config.js";
import { hasMainSessionRecoveryClaim } from "../../config/sessions/restart-recovery-state.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
import { resolveSessionWorkStartBlock } from "../../config/sessions/session-work-start.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import * as publicationIdentity from "../../gateway/github-publication-availability.js";
import * as publicationTransport from "../../gateway/github-publication-git-transport.js";
import { createGitHubPublicationCoordinator } from "../../gateway/github-publication.js";
import { captureGatewayOperatorRunAuthority } from "../../gateway/operator-run-authority.js";
import { createOperatorRecoveryFixture } from "../../gateway/operator-run-recovery.test-support.js";
import { createScheduledGatewayRunner } from "../../gateway/scheduled-run-gateway-context.js";
import { createAgentEventTestHarness } from "../../gateway/server-chat.agent-events.test-harness.js";
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
import { createMockGatewayRecoveryRuntime } from "../../gateway/server-recovery-runtime.test-support.js";
import { prepareGatewayRunShutdown } from "../../gateway/server-run-shutdown.js";
import { persistGatewaySessionLifecycleEvent } from "../../gateway/session-lifecycle-state.js";
import { createWorkerSessionPlacementStore } from "../../gateway/worker-environments/placement-store.js";
import {
  getAgentEventLifecycleGeneration,
  rotateAgentEventLifecycleGeneration,
} from "../../infra/agent-events.js";
import {
  bindGatewayContextResolver,
  clearGatewayContextResolver,
  withPluginRuntimeGatewayRequestScope,
} from "../../plugins/runtime/gateway-request-scope.js";
import { getPluginToolMeta } from "../../plugins/tool-metadata.js";
import {
  getCurrentSessionControllerOwner,
  isSessionControllerWorkActive,
} from "../../sessions/session-controller.lifecycle.js";
import {
  beginReplyMessageInjectionTarget,
  captureReplyMessageInjectionTarget,
} from "../../sessions/session-controller.message-injection.js";
import { createUserTurnTranscriptRecorder } from "../../sessions/user-turn-transcript.js";
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
  readSessionMessagesAsyncMock,
  resetRunCronIsolatedAgentTurnHarness,
  resolveConfiguredModelRefMock,
  resolveCronDeliveryPlanMock,
  resolveCronSessionMock,
  runEmbeddedAgentMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();
const { resolveAgentDir } = await import("./run.runtime.js");
const session = await vi.importActual<typeof import("./session.js")>("./session.js");
const accessor = await vi.importActual<typeof import("../../config/sessions/session-accessor.js")>(
  "../../config/sessions/session-accessor.js",
);
const transcriptReaders = await vi.importActual<
  typeof import("../../gateway/session-transcript-readers.js")
>("../../gateway/session-transcript-readers.js");
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
// admission, the offered schema, and the real guarded GitHub action owner.
describe("same-conversation scheduled operator continuation", () => {
  it.each([
    "operator",
    "paused force run",
    "restart",
    "restart with prior operator source",
    "restart with prior operator source and steering",
    "guest",
    "legacy attribution",
    "foreign target",
    "current tool deny",
    "role revoked",
    "role revoked during merge",
    "session replaced",
  ] as const)("preserves the %s boundary", async (scenario) => {
    const restarting = scenario.startsWith("restart");
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
      tools: { allow: [AUTOMATIONS_TOOL_NAME, "github_publish"] },
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
    const resolveGatewayContext = () => context;
    context.resolveGatewayContext = resolveGatewayContext;
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
                    githubPublicationAvailable: true,
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
                      name: "Finish authorized landing",
                      enabled: scenario !== "paused force run",
                      schedule: {
                        kind: "at",
                        at: new Date(clock.clock.now() + 60_000).toISOString(),
                      },
                      sessionTarget: "session:" + targetKey,
                      payload: {
                        kind: "agentTurn",
                        message: "Inspect and land the reviewed PR",
                        toolsAllow: ["github_publish"],
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
    if (scenario === "restart") {
      // The other restart cases retain the fixture's earlier operator source.
      const entry = { ...recovery.entry };
      delete entry.restartRecoveryDeliveryRunId;
      delete entry.restartRecoveryDeliverySourceRunId;
      delete entry.restartRecoverySourceIngress;
      delete entry.restartRecoveryOperatorSource;
      await accessor.replaceSessionEntry(recovery.target, entry);
    } else if (restarting) {
      // A prior human admission can leave requester facts beside its operator source.
      await accessor.replaceSessionEntry(recovery.target, {
        ...recovery.entry,
        restartRecoveryRequesterSource: expectDefined(
          createRestartRecoveryRequesterSource({
            ...recovery.target,
            entry: recovery.entry,
            requesterOrigin: { sessionKey: SESSION, operatorProfileId: profile.id },
          }),
          "prior human requester source",
        ),
      });
    }
    // No operator request, original admitted run or human follow-up survives this point.
    const job = expectDefined((await fixture.read())[0], "durably stored continuation");
    if (scenario === "foreign target") {
      expect(job.operatorSource).toBeUndefined();
    }
    if (original) {
      expect(() => original.authority.assertCurrent()).toThrow();
    }
    if (scenario === "current tool deny") {
      config.tools = { ...config.tools, deny: ["github_publish"] };
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

    // A prior publication receipt is a fixed input to the action owner. Publication
    // creation/storage and actual GitHub credentials are outside this regression.
    const publication: SessionGitHubPublicationPublished = {
      status: "published",
      requestId: "27878d29-9f2e-462d-a68a-4e9b4ba27685",
      repository: "fixture/repository",
      branch: "reviewed-change",
      headCommit: "a".repeat(40),
      url: "https://github.com/fixture/repository/pull/7",
      publisher: {
        source: "agent-override",
        accountId: 42,
        login: "roboclaw-bot",
      },
    };
    const coordinator = createGitHubPublicationCoordinator({
      placements: createWorkerSessionPlacementStore(),
      getCommittedRuntimeConfig: () => config,
    });
    context.githubPublicationService = coordinator;
    const receipt = vi
      .spyOn(coordinator, "latestShared")
      .mockResolvedValue({ result: publication, confirmation: null });
    vi.spyOn(publicationIdentity, "prepareCurrentGitHubPublicationIdentity").mockResolvedValue({
      source: "agent-override",
      account: { accountId: 42, login: "roboclaw-bot", avatarUrl: null },
      env: {},
    });
    vi.spyOn(publicationIdentity, "matchesCurrentGitHubPublicationIdentity").mockReturnValue(true);
    let merged = false;
    let reads = 0;
    const writes: unknown[] = [];
    const github = vi
      .spyOn(publicationTransport, "runPublicationCommand")
      .mockImplementation(async (argv, options) => {
        options?.beforeRun?.();
        if (argv.includes("PUT") && argv.includes("repos/fixture/repository/pulls/7/merge")) {
          writes.push(JSON.parse(String(options?.input)));
          merged = true;
        } else {
          expect(argv).toContain("GET");
          expect(argv).toContain("repos/fixture/repository/pulls/7");
          reads++;
          if (scenario === "role revoked during merge" && reads === 2) {
            // Inspect already succeeded. Revoke while merge's preflight read is
            // awaited, before the action owner can perform its final write.
            await setCanonicalUserProfileRole(profile.id, "blocked");
          }
        }
        return {
          code: 0,
          termination: "exit" as const,
          signal: null,
          killed: false,
          stderr: Buffer.alloc(0),
          stdout: Buffer.from(
            JSON.stringify({
              node_id: "fixture-pr",
              html_url: publication.url,
              title: "Reviewed change",
              body: "Reviewed",
              state: merged ? "closed" : "open",
              draft: false,
              merged,
              head: { ref: publication.branch, sha: publication.headCommit },
              base: { repo: { full_name: publication.repository } },
              mergeable: true,
              mergeable_state: "clean",
              merge_commit_sha: merged ? "b".repeat(40) : null,
            }),
          ),
        };
      });
    const restartEntered = createDeferredCore();
    const restartContinue = createDeferredCore();
    let shutdownReleased: Promise<void> | undefined;
    let interruptedRunId: string | undefined;
    let entered = 0;
    let offered: unknown;
    const results: unknown[] = [];
    let rejected: string | undefined;
    runEmbeddedAgentMock.mockImplementation(async (params: RunEmbeddedAgentParams) => {
      entered++;
      const admitted = await expectDefined(
        params.preparedRunAdmission,
        "scheduled admission",
      ).admit("gateway", params.runId);
      if (restarting && entered === 1) {
        expect(params.toolsAllow).toEqual(["github_publish"]);
        const recorder = expectDefined(params.userTurnTranscriptRecorder, "cron transcript owner");
        expect(await recorder.persistApproved()).toBeDefined();
        interruptedRunId = params.runId;
        const lifecycleGeneration = getAgentEventLifecycleGeneration();
        await params.onExecutionStarted?.({
          lifecycleGeneration,
        });
        await persistGatewaySessionLifecycleEvent({
          agentId: "main",
          sessionKey: SESSION,
          event: {
            runId: params.runId,
            sessionId: params.sessionId,
            lifecycleGeneration,
            ts: Date.now(),
            data: { phase: "start" },
          },
        });
        if (scenario === "restart with prior operator source and steering") {
          const steeringAuthority = expectDefined(
            await captureGatewayOperatorRunAuthority({
              client: recovery.client,
              context,
              sourceAuthority: null,
            }),
            "fresh authenticated steering source",
          );
          try {
            const steering = createUserTurnTranscriptRecorder({
              input: { text: "Continue the scheduled task", provenance: { kind: "external_user" } },
              target: () => ({
                ...recovery.target,
                sessionEntry: accessor.loadSessionEntry(recovery.target),
                config,
              }),
              assertOriginalInputCommit: steeringAuthority.authority.assertCurrent,
            });
            const operation = expectDefined(getCurrentSessionControllerOwner(), "cron owner");
            operation.setPhase("running");
            operation.attachBackend({
              kind: "embedded",
              runId: params.runId,
              toolAuthorityFingerprint: "scheduled-tools",
              cancel() {},
              messageInjectionV2: {
                version: 2,
                isAvailable: () => true,
                queueMessage: async (_text, options, assertCurrent) => {
                  assertCurrent();
                  expect(
                    await options?.userTurnTranscriptRecorder?.persistApproved(),
                  ).toBeDefined();
                },
              },
            });
            const attempt = await beginReplyMessageInjectionTarget(
              expectDefined(captureReplyMessageInjectionTarget(operation), "running cron target"),
              "Continue the scheduled task",
              {
                isInboundUserMessage: true,
                toolAuthorityFingerprint: "scheduled-tools",
                assertCurrent: steeringAuthority.authority.assertCurrent,
                waitForTranscriptCommit: true,
                userTurnTranscriptRecorder: steering,
              },
            );
            expect(await attempt.outcome).toEqual({ status: "accepted" });
            expect(steering.getPersistedMessage?.()?.["__openclaw"]?.steerTargetRunId).toBe(
              params.runId,
            );
          } finally {
            steeringAuthority.release();
          }
        }
        restartEntered.resolve();
        await restartContinue.promise;
        throw createAgentRunRestartAbortError();
      }
      return withPreparedEmbeddedGatewayTools(
        {
          admittedRunContext: admitted,
          agentId: "main",
          sessionKey: targetKey,
          sessionId: params.sessionId,
          agentHarnessId: "openclaw",
        },
        async () => {
          // Schema projection reads session control authority from this admitted caller.
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
              githubPublicationAvailable: true,
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
          const publish = tools.find((tool) => tool.name === "github_publish");
          offered = publish?.parameters;
          if (publish && JSON.stringify(offered).includes('"inspect"')) {
            try {
              results.push(await publish.execute("scheduled-inspect", { action: "inspect" }));
              results.push(
                await publish.execute("scheduled-merge", {
                  action: "merge",
                  requestId: publication.requestId,
                  expectedHeadCommit: publication.headCommit,
                  mergeMethod: "merge",
                }),
              );
            } catch (error) {
              rejected = String(error);
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
      runSchedulerOwned: createScheduledGatewayRunner(resolveGatewayContext),
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
        const tick = onTimer(schedulerState);
        if (restarting) {
          await restartEntered.promise;
          const harness = createAgentEventTestHarness();
          try {
            const shutdown = await prepareGatewayRunShutdown({
              resolveGatewayContext,
              timeoutMs: 0,
              warnings: [],
              getPendingReplyCount: () => 0,
              chatRunState: harness.chatRunState,
              agentRunSeq: harness.agentRunSeq,
              removeChatRun: () => undefined,
              broadcast: harness.broadcast,
              nodeSendToSession: harness.nodeSendToSession,
              markMainSessionsAbortedForRestart: (params) =>
                markRestartAbortedMainSessions({ ...params, cfg: config, stateDir }).then(
                  () => undefined,
                ),
            });
            shutdownReleased = shutdown.released;
            const interrupted = expectDefined(
              accessor.loadSessionEntry(recovery.target),
              "interrupted cron parent",
            );
            expect(interrupted).toMatchObject({
              status: "interrupted",
              mainRestartRecovery: { cycleId: expect.any(String) },
            });
            expect(interrupted.restartRecoveryDeliverySourceRunId).toBe(
              scenario === "restart" ? interruptedRunId : recovery.target.sourceRunId,
            );
            if (scenario !== "restart") {
              expect(
                readRestartRecoveryRequesterSource({ ...recovery.target, entry: interrupted }),
              ).toMatchObject({ sessionKey: SESSION, operatorProfileId: profile.id });
            }
            expect(interrupted.restartRecoveryRuns).toContainEqual({
              runId: interruptedRunId,
              lifecycleGeneration: getAgentEventLifecycleGeneration(),
            });
          } finally {
            restartContinue.resolve();
            await harness.handler.dispose();
          }
        }
        await tick;
      }
      await finished.promise;
      await execution.waitForIdle();
      const state = expectDefined(execution.getJob(job.id), "finished scheduled job").state;
      if (restarting) {
        await shutdownReleased;
        expect(state.lastRunStatus, state.lastError).toBe("error");
        expect(execution.getJob(job.id)?.enabled).toBe(true);
        expect(state.nextRunAtMs).toEqual(expect.any(Number));
        expect(entered).toBe(1);
        expect(writes).toEqual([]);
        expect(job.operatorSource).toBeDefined();
        rotateAgentEventLifecycleGeneration();
        readSessionMessagesAsyncMock.mockImplementation(transcriptReaders.readSessionMessagesAsync);
        const gatewayRuntime = createMockGatewayRecoveryRuntime();
        vi.mocked(gatewayRuntime.dispatchAgent).mockResolvedValue({
          runId: "unexpected-cron-recovery",
          status: "ok",
        });
        const recover = () =>
          recoverStore({
            cfg: config,
            storePath: recovery.target.storePath,
            stateDir,
            expectedTarget: { sessionKey: SESSION, sessionId: SESSION_ID },
            handledSessionKeys: new Set(),
            gatewayRuntime,
          });
        await recover();
        await recover();
        expect(gatewayRuntime.dispatchAgent).not.toHaveBeenCalled();
        const saved = expectDefined(
          accessor.loadSessionEntry(recovery.target),
          "settled cron parent",
        );
        expect(saved.abortedLastRun).toBe(false);
        expect(saved.lifecycleRunId).toBeUndefined();
        expect(saved.activeWriterRunId).toBeUndefined();
        expect(saved.status).toBe("interrupted");
        expect(hasMainSessionRecoveryClaim(saved)).toBe(false);
        expect(resolveSessionWorkStartBlock(SESSION, saved)).toBeUndefined();
        expect(
          isSessionControllerWorkActive(recovery.target.storePath, [SESSION, SESSION_ID]),
        ).toBe(false);
        execution.stop();
        await execution.waitForIdle();
        await execution.start();
        clock.setTime(expectDefined(execution.getJob(job.id)?.state.nextRunAtMs, "restart retry"));
        await onTimer(schedulerState);
        await execution.waitForIdle();
        expect(entered).toBe(2);
        expect(writes).toEqual([{ sha: "a".repeat(40), merge_method: "merge" }]);
        expect(execution.getJob(job.id)?.state.lastRunStatus).toBe("ok");
        execution.stop();
        await execution.waitForIdle();
        await execution.start();
        await onTimer(schedulerState);
        await execution.waitForIdle();
        expect(entered).toBe(2);
        return;
      }
      if (scenario === "role revoked" || scenario === "session replaced") {
        expect(entered).toBe(0);
        expect(state.lastRunStatus, state.lastError).toBe("error");
        expect(state.lastError).toMatch(
          scenario === "role revoked"
            ? /operator identity changed/i
            : /authority|source|conversation|session|role/i,
        );
      } else {
        expect(state.lastRunStatus, state.lastError).toBe("ok");
        expect(entered).toBe(1);
        if (scenario === "operator" || scenario === "paused force run") {
          expect(JSON.stringify(offered)).toContain("inspect");
          expect(JSON.stringify(offered)).toContain("merge");
          expect(rejected).toBeUndefined();
          expect(results).toMatchObject([
            {
              details: { state: "open", publishingSessionKey: SESSION, headCommit: "a".repeat(40) },
            },
            { details: { state: "merged", mergeCommit: "b".repeat(40) } },
          ]);
          expect(writes).toEqual([{ sha: "a".repeat(40), merge_method: "merge" }]);
          expect(receipt).toHaveBeenCalled();
          if (scenario === "paused force run") {
            expect(execution.getJob(job.id)).toMatchObject({
              enabled: false,
              schedule: job.schedule,
            });
          }
        } else if (scenario === "role revoked during merge") {
          expect(reads).toBe(2);
          expect(results).toHaveLength(1);
          expect(rejected).toMatch(/operator authority changed/i);
          expect(writes).toEqual([]);
        } else if (scenario === "current tool deny") {
          expect(offered).toBeUndefined();
        } else {
          expect(JSON.stringify(offered)).not.toContain("inspect");
          expect(JSON.stringify(offered)).not.toContain("merge");
          expect(results).toEqual([]);
        }
      }
      if (
        scenario !== "operator" &&
        scenario !== "paused force run" &&
        scenario !== "role revoked during merge"
      ) {
        expect(writes).toEqual([]);
        expect(github).not.toHaveBeenCalled();
        expect(receipt).not.toHaveBeenCalled();
      }
    } finally {
      restartContinue.resolve();
      execution.stop();
      await execution.waitForIdle();
    }
  });
});
