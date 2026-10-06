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
import { CronService, type CronEvent } from "./service.js";
import { createNoopLogger } from "./service.test-harness.js";
import { resolveCronSessionTargetSessionKey } from "./session-target.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();
const session = await vi.importActual<typeof import("./isolated-agent/session.js")>(
  "./isolated-agent/session.js",
);
const accessor = await vi.importActual<typeof import("../config/sessions/session-accessor.js")>(
  "../config/sessions/session-accessor.js",
);
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

// This synthetic model consumes only the serialized recipe target. It does not
// evaluate prose, reviews, CI, or GitHub authority and cannot prove autonomous merging.
function readRecipeTarget(prompt: string) {
  const line = expectDefined(
    prompt.split("\n").find((value) => value.includes("for this exact target: ")),
    "recipe target line",
  );
  const start = line.indexOf("{");
  const end = line.lastIndexOf("}");
  const target = asRecord(JSON.parse(line.slice(start, end + 1)));
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
      defaults: { skipBootstrap: true, workspace: stateDir },
      entries: { main: { workspace: stateDir } },
    },
    plugins: { enabled: false },
  };
  setRuntimeConfigSnapshot(config);
  const seed = async (sessionId: string) =>
    await accessor.replaceSessionEntry(
      { agentId: "main", sessionKey: SESSION },
      {
        sessionId,
        updatedAt: Date.now(),
        sessionStartedAt: Date.now(),
        lastInteractionAt: Date.now(),
      },
    );
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
  const add = async (selected: CiAutomationTarget) => {
    const definition = { ...ciAutomationJobSpec(selected, option), enabled: false };
    const respond = vi.fn();
    await expectDefined(
      cronHandlers["cron.add"],
      "cron.add",
    )({
      req: { type: "req", id: "recipe-create", method: "cron.add", params: definition },
      params: definition,
      respond,
      context: creator.context,
      client,
      isWebchatConnect: () => false,
    });
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
  const execution = new CronService({
    scheduler: createTestGatewayScheduler(clock.clock),
    nowMs: clock.clock.now,
    storePath: path.join(stateDir, "cron", "jobs.json"),
    cronEnabled: true,
    defaultAgentId: "main",
    log: createNoopLogger(),
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    onEvent: (event) => {
      if (event.action === "finished") {
        finished.resolve(event);
      }
    },
    runIsolatedAgentJob: (request) =>
      runCronIsolatedAgentTurn({
        ...request,
        cfg: config,
        deps: {},
        agentId: "main",
        sessionKey:
          resolveCronSessionTargetSessionKey(request.job.sessionTarget) ?? `cron:${request.job.id}`,
      }),
  });
  // Reload through a distinct scheduler owner rather than reuse cron.add's memory.
  await execution.start();
  expect((await execution.list({ includeDisabled: true })).map((job) => job.id).toSorted()).toEqual(
    [selected.id, other.id].toSorted(),
  );
  const tick = async () => {
    finished = createDeferredCore<CronEvent>();
    await clock.advanceBy(300_000);
    return await finished.promise;
  };
  return { creator, client, target, add, selected, other, execution, seed, tick };
}

it("transports autoFix for only the selected PR across session replacement and disables future effects", async () => {
  const fixture = await createFixture("autoFix");
  const finalEffect =
    vi.fn<(target: { owner: string; repo: string; number: number }, sessionId: string) => void>();
  runEmbeddedAgentMock.mockImplementation(async (params: RunEmbeddedAgentParams) => {
    const admitted = await expectDefined(params.preparedRunAdmission, "scheduled admission").admit(
      "gateway",
      params.runId,
    );
    expectDefined(resolveAdmittedRunActiveAssertion(admitted), "active admission assertion")();
    const target = readRecipeTarget(params.prompt);
    finalEffect(
      { owner: target.owner, repo: target.repo, number: target.number },
      params.sessionId,
    );
    return { payloads: [{ text: "Synthetic endpoint accepted" }], meta: { agentMeta: {} } };
  });
  try {
    await fixture.execution.update(fixture.selected.id, { enabled: true });
    expect(await fixture.tick()).toMatchObject({ jobId: fixture.selected.id, status: "ok" });
    expect(finalEffect.mock.calls).toEqual([
      [{ owner: "fixture-org", repo: "fixture-repo", number: 41 }, SESSION_ID],
    ]);
    await fixture.seed("replacement-session");
    expect(await fixture.tick()).toMatchObject({ jobId: fixture.selected.id, status: "ok" });
    expect(finalEffect.mock.calls[1]).toEqual([
      { owner: "fixture-org", repo: "fixture-repo", number: 41 },
      "replacement-session",
    ]);
    await fixture.execution.update(fixture.selected.id, { enabled: false });
    await fixture.execution.update(fixture.other.id, { enabled: true });
    // The second job supplies a real completed scheduler turn, not a sleep used
    // to infer that the disabled job probably did not run.
    expect(await fixture.tick()).toMatchObject({ jobId: fixture.other.id, status: "ok" });
    expect(finalEffect.mock.calls).toEqual([
      [{ owner: "fixture-org", repo: "fixture-repo", number: 41 }, SESSION_ID],
      [{ owner: "fixture-org", repo: "fixture-repo", number: 41 }, "replacement-session"],
      [{ owner: "fixture-org", repo: "fixture-repo", number: 42 }, "replacement-session"],
    ]);
    expect(fixture.execution.getJob(fixture.selected.id)?.enabled).toBe(false);
    expect((await fixture.add({ ...fixture.target, sessionId: "replacement-session" })).id).toBe(
      fixture.selected.id,
    );
  } finally {
    fixture.execution.stop();
  }
});

it.each([false, true])(
  "existing archive API checks the scheduled recipe's exact identity (replaced=%s)",
  async (replaced) => {
    const fixture = await createFixture("autoArchive");
    const respond = vi.fn();
    runEmbeddedAgentMock.mockImplementation(async (params: RunEmbeddedAgentParams) => {
      const target = readRecipeTarget(params.prompt);
      const patch = {
        key: target.sessionKey,
        expectedSessionId: expectDefined(target.sessionId, "archive incarnation"),
        archived: true,
      };
      // Synthetic model decision; the native archive handler and its exact-ID
      // precondition are real. No GitHub lookup or merge is performed.
      await expectDefined(
        sessionMutationHandlers["sessions.patch"],
        "sessions.patch",
      )({
        req: { type: "req", id: "recipe-archive", method: "sessions.patch", params: patch },
        params: patch,
        respond,
        context: fixture.creator.context,
        client: fixture.client,
        isWebchatConnect: () => false,
      });
      return { payloads: [{ text: "Synthetic archive request settled" }], meta: { agentMeta: {} } };
    });
    try {
      if (replaced) {
        await fixture.seed("replacement-session");
      }
      await fixture.execution.update(fixture.selected.id, { enabled: true });
      const event = await fixture.tick();
      // Successful archive disables bound jobs through the native cleanup owner,
      // cancelling this occurrence after the archive commits. A scheduler
      // cancellation is not evidence that the archive failed.
      expect(event).toMatchObject({
        jobId: fixture.selected.id,
        ...(replaced
          ? { status: "ok" }
          : { status: "error", error: "Cron job disabled by operator." }),
      });
      expect(runEmbeddedAgentMock).toHaveBeenCalledOnce();
      const stored = accessor.loadSessionEntry({ agentId: "main", sessionKey: SESSION });
      if (replaced) {
        expect(respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({ details: { reason: "session-changed" } }),
        );
        expect(stored).toMatchObject({ sessionId: "replacement-session" });
        expect(stored?.archivedAt).toBeUndefined();
      } else {
        expect(respond).toHaveBeenCalledWith(true, expect.anything(), undefined);
        expect(stored).toMatchObject({ sessionId: SESSION_ID, archivedAt: expect.any(Number) });
        expect((await fixture.creator.read()).every((job) => !job.enabled)).toBe(true);
      }
    } finally {
      fixture.execution.stop();
    }
  },
);
