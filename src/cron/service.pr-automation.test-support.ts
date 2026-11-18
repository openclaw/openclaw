import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { asRecord } from "@openclaw/normalization-core/record-coerce";
import { assert, beforeEach, expect, onTestFinished, vi } from "vitest";
import {
  ciAutomationJobSpec,
  type CiAutomationOption,
  type CiAutomationTarget,
} from "../../ui/src/lib/session-pr-automation-spec.js";
import { resolveAdmittedRunActiveAssertion } from "../agents/admitted-run-context.js";
import { persistAuthProfileBatch } from "../agents/auth-profiles/upsert-with-lock.js";
import type { RunEmbeddedAgentParams } from "../agents/embedded-agent-runner/run/params.js";
import { AUTOMATIONS_TOOL_NAME } from "../agents/tools/automations-tool-name.js";
import { createCronTool } from "../agents/tools/cron-tool.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../agents/tools/gateway-caller-context.js";
import { createGitHubPublishTool } from "../agents/tools/github-publish-tool.js";
import { managedWorktrees } from "../agents/worktrees/service.js";
import {
  git,
  materializeManagedWorktreeFixture,
  useManagedWorktreeTestRepository,
} from "../agents/worktrees/service.test-support.js";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { captureGatewayAuthPolicy } from "../gateway/auth-policy.js";
import { invalidateGatewayDeviceRevocation } from "../gateway/device-revocation.js";
import { NodeRegistry } from "../gateway/node-registry.js";
import { createAdminMemberRoleConfig } from "../gateway/operator-role.test-support.js";
import { captureGatewayOperatorRunAuthority } from "../gateway/operator-run-authority.js";
import { pairedOperator, persistDevices } from "../gateway/operator-run-recovery.test-support.js";
import { createScheduledGatewayRunner } from "../gateway/scheduled-run-gateway-context.js";
import { cronHandlers } from "../gateway/server-methods/cron.js";
import {
  SESSION,
  SESSION_ID,
  stateDir,
  createCronFixture,
  installRequesterCronAuthorityTestHooks,
  admission,
  inRun,
  createCreatorTransportTools,
} from "../gateway/server-methods/requester-cron-authority.test-support.js";
import { createOperatorClient } from "../gateway/server-plugin-in-process-dispatch.test-support.js";
import { createSyntheticPluginRuntimeClient } from "../gateway/server-plugin-runtime-client.js";
import { dispatchProfile } from "../gateway/server/client-fixtures.test-support.js";
import {
  createDispatchTestHarness,
  createOperatorWsClient,
} from "../gateway/server/ws-connection/authenticated-request-dispatch.test-support.js";
import { prepareGatewayConnectOperatorAccess } from "../gateway/server/ws-connection/connect-operator-access.js";
import { resolveAuthenticatedDeviceTokenIdentity } from "../infra/device-pairing-identity.js";
import {
  bindLegacyPluginSdkResourceHost,
  LegacyPluginSdkResourceHost,
} from "../plugins/legacy-sdk-resource-host.js";
import {
  bindGatewayContextResolver,
  clearGatewayContextResolver,
  withPluginRuntimeGatewayRequestScope,
} from "../plugins/runtime/gateway-request-scope.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { prepareUserProfileCatalog } from "../state/user-profile-list.js";
import {
  setCanonicalUserProfileRole,
  syncCanonicalGitHubIdentity,
} from "../state/user-profile-writes.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { resolveCronJobConfigRevision } from "./config-revision.js";
import {
  ensureAgentWorkspaceMock,
  loadRunCronIsolatedAgentTurn,
  loadSessionEntryMock,
  mockRunCronFallbackPassthrough,
  patchSessionEntryMock,
  resetRunCronIsolatedAgentTurnHarness,
  resolveCronDeliveryPlanMock,
  resolveCronSessionMock,
  runEmbeddedAgentMock,
} from "./isolated-agent/run.test-harness.js";
import { readCronRunHistoryPageForTests } from "./run-history.test-support.js";
import { cronTestDeps } from "./service.fixture-builders.test-support.js";
import type { CronEvent } from "./service.js";
import { createNativeGitHubReadFixture } from "./service.pr-automation-github.test-support.js";
import { createCronServiceWithStateForTest } from "./service.test-harness.js";
import { resolveCronOperatorExecutionRevision } from "./service/jobs-tool-policy.js";
import { onTimer } from "./service/timer.test-support.js";
import { runCronSessionTurn } from "./session-run.js";
import { resolveCronSessionTargetSessionKey } from "./session-target.js";
import { loadCronJobsStore, saveCronJobsStore } from "./store.js";
import { cronStoreKey } from "./store/key.js";
import { maintainCronRunHistory } from "./store/run-history.js";
import { createCronScriptRuntime } from "./trigger-script.js";

const sessionRunner = vi.hoisted(() => ({
  runEmbedded: vi.fn<typeof import("../agents/embedded-agent-runner/run.js").runEmbeddedAgent>(),
}));
const publicationCommandMocks = vi.hoisted(() => ({
  run: vi.fn<typeof import("../process/exec.js").runCommandBuffered>(),
}));
// Use the publication harness's subprocess boundary: exported transport spies
// cannot replace module-local references used by the native command runner.
vi.mock("../process/exec.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../process/exec.js")>()),
  runCommandBuffered: publicationCommandMocks.run,
}));
// mock-isolation: Both recipe runners share the synthetic model; controller and effects stay real.
vi.mock("../agents/embedded-agent-runner/run.js", () => ({
  runEmbeddedAgent: sessionRunner.runEmbedded,
}));

export const publicationCommands = publicationCommandMocks;
const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();
await Promise.all([
  import("../auto-reply/dispatch.js"),
  import("../auto-reply/reply/get-reply-from-config.runtime.js").then((runtime) =>
    runtime.prewarmConfigDrivenReplyRuntime(),
  ),
]);
const { resolveAgentDir } = await import("./isolated-agent/run.runtime.js");
const session = await vi.importActual<typeof import("./isolated-agent/session.js")>(
  "./isolated-agent/session.js",
);
const sessionEventTarget = await import("../auto-reply/reply/session-event-target.js");
const actualSessionEventTarget = await vi.importActual<typeof sessionEventTarget>(
  "../auto-reply/reply/session-event-target.js",
);
export const accessor = await vi.importActual<
  typeof import("../config/sessions/session-accessor.js")
>("../config/sessions/session-accessor.js");
const addCron = expectDefined(cronHandlers["cron.add"], "cron.add");
export const replacementSession = "replacement-session";
export const agentResult = () => ({
  payloads: [{ text: "Synthetic request settled" }],
  meta: { agentMeta: {} },
});
installRequesterCronAuthorityTestHooks();
const createRepo = useManagedWorktreeTestRepository();
export const localCommands =
  await vi.importActual<typeof import("../process/exec.js")>("../process/exec.js");
beforeEach(() => {
  publicationCommands.run.mockImplementation(localCommands.runCommandBuffered);
  resetRunCronIsolatedAgentTurnHarness();
  // The isolated-model harness normally substitutes a target. This suite proves real source admission.
  vi.mocked(sessionEventTarget.captureSessionEventTargetForHost).mockImplementation(
    actualSessionEventTarget.captureSessionEventTargetForHost,
  );
  vi.mocked(sessionEventTarget.assertSessionEventTargetCurrent).mockImplementation(
    actualSessionEventTarget.assertSessionEventTargetCurrent,
  );
  vi.mocked(sessionEventTarget.prepareSessionEventTargetForHost).mockImplementation(
    actualSessionEventTarget.prepareSessionEventTargetForHost,
  );
  vi.stubEnv("OPENCLAW_TEST_FAST", "1");
  resolveCronSessionMock.mockImplementation(session.prepareCronSession);
  loadSessionEntryMock.mockImplementation(session.loadCronSessionEntryLatest);
  patchSessionEntryMock.mockImplementation(accessor.patchSessionEntryCore);
  ensureAgentWorkspaceMock.mockImplementation(async ({ dir }: { dir: string }) => ({ dir }));
  resolveCronDeliveryPlanMock.mockReturnValue({ requested: false, mode: "none" });
  mockRunCronFallbackPassthrough();
  sessionRunner.runEmbedded
    .mockReset()
    .mockImplementation((params) => runEmbeddedAgentMock(params));
});

// Synthetic model: transports recipe targets; does not prove autonomous merging.
export function readRecipeTarget(prompt: string) {
  const line = expectDefined(
    prompt.split("\n").find((value) => value.includes("for this exact target: ")),
    "recipe target line",
  );
  const { owner, repo, number, sessionKey, sessionId } = asRecord(
    JSON.parse(line.slice(line.indexOf("{"), line.lastIndexOf("}") + 1)),
  );
  assert(typeof owner === "string", "Scheduled recipe lost its PR target");
  assert(typeof repo === "string", "Scheduled recipe lost its PR target");
  assert(typeof number === "number", "Scheduled recipe lost its PR target");
  assert(typeof sessionKey === "string", "Scheduled recipe lost its PR target");
  return {
    owner,
    repo,
    number,
    sessionKey,
    sessionId: typeof sessionId === "string" ? sessionId : undefined,
  };
}

export async function createFixture(
  option: CiAutomationOption,
  authenticated = true,
  legacy = false,
  direct = false,
  messageOverride?: string,
) {
  const repoRoot = await createRepo(path.join(stateDir, "source"));
  const repositoryIdentity = await managedWorktrees.resolveRepositoryIdentity(repoRoot);
  const worktree = await materializeManagedWorktreeFixture({
    env: process.env,
    repoRoot,
    repoFingerprint: repositoryIdentity.fingerprint,
    stateDir,
    name: "recipe",
    ownerKind: "session",
    ownerId: SESSION,
    now: Date.now(),
  });
  const workspaceDir = worktree.path;
  const github = createNativeGitHubReadFixture(
    worktree.branch,
    await git(workspaceDir, "rev-parse", "HEAD"),
  );
  const { pr } = github;
  const bindingSide = ({ repo, ref, sha }: typeof pr.head) => ({
    repository: repo.full_name,
    repositoryId: repo.id,
    branch: ref,
    commit: sha,
  });
  const config: OpenClawConfig = {
    gateway: direct ? createAdminMemberRoleConfig().gateway : undefined,
    agents: {
      defaults: { skipBootstrap: true, workspace: workspaceDir, model: "openai/gpt-4.1" },
      entries: { main: { workspace: workspaceDir } },
    },
    plugins: { enabled: false },
    tools: { allow: [AUTOMATIONS_TOOL_NAME] },
  };
  await persistAuthProfileBatch({
    stateDir,
    profiles: [
      {
        profileId: "openai:recipe-fixture",
        credential: { type: "api_key", provider: "openai", key: "synthetic-recipe-inference-key" },
      },
    ],
  });
  vi.mocked(resolveAgentDir).mockReturnValue(path.join(stateDir, "agents", "main", "agent"));
  setRuntimeConfigSnapshot(config);
  const sessionRef = { agentId: "main", sessionKey: SESSION };
  const seed = (sessionId: string) =>
    accessor.replaceSessionEntry(sessionRef, {
      sessionId,
      lifecycleRevision: sessionId === SESSION_ID ? "original" : "replacement",
      updatedAt: Date.now(),
      sessionStartedAt: Date.now(),
      lastInteractionAt: Date.now(),
      worktree: {
        id: worktree.id,
        branch: worktree.branch,
        repoRoot: worktree.repoRoot,
        canonicalWorkspaceDir: workspaceDir,
        githubPullRequest: {
          url: pr.html_url,
          host: "github.com",
          preparedHeadCommit: pr.head.sha,
          number: 41,
          base: bindingSide(pr.base),
          head: bindingSide(pr.head),
        },
      },
    });
  await seed(SESSION_ID);
  const creator = createCronFixture(undefined, config);
  creator.context.resolveGatewayContext = () => creator.context;
  const sdkResources = new LegacyPluginSdkResourceHost();
  bindLegacyPluginSdkResourceHost(creator.context.resolveGatewayContext, sdkResources);
  onTestFinished(() => sdkResources.close());
  const profile = authenticated ? ensureProfileForEmail("recipe-operator@example.test") : undefined;
  const client = Object.assign(
    createOperatorWsClient(),
    profile
      ? createOperatorClient({
          profileId: profile.id,
          scopes: direct ? ["operator.admin"] : ["operator.write", "operator.cron"],
        })
      : createSyntheticPluginRuntimeClient({ scopes: ["operator.admin"] }),
  );
  if (profile) {
    client.internal = { authenticatedOperator: true };
    client.authPolicy = captureGatewayAuthPolicy(config, { role: "operator", authMethod: "token" });
    await syncCanonicalGitHubIdentity({
      identity: { accountId: 42, login: "publisher" },
      authenticationAlias: { kind: "email", email: "recipe-operator@example.test" },
    });
  }
  const device = pairedOperator();
  if (direct && profile) {
    persistDevices(stateDir, [device], "both");
    client.connect.client.id = "openclaw-control-ui";
    client.connect.client.mode = "webchat";
    client.authenticatedUserProfile = dispatchProfile(profile.id);
    client.connectionSignal = new AbortController().signal;
    client.isDeviceTokenAuth = true;
    client.authPolicy = captureGatewayAuthPolicy(config, {
      role: "operator",
      authMethod: "device-token",
    });
    client.internal = {
      authenticatedOperator: true,
      authenticatedControlUi: true,
      operatorRoleActor: { kind: "operator", profileId: profile.id },
      operatorDeviceTokenIdentity: expectDefined(
        resolveAuthenticatedDeviceTokenIdentity(device, {
          role: "operator",
          publicKey: device.publicKey,
          token: expectDefined(device.tokens?.operator, "paired token").token,
          scopes: client.connect.scopes ?? [],
        }),
        "accepted handshake token",
      ),
    };
    client.connect.device = {
      id: device.deviceId,
      publicKey: device.publicKey,
      signature: "synthetic",
      signedAt: 1,
      nonce: "synthetic",
    };
    await setCanonicalUserProfileRole(profile.id, "admin");
    await prepareUserProfileCatalog();
    prepareGatewayConnectOperatorAccess(client);
  }
  creator.context.nodeRegistry = new NodeRegistry();
  creator.context.invalidateClientsForDevice = (deviceId, options) => {
    invalidateGatewayDeviceRevocation(creator.context, deviceId, options?.role);
    if (deviceId === client.connect.device?.id) {
      client.invalidated = true;
    }
  };
  const dispatch = createDispatchTestHarness({ buildRequestContext: () => creator.context });
  const original =
    profile && !direct
      ? expectDefined(
          await captureGatewayOperatorRunAuthority({
            client,
            context: creator.context,
            sourceAuthority: null,
          }),
          "authenticated creator",
        )
      : undefined;
  onTestFinished(() => original?.release());
  const target: CiAutomationTarget = {
    agentId: "main",
    sessionKey: SESSION,
    sessionId: SESSION_ID,
    owner: "fixture-org",
    repo: "fixture-repo",
    number: 41,
  };
  const rpc = (method: string, params: Record<string, unknown>) => ({
    req: { type: "req" as const, id: method, method, params },
    params,
    context: creator.context,
    client,
    isWebchatConnect: () => false,
  });
  let requestSequence = 0;
  const requestFromUi = async (method: string, params: Record<string, unknown>) => {
    const id = `${method}-${++requestSequence}`;
    await dispatch.dispatcher.dispatch({ type: "req", id, method, params }, client);
    // A revoked browser receives no further frame; dispatch completion still joins its work.
    return asRecord(dispatch.send.mock.calls.find(([frame]) => asRecord(frame).id === id)?.[0]);
  };
  const add = async (selected: CiAutomationTarget) => {
    const definition = {
      ...ciAutomationJobSpec(selected, option),
      enabled: false,
      ...(legacy ? { trigger: undefined } : {}),
      ...(messageOverride
        ? { payload: { kind: "agentTurn" as const, message: messageOverride } }
        : {}),
    };
    if (direct) {
      expect(await requestFromUi("cron.add", definition)).toMatchObject({ ok: true });
    } else if (original) {
      const runId = `recipe-creator-${selected.number}`;
      const captured = expectDefined(admission(runId, client), "creator admission");
      await withPluginRuntimeGatewayRequestScope(
        { client, context: creator.context, isWebchatConnect: () => false },
        () =>
          inRun(
            runId,
            captured,
            async (_identity, admitted, creatorAuthority) => {
              bindGatewayContextResolver(admitted, () => creator.context);
              try {
                const tools = await createCreatorTransportTools({
                  transport: "embedded",
                  config,
                  admitted,
                  creator: creatorAuthority,
                  senderIsOwner: false,
                  workspaceDir,
                });
                const result = await tools.invoke(AUTOMATIONS_TOOL_NAME, {
                  action: "add",
                  job: definition,
                });
                expect(result).toHaveProperty("details.job.id");
              } finally {
                clearGatewayContextResolver(admitted);
              }
            },
            original.authority,
          ),
      );
    } else {
      const respond = vi.fn();
      await addCron({ ...rpc("cron.add", definition), respond });
      expect(respond).toHaveBeenCalledWith(true, expect.anything(), undefined);
    }
    return expectDefined(
      (await creator.read()).find((job) => job.declarationKey === definition.declarationKey),
      "persisted recipe",
    );
  };
  const selected = await add(target);
  if (authenticated) {
    expect(selected.operatorSource?.source.snapshot.profileId).toBe(profile?.id);
    expect(selected.operatorSource?.executionRevision).toBe(
      resolveCronOperatorExecutionRevision(selected),
    );
    expect(creator.context.resolveGatewayContext?.()).toBe(creator.context);
    if (!direct) {
      expect(selected.operatorSource?.source).toMatchObject({
        sessionId: SESSION_ID,
        lifecycleRevision: "original",
      });
    }
  }
  const other = await add({ ...target, number: 42 });
  expect(other.id).not.toBe(selected.id);
  if (legacy && direct) {
    // Model a historical row before source capture existed, persisted before a fresh scheduler loads.
    const store = await loadCronJobsStore(creator.context.cronStorePath);
    for (const job of store.jobs) {
      delete job.operatorSource;
    }
    await saveCronJobsStore(creator.context.cronStorePath, store);
  }
  const wallNow = Date.now.bind(Date);
  const clock = createGatewaySchedulerClock(Date.now());
  const now = vi.spyOn(Date, "now").mockImplementation(clock.clock.now);
  onTestFinished(() => now.mockRestore());
  const scheduler = createTestGatewayScheduler(clock.clock);
  sdkResources.bindScheduler(scheduler);
  let finished = createDeferredCore<CronEvent>();
  let lastFinished: CronEvent | undefined;
  const work = new AsyncWorkScope();
  const { cron: execution, state: executionState } = createCronServiceWithStateForTest(
    cronTestDeps({
      scheduler,
      nowMs: clock.clock.now,
      storePath: path.join(stateDir, "cron", "jobs.json"),
      defaultAgentId: "main",
      runSchedulerOwned: createScheduledGatewayRunner(creator.context.resolveGatewayContext),
      evaluateCronTrigger: createCronScriptRuntime({
        config,
        resolveGatewayContext: creator.context.resolveGatewayContext,
        prepareRuntime: async () => ({
          createTools: async () => [],
          context: {
            config,
            agentId: "main",
            sessionKey: `agent:main:cron:trigger`,
            cwd: stateDir,
            workspaceDir: stateDir,
          },
          scheduledToolPolicy: undefined,
        }),
      }).evaluateTrigger,
      onEvent: (event) => {
        if (event.action === "finished") {
          lastFinished = event;
          finished.resolve(event);
        }
      },
      runSessionEvent: (request) =>
        work.track(() =>
          runCronSessionTurn({
            ...request,
            cfg: config,
            agentId: "main",
            sessionKey: expectDefined(
              resolveCronSessionTargetSessionKey(request.job.sessionTarget),
              "explicit recipe session target",
            ),
          }),
        ),
      runIsolatedAgentJob: (request) =>
        work.track(() =>
          runCronIsolatedAgentTurn({
            ...request,
            cfg: config,
            deps: {},
            agentId: "main",
            sessionKey: `cron:${request.job.id}`,
          }),
        ),
    }),
  );
  // The executing scheduler must reload cron.add's persisted state.
  await execution.start();
  creator.context.cron = execution;
  expect((await execution.list({ includeDisabled: true })).map((job) => job.id).toSorted()).toEqual(
    [selected.id, other.id].toSorted(),
  );
  const tick = async (waitForCore = true) => {
    finished = createDeferredCore<CronEvent>();
    lastFinished = undefined;
    const due = (await execution.list({ includeDisabled: false }))
      .map((job) => job.state.nextRunAtMs)
      .filter((at): at is number => at !== undefined);
    clock.setTime(Math.max(clock.clock.now() + 300_000, ...due));
    const core = work.track(() => onTimer(executionState));
    void core.catch((error: unknown) => finished.reject(error));
    if (waitForCore) {
      await core;
      await AsyncWorkScope.runWhenAllIdle(
        () => [work],
        () => {},
      );
      // fire:false is intentionally quiet: its committed evaluation has no finished event.
      return lastFinished;
    }
    return await finished.promise;
  };
  const stop = async () => {
    execution.stop();
    await execution.waitForIdle();
    // Cancellation publishes its result before the core finishes touching session state.
    await work.drain();
  };
  return {
    creator,
    workspaceDir,
    profile,
    deviceId: device.deviceId,
    ...github,
    rpc,
    requestFromUi,
    updateFromUi: async (enabled: boolean) =>
      expect(
        await requestFromUi("cron.update", {
          id: selected.id,
          expectedConfigRevision: resolveCronJobConfigRevision(
            expectDefined(execution.getJob(selected.id), "current job"),
          ),
          patch: {
            enabled,
            ...(enabled ? { trigger: ciAutomationJobSpec(target, option).trigger } : {}),
          },
        }),
      ).toMatchObject({ ok: true }),
    sessionRef,
    target,
    add,
    selected,
    triggerState: () => execution.getJob(selected.id)?.state.triggerState,
    other,
    execution,
    seed,
    tick,
    issueComments: (count: number, item: (index: number) => Partial<typeof github.finding>) => {
      github.thread.isResolved = true;
      const comments = Array.from({ length: count }, (_, index) => ({
        ...github.finding,
        ...item(index),
      }));
      github.graph.comments = github.connection(comments);
      return comments;
    },
    runHistory: (runId?: string) =>
      readCronRunHistoryPageForTests({
        storeKey: cronStoreKey(path.join(stateDir, "cron", "jobs.json")),
        jobId: selected.id,
        runId,
      }).entries,
    expireRunHistory: async () => {
      execution.stop();
      await execution.waitForIdle();
      clock.setTime(clock.clock.now() + 8 * 24 * 60 * 60_000);
      const context = captureOpenClawStateWorkerContext();
      await maintainCronRunHistory(context, context.admission.assertCurrent);
    },
    expectSuccessfulTicks: async (count: number, inspect?: () => boolean | void) => {
      for (let index = 0; index < count; index++) {
        const event = await tick();
        if (event) {
          expect(event.status, event.error).toBe("ok");
        }
        const job = expectDefined(execution.getJob(selected.id), "operational job");
        expect(Buffer.byteLength(JSON.stringify(job.state.triggerState))).toBeLessThanOrEqual(
          14 * 1024,
        );
        if (inspect?.() === false) {
          break;
        }
      }
    },
    expectQuietTicks: async (count: number) => {
      for (let index = 0; index < count; index++) {
        expect(await tick()).toBeUndefined();
      }
    },
    advanceTime: (ms: number) => clock.setTime(clock.clock.now() + ms),
    withWallClock: async <T>(run: () => Promise<T>) => {
      let value!: T;
      await now.withImplementation(wallNow, async () => {
        value = await run();
      });
      return value;
    },
    stop,
    revokeDevice: () => persistDevices(stateDir, [], "both"),
    modelTools: async <T>(
      params: RunEmbeddedAgentParams,
      run: (tools: {
        automation: ReturnType<typeof createCronTool>;
        publication: ReturnType<typeof createGitHubPublishTool>;
      }) => Promise<T>,
    ) => {
      const admitted = await expectDefined(
        params.preparedRunAdmission,
        "scheduled admission",
      ).admit("gateway", params.runId);
      expectDefined(resolveAdmittedRunActiveAssertion(admitted), "active admission assertion")();
      params.onExecutionPhase?.({ phase: "model_call_started" });
      await params.onExecutionStarted?.();
      await params.onAgentEvent?.({ stream: "lifecycle", data: { phase: "start" } });
      bindGatewayContextResolver(admitted, () => creator.context);
      const caller = expectDefined(
        createAdmittedGatewayToolCallerIdentity({
          admittedRunContext: admitted,
          agentId: "main",
          sessionKey: SESSION,
        }),
        "native caller",
      );
      return await withGatewayToolCallerIdentity(caller, () =>
        run({
          automation: createCronTool({
            config,
            agentSessionKey: SESSION,
            agentId: "main",
            runId: params.runId,
            selfRemoveOnlyJobId: selected.id,
          }),
          publication: createGitHubPublishTool(),
        }),
      );
    },
    [Symbol.asyncDispose]: stop,
  };
}

export function readObservation(prompt: string) {
  const line = expectDefined(
    prompt.split("\n").find((candidate) => candidate.startsWith('{"head":')),
    "native observation",
  );
  return JSON.parse(line) as {
    head: string;
    fingerprint: string;
    findings: { id: string; revision: string; body: string }[];
    previewIncomplete: boolean;
  };
}

export function collectFindingIds(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  seen: string[] | undefined,
  inspect?: (
    observation: ReturnType<typeof readObservation>,
    automation: ReturnType<typeof createCronTool>,
  ) => void | Promise<void>,
) {
  runEmbeddedAgentMock.mockImplementation((params) =>
    fixture.modelTools(params, async ({ automation }) => {
      const observation = readObservation(params.prompt);
      seen?.push(...observation.findings.map((finding) => finding.id));
      await inspect?.(observation, automation);
      return agentResult();
    }),
  );
}

export async function recordJudgment({
  automation,
  summary,
  ...prAutoFix
}: Record<string, unknown> & {
  automation: ReturnType<typeof createCronTool>;
  summary: string;
}) {
  const scratch = await automation.execute("judgment-read", { action: "scratch_get" });
  await automation.execute("judgment-write", {
    action: "scratch_set",
    expectedRevision: asRecord(scratch.details).currentRevision,
    content: JSON.stringify({ prAutoFix }),
  });
  await automation.execute("judgment-outcome", {
    action: "record_result",
    outcome: "done",
    summary,
  });
}
