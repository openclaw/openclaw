import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { asRecord } from "@openclaw/normalization-core/record-coerce";
import { beforeEach, expect, it, vi } from "vitest";
import {
  ciAutomationJobSpec,
  type CiAutomationOption,
  type CiAutomationTarget,
} from "../../ui/src/lib/session-pr-automation-spec.js";
import { resolveAdmittedRunActiveAssertion } from "../agents/admitted-run-context.js";
import { persistAuthProfileBatch } from "../agents/auth-profiles/upsert-with-lock.js";
import type { RunEmbeddedAgentParams } from "../agents/embedded-agent-runner/run/params.js";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import { cronHandlers } from "../gateway/server-methods/cron.js";
import {
  SESSION,
  SESSION_ID,
  stateDir,
  createCronFixture,
  installRequesterCronAuthorityTestHooks,
} from "../gateway/server-methods/requester-cron-authority.test-support.js";
import { sessionMutationHandlers } from "../gateway/server-methods/sessions-mutations.js";
import { createSyntheticPluginRuntimeClient } from "../gateway/server-plugin-runtime-client.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
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
import { createCronServiceWithStateForTest } from "./service.test-harness.js";
import { onTimer } from "./service/timer.test-support.js";
import { runCronSessionTurn } from "./session-run.js";
import { resolveCronSessionTargetSessionKey } from "./session-target.js";

const sessionRunner = vi.hoisted(() => ({
  runEmbedded: vi.fn<typeof import("../agents/embedded-agent-runner/run.js").runEmbeddedAgent>(),
}));
// mock-isolation: Both recipe runners share the synthetic model; controller and effects stay real.
vi.mock("../agents/embedded-agent-runner/run.js", () => ({
  runEmbeddedAgent: sessionRunner.runEmbedded,
}));

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
const accessor = await vi.importActual<typeof import("../config/sessions/session-accessor.js")>(
  "../config/sessions/session-accessor.js",
);
const addCron = expectDefined(cronHandlers["cron.add"], "cron.add");
const patchSession = expectDefined(sessionMutationHandlers["sessions.patch"], "sessions.patch");
const replacementSession = "replacement-session";
const agentResult = () => ({
  payloads: [{ text: "Synthetic request settled" }],
  meta: { agentMeta: {} },
});
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
  sessionRunner.runEmbedded
    .mockReset()
    .mockImplementation((params) => runEmbeddedAgentMock(params));
});

// Synthetic model: transports recipe targets; does not prove autonomous merging.
function readRecipeTarget(prompt: string) {
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

async function createFixture(option: CiAutomationOption) {
  const config = {
    agents: {
      defaults: { skipBootstrap: true, workspace: stateDir, model: "openai/gpt-4.1" },
      entries: { main: { workspace: stateDir } },
    },
    plugins: { enabled: false },
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
      updatedAt: Date.now(),
      sessionStartedAt: Date.now(),
      lastInteractionAt: Date.now(),
    });
  await seed(SESSION_ID);
  const creator = createCronFixture(undefined, config);
  const client = createSyntheticPluginRuntimeClient({ scopes: ["operator.admin"] });
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
    const definition = { ...ciAutomationJobSpec(selected, option), enabled: false };
    const respond = vi.fn();
    await addCron({ ...rpc("cron.add", definition), respond });
    expect(respond).toHaveBeenCalledWith(true, expect.anything(), undefined);
    return expectDefined(
      (await creator.read()).find((job) => job.declarationKey === definition.declarationKey),
      "persisted recipe",
    );
  };
  const selected = await add(target);
  const other = await add({ ...target, number: 42 });
  expect(other.id).not.toBe(selected.id);
  const clock = createGatewaySchedulerClock(Date.now());
  let finished = createDeferredCore<CronEvent>();
  const work = new AsyncWorkScope();
  const { cron: execution, state: executionState } = createCronServiceWithStateForTest(
    cronTestDeps({
      scheduler: createTestGatewayScheduler(clock.clock),
      nowMs: clock.clock.now,
      storePath: path.join(stateDir, "cron", "jobs.json"),
      defaultAgentId: "main",
      onEvent: (event) => {
        if (event.action === "finished") {
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
  expect((await execution.list({ includeDisabled: true })).map((job) => job.id).toSorted()).toEqual(
    [selected.id, other.id].toSorted(),
  );
  const tick = async () => {
    finished = createDeferredCore<CronEvent>();
    await clock.advanceBy(300_000);
    void work
      .track(() => onTimer(executionState))
      .catch((error: unknown) => finished.reject(error));
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
    rpc,
    sessionRef,
    target,
    add,
    selected,
    other,
    execution,
    seed,
    tick,
    stop,
    [Symbol.asyncDispose]: stop,
  };
}

it("transports autoFix for only the selected PR across session replacement and disables future effects", async () => {
  await using fixture = await createFixture("autoFix");
  const effectTarget = (number: number) => ({ owner: "fixture-org", repo: "fixture-repo", number });
  const effect41 = effectTarget(41);
  const finalEffect =
    vi.fn<(target: { owner: string; repo: string; number: number }, sessionId: string) => void>();
  runEmbeddedAgentMock.mockImplementation(async (params: RunEmbeddedAgentParams) => {
    const admitted = await expectDefined(params.preparedRunAdmission, "scheduled admission").admit(
      "gateway",
      params.runId,
    );
    expectDefined(resolveAdmittedRunActiveAssertion(admitted), "active admission assertion")();
    params.onExecutionPhase?.({ phase: "model_call_started" });
    await params.onExecutionStarted?.();
    await params.onAgentEvent?.({ stream: "lifecycle", data: { phase: "start" } });
    const target = readRecipeTarget(params.prompt);
    finalEffect(
      { owner: target.owner, repo: target.repo, number: target.number },
      params.sessionId,
    );
    return agentResult();
  });
  await fixture.execution.update(fixture.selected.id, { enabled: true });
  expect(await fixture.tick()).toMatchObject({ jobId: fixture.selected.id, status: "ok" });
  expect(finalEffect.mock.calls).toEqual([[effect41, SESSION_ID]]);
  await fixture.seed(replacementSession);
  expect(await fixture.tick()).toMatchObject({ jobId: fixture.selected.id, status: "ok" });
  expect(finalEffect.mock.calls[1]).toEqual([effect41, replacementSession]);
  await fixture.execution.update(fixture.selected.id, { enabled: false });
  await fixture.execution.update(fixture.other.id, { enabled: true });
  expect(await fixture.tick()).toMatchObject({ jobId: fixture.other.id, status: "ok" });
  expect(finalEffect.mock.calls).toEqual([
    [effect41, SESSION_ID],
    [effect41, replacementSession],
    [effectTarget(42), replacementSession],
  ]);
  expect(fixture.execution.getJob(fixture.selected.id)?.enabled).toBe(false);
  expect((await fixture.add({ ...fixture.target, sessionId: replacementSession })).id).toBe(
    fixture.selected.id,
  );
});

it.each([false, true])(
  "existing archive API checks the scheduled recipe's exact identity (replaced=%s)",
  async (replaced) => {
    const fixture = await createFixture("autoArchive");
    const respond = vi.fn();
    const releaseCore = createDeferredCore();
    const releaseArchiveEffects = createDeferredCore();
    const cron = fixture.creator.context.cron;
    const updateWithPrecondition = cron.updateWithPrecondition.bind(cron);
    const archiveUpdate = !replaced
      ? vi.spyOn(cron, "updateWithPrecondition").mockImplementation(async (...args) => {
          const result = await updateWithPrecondition(...args);
          // Hold the archive handler after the real worker commit and cancellation.
          await releaseArchiveEffects.promise;
          return result;
        })
      : undefined;
    let archiveRequest: Promise<void> | undefined;
    runEmbeddedAgentMock.mockImplementation(async (params: RunEmbeddedAgentParams) => {
      const target = readRecipeTarget(params.prompt);
      const patch = {
        key: target.sessionKey,
        expectedSessionId: expectDefined(target.sessionId, "archive incarnation"),
        archived: true,
      };
      archiveRequest = Promise.resolve(
        patchSession({ ...fixture.rpc("sessions.patch", patch), respond }),
      );
      await archiveRequest;
      if (!replaced) {
        await releaseCore.promise;
      }
      return agentResult();
    });
    try {
      if (replaced) {
        await fixture.seed(replacementSession);
      }
      await fixture.execution.update(fixture.selected.id, { enabled: true });
      const event = await fixture.tick();
      releaseArchiveEffects.resolve();
      // Archive commits before cancellation settles the occurrence and RPC.
      expect(event).toMatchObject({
        jobId: fixture.selected.id,
        ...(replaced
          ? { status: "ok" }
          : { status: "error", error: "Cron job disabled by operator." }),
      });
      expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
      await expectDefined(archiveRequest, "archive request");
      const stored = accessor.loadSessionEntry(fixture.sessionRef);
      if (replaced) {
        expect(respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({ details: { reason: "session-changed" } }),
        );
        expect(stored).toMatchObject({ sessionId: replacementSession });
        expect(stored?.archivedAt).toBeUndefined();
      } else {
        expect(respond).toHaveBeenCalledWith(true, expect.anything(), undefined);
        expect(stored).toMatchObject({ sessionId: SESSION_ID, archivedAt: expect.any(Number) });
        const stopped = vi.fn();
        const teardown = fixture.stop().then(stopped);
        // Keep the core held across a worker round-trip before checking teardown.
        expect((await fixture.creator.read()).every((job) => !job.enabled)).toBe(true);
        expect(stopped).not.toHaveBeenCalled();
        releaseCore.resolve();
        await teardown;
        expect(stopped).toHaveBeenCalledOnce();
      }
    } finally {
      releaseArchiveEffects.resolve();
      releaseCore.resolve();
      await fixture.stop();
      archiveUpdate?.mockRestore();
    }
  },
);
