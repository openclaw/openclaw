import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { asRecord } from "@openclaw/normalization-core/record-coerce";
import { beforeEach, expect, onTestFinished, vi } from "vitest";
import {
  ciAutomationJobSpec,
  type CiAutomationOption,
  type CiAutomationTarget,
} from "../../ui/src/lib/session-pr-automation-spec.js";
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
  materializeManagedWorktreeFixture,
  useManagedWorktreeTestRepository,
} from "../agents/worktrees/service.test-support.js";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import { captureGatewayAuthPolicy } from "../gateway/auth-policy.js";
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
import { syncCanonicalGitHubIdentity } from "../state/user-profile-writes.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
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
import { cronTestDeps } from "./service.fixture-builders.test-support.js";
import type { CronEvent } from "./service.js";
import { createNativeGitHubReadFixture } from "./service.pr-automation-github.test-support.js";
import { createCronServiceWithStateForTest } from "./service.test-harness.js";
import { resolveCronOperatorExecutionRevision } from "./service/jobs-tool-policy.js";
import { onTimer } from "./service/timer.test-support.js";
import { runCronSessionTurn } from "./session-run.js";
import { resolveCronSessionTargetSessionKey } from "./session-target.js";
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
  const target = asRecord(JSON.parse(line.slice(line.indexOf("{"), line.lastIndexOf("}") + 1)));
  if (
    typeof target.owner !== "string" ||
    typeof target.repo !== "string" ||
    typeof target.number !== "number" ||
    typeof target.sessionKey !== "string"
  ) {
    throw new Error("Scheduled recipe lost its PR target");
  }
  return {
    owner: target.owner,
    repo: target.repo,
    number: target.number,
    sessionKey: target.sessionKey,
    sessionId: typeof target.sessionId === "string" ? target.sessionId : undefined,
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
  const {
    repository,
    pr,
    graph,
    finding,
    thread,
    reads,
    connection,
    nativeRead,
    identity,
    failRead,
  } = createNativeGitHubReadFixture(worktree.branch);
  const config = {
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
          number: 41,
          base: {
            repository: repository.full_name,
            repositoryId: repository.id,
            branch: "main",
            commit: pr.base.sha,
          },
          head: {
            repository: repository.full_name,
            repositoryId: repository.id,
            branch: worktree.branch,
            commit: pr.head.sha,
          },
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
      ? createOperatorClient({ profileId: profile.id, scopes: ["operator.write", "operator.cron"] })
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
    const browser = createOperatorWsClient({
      clientInfo: { id: "openclaw-control-ui", mode: "webchat" },
      // The direct CI toggle uses cron.add’s existing administration gate.
      scopes: ["operator.admin"],
    });
    Object.assign(client, browser);
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
    prepareGatewayConnectOperatorAccess(client);
  }
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
      const id = `direct-create-${selected.number}`;
      await dispatch.dispatcher.dispatch(
        { type: "req", id, method: "cron.add", params: definition },
        client,
      );
      const response = await dispatch.awaitResponseFrame(id);
      expect(response, JSON.stringify(response)).toMatchObject({ ok: true });
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
    config,
    workspaceDir,
    profile,
    pr,
    graph,
    finding,
    thread,
    reads,
    connection,
    nativeRead,
    identity,
    failRead,
    rpc,
    sessionRef,
    target,
    add,
    selected,
    other,
    execution,
    seed,
    tick,
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
