import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import { createOpenClawCodingToolsAsync } from "../../agents/agent-tools.js";
import { withPreparedEmbeddedGatewayTools } from "../../agents/embedded-agent-runner/run/attempt-gateway-tools.js";
import { applyEmbeddedAttemptToolsAllow } from "../../agents/embedded-agent-runner/run/attempt-tool-construction-plan.js";
import type { RunEmbeddedAgentParams } from "../../agents/embedded-agent-runner/run/params.js";
import { createAgentRunRestartAbortError } from "../../agents/run-termination.js";
import { AUTOMATIONS_TOOL_NAME } from "../../agents/tools/automations-tool-name.js";
import {
  captureFinalEffectiveCronCreatorToolAllowlist,
  type CronCreatorToolAllowlistEntry,
  type CronToolsAllowCaptureRef,
} from "../../agents/tools/cron-tool.js";
import { getGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import { setRuntimeConfigSnapshot } from "../../config/config.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
import { readSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import * as publicationIdentity from "../../gateway/github-publication-availability.js";
import * as publicationTransport from "../../gateway/github-publication-git-transport.js";
import { createGitHubPublicationCoordinator } from "../../gateway/github-publication.js";
import { captureGatewayOperatorRunAuthority } from "../../gateway/operator-run-authority.js";
import { cronHandlers } from "../../gateway/server-methods/cron.js";
import {
  admission,
  cron as creatorCron,
  createCronFixture,
  inRun,
  installRequesterCronAuthorityTestHooks,
  SESSION,
  SESSION_ID,
  stateDir,
} from "../../gateway/server-methods/requester-cron-authority.test-support.js";
import { createSyntheticPluginRuntimeClient } from "../../gateway/server-plugin-runtime-client.js";
import { createWorkerSessionPlacementStore } from "../../gateway/worker-environments/placement-store.js";
import { getAgentEventLifecycleGeneration } from "../../infra/agent-events.js";
import { getPluginRegistryState } from "../../plugins/runtime-state.js";
import {
  bindGatewayContextResolver,
  clearGatewayContextResolver,
  withPluginRuntimeGatewayRequestScope,
} from "../../plugins/runtime/gateway-request-scope.js";
import { getPluginToolMeta } from "../../plugins/tool-metadata.js";
import { withSessionTurn } from "../../sessions/session-controller.admission.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { setCanonicalUserProfileRole } from "../../state/user-profile-writes.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { createGatewaySchedulerClock } from "../../test-utils/gateway-scheduler-clock.js";
import type { CronEvent } from "../service.js";
import { resolveCronRequesterExecutionRevision } from "../service/jobs-tool-policy.js";
import { onTimer } from "../service/timer.test-support.js";
import { saveCronStore } from "../store.js";
import { cronStoreKey } from "../store/key.js";
import { updateCronRuntimeRow } from "../store/row-codec.js";
import { prepareAuthorityConfig, resetAuthorityRunHarness } from "./run.authority.test-support.js";
import {
  createOperatorContinuationService,
  publication,
  publicationCommandResult,
} from "./run.operator-continuation.test-support.js";
import {
  prepareContinuationClient,
  PRINCIPAL_POLICY_CASES,
  isPrincipalPolicyScenario,
  preparePrincipalPolicyChange,
  principalGatewayPolicy,
  captureRealIngressOperator,
  expectRetryableOriginalOneShot,
  principalRecoveryFixture,
  registerScheduledPrincipalFixture,
  prepareRestartBeforeScheduling,
} from "./run.operator-restart.test-support.js";
import {
  loadRunCronIsolatedAgentTurn,
  loadSessionEntryMock,
  patchSessionEntryMock,
  resolveCronSessionMock,
  runEmbeddedAgentMock,
} from "./run.test-harness.js";

const sessionRunner = vi.hoisted(() => ({
  runEmbedded: vi.fn<typeof import("../../agents/embedded-agent-runner/run.js").runEmbeddedAgent>(),
}));
// mock-isolation: Only model execution is synthetic; scheduled admission and publication stay real.
vi.mock("../../agents/embedded-agent-runner/run.js", () => ({
  runEmbeddedAgent: sessionRunner.runEmbedded,
}));

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();
await Promise.all([
  import("../../auto-reply/dispatch.js"),
  import("../../auto-reply/reply/get-reply-from-config.runtime.js").then((runtime) =>
    runtime.prewarmConfigDrivenReplyRuntime(),
  ),
]);
const session = await vi.importActual<typeof import("./session.js")>("./session.js");
const accessor = await vi.importActual<typeof import("../../config/sessions/session-accessor.js")>(
  "../../config/sessions/session-accessor.js",
);
installRequesterCronAuthorityTestHooks(() => ({
  type: "human",
  source: "profile",
  id: ensureProfileForEmail("scheduled-operator@example.test").id,
}));

const toolConstructionPlan = {
  includeBaseCodingTools: false,
  includeShellTools: false,
  includeChannelTools: false,
  includeOpenClawTools: true,
  includePluginTools: false,
};

beforeEach(() => {
  resetAuthorityRunHarness();
  resolveCronSessionMock.mockImplementation(session.prepareCronSession);
  loadSessionEntryMock.mockImplementation(session.loadCronSessionEntryLatest);
  patchSessionEntryMock.mockImplementation(accessor.patchSessionEntryCore);
  sessionRunner.runEmbedded
    .mockReset()
    .mockImplementation((params) => runEmbeddedAgentMock(params));
});
afterEach(() => {
  runEmbeddedAgentMock.mockReset();
  vi.restoreAllMocks();
});

// Exercise custody transfer through durable reload, scheduled admission and the real action owner.
it.each([
  "operator",
  "write-scoped operator",
  "cron-scoped operator",
  "self removal",
  "self removal then role revoked during merge",
  "self removal then session replaced during merge",
  "paused force run",
  "restart",
  "principal reload",
  ...PRINCIPAL_POLICY_CASES,
  "principal owner unavailable",
  "principal store unavailable",
  "restart before scheduling",
  "restart before scheduling revoked ingress",
  "restart before scheduling without source",
  "principal ingress revoked",
  "principal ingress replaced",
  "principal role revoked",
  "principal access revoked",
  "guest",
  "legacy attribution",
  "foreign target",
  "current tool deny",
  "role revoked",
  "role revoked during merge",
  "session replaced",
  "queued owner payload edit",
  "queued manager rename",
  "owner capture races manager payload",
  "recurring trigger reload",
] as const)("scheduled continuation preserves the %s boundary", async (scenario) => {
  const restartBeforeScheduling = scenario.startsWith("restart before scheduling");
  const principalSource = scenario.startsWith("principal") || restartBeforeScheduling;
  const unavailableSource =
    scenario === "principal owner unavailable" || scenario === "principal store unavailable";
  const personPolicySource = isPrincipalPolicyScenario(scenario);
  const personPolicyRemoved = personPolicySource && scenario !== "principal allowlist allowed";
  const realPrincipal = principalSource;
  let restoreIngressOwner: (() => void) | undefined;
  let releaseIngressOwner: (() => void) | undefined;
  const roleRevoked = scenario === "role revoked" || scenario === "principal role revoked";
  const restarting = scenario === "restart";
  const ownerEdit = scenario === "queued owner payload edit";
  const managerRename = scenario === "queued manager rename";
  const captureRace = scenario === "owner capture races manager payload";
  const queuedEdit = ownerEdit || managerRename || captureRace;
  const recurring = scenario === "recurring trigger reload";
  const selfRemoving = scenario.startsWith("self removal");
  const scopedOperator =
    scenario === "write-scoped operator" || scenario === "cron-scoped operator";
  const config = await prepareAuthorityConfig({
    tools: { allow: [AUTOMATIONS_TOOL_NAME, "github_publish"] },
    ...(realPrincipal ? { gateway: principalGatewayPolicy(personPolicySource) } : {}),
    ...(recurring ? { cron: { triggers: { enabled: true } } } : {}),
  });
  const fixture = createCronFixture(undefined, config);
  const { context } = fixture;
  const resolveGatewayContext = () => context;
  context.resolveGatewayContext = resolveGatewayContext;
  const profile = ensureProfileForEmail("scheduled-operator@example.test");
  if (realPrincipal) {
    await setCanonicalUserProfileRole(profile.id, "writer");
  }
  const { client, revokePersonPolicy } = prepareContinuationClient({
    config,
    context,
    profileId: profile.id,
    scenario,
  });
  const target = {
    agentId: "main",
    sessionKey: SESSION,
    sessionId: SESSION_ID,
    storePath: path.join(stateDir, "agents", "main", "sessions", "sessions.json"),
  };
  const entry: InternalSessionEntry = {
    sessionId: SESSION_ID,
    updatedAt: 1,
    lifecycleRevision: "original-lifecycle",
    parentSessionKey: "agent:main:main",
    spawnDepth: 0,
    createdActor: { type: "human", source: "profile", id: profile.id },
    status: "done",
    abortedLastRun: false,
  };
  await accessor.replaceSessionEntry(target, entry);
  if (restartBeforeScheduling) {
    expect((await readSessionEntryReadOnlyInWorker(target))?.createdActor?.id).toBe(profile.id);
  }
  const captureAuthority = async () =>
    expectDefined(
      await captureGatewayOperatorRunAuthority({
        client,
        context,
        sourceAuthority: null,
      }),
      "fresh authenticated operator source",
    );
  // Legacy attribution is not admission; other cases capture a fresh authenticated source.
  const original =
    scenario === "legacy attribution"
      ? undefined
      : realPrincipal
        ? await captureRealIngressOperator({
            context,
            config,
            profileId: profile.id,
            scopes: client.connect.scopes ?? [],
          })
        : await captureAuthority();
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
  const toolDefaults = {
    config,
    agentId: "main",
    sessionKey: SESSION,
    sessionId: SESSION_ID,
    workspaceDir: stateDir,
    githubPublicationAvailable: true,
  };
  const gatewayToolDefaults = {
    agentId: "main",
    sessionKey: SESSION,
    sessionId: SESSION_ID,
    agentHarnessId: "openclaw",
  } as const;
  const creatorReady = createDeferredCore();
  const updateCreator = createDeferredCore();
  const creatorUpdated = createDeferredCore();
  const releaseCreator = createDeferredCore();
  if (scenario === "principal access revoked" && original) {
    original.authority = principalRecoveryFixture(
      original.authority,
      scenario === "principal access revoked",
    );
  }
  if (restartBeforeScheduling) {
    expect(config.gateway?.roles).toBeDefined();
    const proceed = await prepareRestartBeforeScheduling({
      original: expectDefined(original, "initiating authenticated turn"),
      target,
      context,
      profile,
      readJobs: fixture.read,
      revoked: scenario === "restart before scheduling revoked ingress",
      sourceLess: scenario === "restart before scheduling without source",
    });
    if (!proceed) {
      creatorCron.stop();
      await creatorCron.waitForIdle();
      return;
    }
  }
  let creation: Promise<unknown> | undefined;
  let releaseAccessPolicy: (() => void) | undefined;
  const managerUpdate = async (patch: Record<string, unknown>) => {
    const stored = expectDefined((await fixture.read())[0], "manager target");
    const respond = vi.fn();
    await expectDefined(
      cronHandlers["cron.update"],
      "cron update handler",
    )({
      req: { type: "req", id: "manager-update", method: "cron.update" },
      params: { jobId: stored.id, patch },
      client: createSyntheticPluginRuntimeClient({ scopes: ["operator.admin"] }),
      context,
      isWebchatConnect: () => false,
      respond,
    });
    expect(respond.mock.calls[0]?.[0]).toBe(true);
  };
  try {
    const createRun = () =>
      inRun(
        "operator-creates-continuation",
        original ? admission("operator-creates-continuation", client) : undefined,
        async (_identity, admitted, creator) => {
          bindGatewayContextResolver(admitted, () => context);
          try {
            await withPreparedEmbeddedGatewayTools(
              {
                ...gatewayToolDefaults,
                admittedRunContext: admitted,
                cronCreatorAuthorityCapability: creator,
              },
              async () => {
                expectDefined(getGatewayToolCallerIdentity(), "creator caller");
                const capturedTools: CronCreatorToolAllowlistEntry[] = [];
                const capture: CronToolsAllowCaptureRef = {};
                const tools = await createOpenClawCodingToolsAsync({
                  ...toolDefaults,
                  toolConstructionPlan: { ...toolConstructionPlan },
                  runId: "operator-creates-continuation",
                  operationalRunInstance: admitted.operationalRunInstance,
                  senderIsOwner: !scopedOperator,
                  cronCreatorToolAllowlistRef: capturedTools,
                  cronCreatorToolAllowlistCaptureRef: capture,
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
                    schedule:
                      recurring || roleRevoked
                        ? { kind: "every", everyMs: 180_000 }
                        : {
                            kind: "at",
                            at: new Date(clock.clock.now() + 60_000).toISOString(),
                          },
                    ...(recurring
                      ? { trigger: { script: 'return { fire: true, message: "CI passed" };' } }
                      : {}),
                    sessionTarget: "session:" + targetKey,
                    payload: {
                      kind: "agentTurn",
                      message: "Inspect and land the reviewed PR",
                      toolsAllow:
                        ownerEdit || selfRemoving
                          ? ["github_publish", AUTOMATIONS_TOOL_NAME]
                          : ["github_publish"],
                    },
                    delivery: { mode: "none" },
                    deleteAfterRun: false,
                  },
                });
                if (queuedEdit) {
                  const created = expectDefined((await fixture.read())[0], "created continuation");
                  creatorReady.resolve();
                  await updateCreator.promise;
                  if (!managerRename) {
                    await automations.execute("refresh-continuation", {
                      action: "update",
                      jobId: created.id,
                      job: captureRace
                        ? { description: "Owner metadata refresh" }
                        : {
                            name: "Refreshed authorized landing",
                            payload: {
                              kind: "agentTurn",
                              message: "Land the refreshed reviewed PR",
                            },
                          },
                    });
                  }
                  creatorUpdated.resolve();
                  await releaseCreator.promise;
                }
              },
            );
          } finally {
            clearGatewayContextResolver(admitted);
          }
        },
        original?.authority,
      );
    const create = () => (queuedEdit ? withSessionTurn(target, () => createRun()) : createRun());
    if (original) {
      creation = withPluginRuntimeGatewayRequestScope(
        {
          client,
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
      if (queuedEdit) {
        await Promise.race([creatorReady.promise, creation]);
      } else {
        await creation;
      }
    } else {
      await create();
    }
  } finally {
    if (!queuedEdit) {
      original?.release();
      fixture.context.cron.stop();
      await creatorCron.waitForIdle();
    }
  }
  if (principalSource) {
    if (scenario === "principal access revoked") {
      const registry = expectDefined(
        getPluginRegistryState()?.activeRegistry,
        "live access policy registry",
      );
      const previousPolicies = [...registry.gatewayAccessPolicies];
      releaseAccessPolicy = () => {
        registry.gatewayAccessPolicies = previousPolicies;
      };
      registry.gatewayAccessPolicies.push({
        pluginId: "principal-access",
        source: "test",
        policy: { authorize: () => undefined, resume: () => undefined },
      });
    }
    const recovery = registerScheduledPrincipalFixture({
      context,
      profileId: profile.id,
      scopes: client.connect.scopes ?? [],
      state:
        scenario === "principal owner unavailable"
          ? "owner-unavailable"
          : scenario === "principal store unavailable"
            ? "store-unavailable"
            : scenario === "principal ingress revoked"
              ? "revoked"
              : scenario === "principal ingress replaced"
                ? "replaced"
                : "current",
    });
    restoreIngressOwner = recovery.restore;
    releaseIngressOwner = recovery.release;
  }
  await preparePrincipalPolicyChange(scenario, revokePersonPolicy);
  // No operator request, original admitted run or human follow-up survives this point.
  const job = expectDefined((await fixture.read())[0], "durably stored continuation");
  if (scopedOperator) {
    expect(job.operatorSource?.source.snapshot.scopes).toEqual(client.connect.scopes);
  }
  if (scenario === "foreign target") {
    expect(job.operatorSource).toBeUndefined();
  }
  if (original && !queuedEdit) {
    expect(() => original.authority.assertCurrent()).toThrow();
  }
  if (scenario === "current tool deny") {
    config.tools = { ...config.tools, deny: ["github_publish"] };
    setRuntimeConfigSnapshot(config);
  } else if (roleRevoked) {
    await setCanonicalUserProfileRole(profile.id, "blocked");
  } else if (scenario === "session replaced") {
    replaceSessionEntrySync(
      { sessionKey: SESSION },
      {
        ...entry,
        sessionId: "replacement-session",
        lifecycleRevision: "replacement",
      },
    );
  }

  // Publication creation/storage and actual GitHub credentials are outside this regression.
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
      if (selfRemoving) {
        expect(context.cron.getJob(job.id)).toBeUndefined();
      }
      if (argv.includes("PUT") && argv.includes("repos/fixture/repository/pulls/7/merge")) {
        writes.push(JSON.parse(String(options?.input)));
        merged = true;
      } else {
        expect(argv).toContain("GET");
        expect(argv).toContain("repos/fixture/repository/pulls/7");
        reads++;
        if (reads === 2) {
          // Commit authority loss during awaited preflight, before the final write.
          if (
            scenario === "role revoked during merge" ||
            scenario === "self removal then role revoked during merge"
          ) {
            await setCanonicalUserProfileRole(profile.id, "blocked");
          } else if (scenario === "self removal then session replaced during merge") {
            await accessor.replaceSessionEntry(target, {
              ...expectDefined(accessor.loadSessionEntry(target), "active session"),
              sessionId: "replacement-session",
              lifecycleRevision: "replacement",
            });
          }
        }
      }
      return publicationCommandResult(merged);
    });
  const restartEntered = createDeferredCore();
  const restartContinue = createDeferredCore();
  let entered = 0;
  let offered: unknown;
  let admittedOperator = false;
  const results: unknown[] = [];
  let rejected: string | undefined;
  let nextCheckDefinition: string | undefined;
  runEmbeddedAgentMock.mockImplementation(async (params: RunEmbeddedAgentParams) => {
    entered++;
    if (ownerEdit || recurring || managerRename || captureRace) {
      expect(params.prompt).toContain(
        ownerEdit
          ? "Land the refreshed reviewed PR"
          : recurring
            ? "CI passed"
            : managerRename
              ? "Manager-authored instructions"
              : "Manager replacement payload",
      );
    }
    const admitted = await expectDefined(params.preparedRunAdmission, "scheduled admission").admit(
      "gateway",
      params.runId,
    );
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    await params.onExecutionStarted?.({ lifecycleGeneration });
    params.onExecutionPhase?.({ phase: "model_call_started" });
    await params.onAgentEvent?.({ stream: "lifecycle", data: { phase: "start" } });
    if (restarting && entered === 1) {
      expect(params.toolsAllow).toEqual(["github_publish"]);
      const recorder = expectDefined(params.userTurnTranscriptRecorder, "cron transcript owner");
      expect(await recorder.persistApproved()).toBeDefined();
      restartEntered.resolve();
      await restartContinue.promise;
      throw createAgentRunRestartAbortError();
    }
    return withPreparedEmbeddedGatewayTools(
      {
        ...gatewayToolDefaults,
        admittedRunContext: admitted,
        sessionKey: targetKey,
        sessionId: params.sessionId,
      },
      async () => {
        // Stable schemas list actions; execution checks this admitted caller's authority.
        expectDefined(getGatewayToolCallerIdentity(), "scheduled caller");
        const tools = applyEmbeddedAttemptToolsAllow(
          await createOpenClawCodingToolsAsync({
            ...toolDefaults,
            toolConstructionPlan: { ...toolConstructionPlan },
            config: params.config,
            sessionKey: targetKey,
            sessionId: params.sessionId,
            runId: params.runId,
            operationalRunInstance: admitted.operationalRunInstance,
            workspaceDir: params.workspaceDir,
            cwd: params.cwd,
            abortSignal: params.abortSignal,
            runtimeToolAllowlist: params.toolsAllow,
            scheduledToolPolicy: params.scheduledToolPolicy,
            trigger: params.trigger,
            jobId: params.jobId,
          }),
          params.toolsAllow,
          { toolMeta: getPluginToolMeta },
        );
        if (ownerEdit) {
          nextCheckDefinition = resolveCronRequesterExecutionRevision(
            expectDefined(context.cron.getJob(job.id), "before next_check"),
          );
          await expectDefined(
            tools.find((tool) => tool.name === AUTOMATIONS_TOOL_NAME),
            "continuation automations",
          ).execute("next-check", { action: "next_check", in: "3m" });
          expect(
            resolveCronRequesterExecutionRevision(
              expectDefined(context.cron.getJob(job.id), "after next_check"),
            ),
          ).toBe(nextCheckDefinition);
        }
        const scheduledOperator = readAdmittedRunOperatorAuthority(admitted);
        admittedOperator = scheduledOperator !== undefined;
        if (scopedOperator) {
          expect(scheduledOperator?.scopes).toEqual(client.connect.scopes);
        }
        if (selfRemoving) {
          const automations = expectDefined(
            tools.find((tool) => tool.name === AUTOMATIONS_TOOL_NAME),
            "scheduled self-cleanup tool",
          );
          await automations.execute("self-cleanup", { action: "remove", jobId: job.id });
          expect(params.abortSignal?.aborted).toBe(false);
          expect(context.cron.getJob(job.id)).toBeUndefined();
        }
        const publish = tools.find((tool) => tool.name === "github_publish");
        offered = publish?.parameters;
        if (publish) {
          expect(JSON.stringify(offered)).toContain('"inspect"');
          expect(JSON.stringify(offered)).toContain("merge");
          for (const args of [
            { action: "inspect" },
            {
              action: "merge",
              requestId: publication.requestId,
              expectedHeadCommit: publication.headCommit,
              mergeMethod: "merge",
            },
          ]) {
            try {
              results.push(await publish.execute(`scheduled-${args.action}`, args));
            } catch (error) {
              rejected = String(error);
              if (
                scenario === "role revoked during merge" ||
                scenario === "self removal then role revoked during merge"
              ) {
                expect(params.abortSignal?.aborted).toBe(true);
              }
            }
          }
        }
        return { payloads: [{ text: "Continuation complete" }], meta: { agentMeta: {} } };
      },
    );
  });
  const finished = createDeferredCore();
  let finishedEvent: CronEvent | undefined;
  const { cron: execution, state: schedulerState } = createOperatorContinuationService({
    config,
    stateDir,
    clock: clock.clock,
    resolveGatewayContext,
    runIsolated: runCronIsolatedAgentTurn,
    onEvent: (event) => {
      if (event.action === "finished" && event.jobId === job.id) {
        finishedEvent = event;
        finished.resolve();
      }
    },
    ...(recurring
      ? {
          evaluateCronTrigger: async () => ({
            kind: "evaluated" as const,
            fire: true,
            message: "CI passed",
          }),
        }
      : {}),
  });
  context.cron = execution;
  try {
    await execution.start();
    expect(entered).toBe(0);
    const reloaded = expectDefined(execution.getJob(job.id), "reloaded scheduled job");
    if (recurring) {
      // Stored before upgrade: main's hash was captured while enabled, then the runtime disabled it.
      execution.stop();
      await execution.waitForIdle();
      const stored = expectDefined((await fixture.read())[0], "pre-upgrade continuation");
      stored.operatorSource = {
        ...expectDefined(stored.operatorSource, "pre-upgrade source"),
        executionRevision: resolveCronRequesterExecutionRevision(stored),
      };
      await saveCronStore(schedulerState.deps.storePath, { version: 1, jobs: [stored] });
      runOpenClawStateWriteTransaction(({ db }) => {
        updateCronRuntimeRow(
          db,
          cronStoreKey(schedulerState.deps.storePath),
          { ...stored, enabled: false },
          true,
        );
      });
      const disabled = expectDefined((await fixture.read())[0], "runtime-disabled row");
      expect(disabled.enabled).toBe(false);
      expect(disabled.operatorSource).toEqual(stored.operatorSource);
      await execution.start();
      await execution.update(job.id, { enabled: true });
      expect(execution.getJob(job.id)?.operatorSource).toEqual(stored.operatorSource);
    }
    if (scenario === "paused force run") {
      expect(reloaded.enabled).toBe(false);
      await execution.run(job.id, "force");
    } else {
      clock.setTime(expectDefined(execution.getJob(job.id)?.state.nextRunAtMs, "scheduled timer"));
      const tick = onTimer(schedulerState);
      if (queuedEdit) {
        await vi.waitFor(() => {
          expect(execution.getJob(job.id)?.state.runningReceiptId).toEqual(expect.any(String));
        });
        expect(entered).toBe(0);
        if (managerRename) {
          await managerUpdate({ name: "Manager-authored instructions" });
        } else if (captureRace) {
          const update = execution.updateWithPrecondition.bind(execution);
          vi.spyOn(execution, "updateWithPrecondition").mockImplementationOnce(async (...args) => {
            await managerUpdate({
              payload: { kind: "agentTurn", message: "Manager replacement payload" },
            });
            return update(...args);
          });
        }
        updateCreator.resolve();
        await Promise.race([creatorUpdated.promise, expectDefined(creation, "creator turn")]);
        expect(entered).toBe(0);
        releaseCreator.resolve();
        await creation;
        original?.release();
        await creatorCron.waitForIdle();
      }
      if (restarting) {
        await Promise.race([
          restartEntered.promise,
          tick.then(() => {
            throw new Error(
              `Continuation failed before restart: ${execution.getJob(job.id)?.state.lastError}`,
            );
          }),
        ]);
        restartContinue.resolve();
      }
      await tick;
    }
    await finished.promise;
    await execution.waitForIdle();
    if (selfRemoving) {
      expect(execution.getJob(job.id)).toBeUndefined();
      expect(entered).toBe(1);
      if (scenario !== "self removal") {
        expect(finishedEvent).toMatchObject({ status: "error" });
        expect(reads).toBe(2);
        expect(results).toHaveLength(1);
        expect(rejected).toMatch(/abort|authority|source|session/i);
        expect(writes).toEqual([]);
        expect(merged).toBe(false);
        return;
      }
      expect(finishedEvent, finishedEvent?.error).toMatchObject({
        status: "ok",
        completionStatus: "succeeded",
        summary: "Continuation complete",
      });
      expect(rejected).toBeUndefined();
      expect(merged).toBe(true);
      expect(writes).toEqual([{ sha: "a".repeat(40), merge_method: "merge" }]);
      const completed = expectDefined(accessor.loadSessionEntry(target), "completed session");
      expect(completed.status).not.toBe("killed");
      return;
    }
    if (unavailableSource) {
      const pending = expectDefined(execution.getJob(job.id), "same retryable one-shot");
      const next = expectRetryableOriginalOneShot(pending, job.id, clock.clock.now());
      expect(entered).toBe(0);
      expect(writes).toEqual([]);
      expect((await fixture.read()).map((item) => item.id)).toEqual([job.id]);
      expectDefined(restoreIngressOwner, "restored original owner")();
      clock.setTime(next);
      await onTimer(schedulerState);
      await execution.waitForIdle();
      expect((await fixture.read()).map((item) => item.id)).toEqual([job.id]);
    }
    const state = expectDefined(execution.getJob(job.id), "finished scheduled job").state;
    if (personPolicyRemoved) {
      expect(reads, "Current person policy must fence protected RPC reads").toBe(0);
      expect(writes).toEqual([]);
      expect(rejected ?? finishedEvent?.error).toMatch(
        /allow|authority|principal|policy|Person ingress requires trusted-proxy/i,
      );
      expect(entered).toBe(0);
      return;
    }
    if (managerRename || captureRace) {
      expect(admittedOperator).toBe(false);
      expect((await fixture.read())[0]?.operatorSource).toBeUndefined();
    }
    if (queuedEdit || recurring) {
      expect(state.autoDisabled).toBeUndefined();
    }
    if (ownerEdit) {
      expect(state.nextRunAtMs).toBe(clock.clock.now() + 180_000);
      expect(
        resolveCronRequesterExecutionRevision(
          expectDefined(execution.getJob(job.id), "settled next_check"),
        ),
      ).toBe(nextCheckDefinition);
    }
    if (restarting) {
      expect(state.lastRunStatus, state.lastError).toBe("error");
      expect(execution.getJob(job.id)?.enabled).toBe(true);
      expect(state.nextRunAtMs).toEqual(expect.any(Number));
      expect(entered).toBe(1);
      expect(writes).toEqual([]);
      expect(job.operatorSource).toBeDefined();
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
    if (
      roleRevoked ||
      scenario === "session replaced" ||
      scenario === "principal ingress revoked" ||
      scenario === "principal ingress replaced" ||
      scenario === "principal access revoked"
    ) {
      expect(entered).toBe(0);
      expect(state.lastRunStatus, state.lastError).toBe("error");
      expect(state.lastError).toMatch(
        roleRevoked
          ? /operator identity changed/i
          : /authority|source|conversation|session|role|ingress/i,
      );
      if (roleRevoked) {
        expect(execution.getJob(job.id)?.enabled).toBe(false);
        expect(state.nextRunAtMs).toBeUndefined();
        expect(state.consecutiveErrors).toBe(1);
        clock.setTime(clock.clock.now() + 3_600_000);
        await onTimer(schedulerState);
        await execution.waitForIdle();
        expect(execution.getJob(job.id)?.state.consecutiveErrors).toBe(1);
      }
    } else {
      expect(state.lastRunStatus, state.lastError).toBe(
        scenario === "role revoked during merge" ? "error" : "ok",
      );
      expect(entered).toBe(1);
      if (
        unavailableSource ||
        scenario === "restart before scheduling" ||
        scenario === "principal allowlist allowed" ||
        scenario === "principal reload" ||
        scenario === "operator" ||
        scenario === "write-scoped operator" ||
        scenario === "paused force run" ||
        ownerEdit ||
        recurring
      ) {
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
        expect(state.lastError).toBe("Session event execution aborted");
        expect(reads).toBe(2);
        expect(results).toHaveLength(1);
        expect(rejected).toBe("AbortError: Aborted");
        expect(writes).toEqual([]);
      } else if (scenario === "current tool deny") {
        expect(offered).toBeUndefined();
      } else {
        expect(admittedOperator).toBe(scenario === "cron-scoped operator");
        expect(rejected).toContain(
          scopedOperator
            ? "missing scope: operator.write"
            : "require full operator write permission",
        );
        expect(results).toEqual([]);
      }
    }
    if (
      !unavailableSource &&
      scenario !== "restart before scheduling" &&
      scenario !== "principal reload" &&
      scenario !== "principal allowlist allowed" &&
      scenario !== "operator" &&
      scenario !== "write-scoped operator" &&
      scenario !== "paused force run" &&
      !ownerEdit &&
      !recurring &&
      scenario !== "role revoked during merge"
    ) {
      expect(writes).toEqual([]);
      expect(github).not.toHaveBeenCalled();
      expect(receipt).not.toHaveBeenCalled();
    }
    if (recurring) {
      const valid = expectDefined((await fixture.read())[0], "stored continuation");
      for (const failure of ["definition", "decode", "oversized"] as const) {
        execution.stop();
        await execution.waitForIdle();
        const invalid = structuredClone(valid);
        const source = expectDefined(invalid.operatorSource, "stored operator source");
        if (failure === "definition") {
          source.executionRevision = "invalid-definition";
        } else if (failure === "decode") {
          source.source.sourceRunId = "";
        } else {
          source.source.snapshot.aliasBindingIds = Array(256).fill("x".repeat(300));
        }
        await saveCronStore(schedulerState.deps.storePath, { version: 1, jobs: [invalid] });
        await execution.start();
        clock.setTime(
          expectDefined(execution.getJob(job.id)?.state.nextRunAtMs, "next occurrence"),
        );
        await onTimer(schedulerState);
        await execution.waitForIdle();
        expect(execution.getJob(job.id)).toMatchObject({
          enabled: false,
          state: { lastRunStatus: "error", consecutiveErrors: 1 },
        });
        expect(execution.getJob(job.id)?.state.lastError).toContain(
          failure === "definition"
            ? "definition"
            : failure === "decode"
              ? "source is invalid"
              : "exceeds its storage bound",
        );
        expect(execution.getJob(job.id)?.state.nextRunAtMs).toBeUndefined();
        clock.setTime(clock.clock.now() + 3_600_000);
        await onTimer(schedulerState);
        await execution.waitForIdle();
        expect(execution.getJob(job.id)?.state.consecutiveErrors).toBe(1);
        expect(entered).toBe(1);
      }
    }
  } finally {
    updateCreator.resolve();
    releaseCreator.resolve();
    await creation?.catch(() => {});
    original?.release();
    restartContinue.resolve();
    execution.stop();
    await execution.waitForIdle();
    releaseAccessPolicy?.();
    releaseIngressOwner?.();
  }
});
