import { afterAll, afterEach, assert, beforeAll, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import * as runs from "../../agents/admitted-run-context.js";
import type { runEmbeddedAgent } from "../../agents/embedded-agent.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import * as terminal from "../../infra/agent-run-terminal-writes.js";
import { getAsyncWorkSignal } from "../../shared/async-work-scope.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createConsultRunner } from "./client-gateway-control.agent-consult-fixture.test-support.js";
import { prepareTalkSessionTarget } from "./session-target.js";

const core = vi.hoisted(() => vi.fn<typeof runEmbeddedAgent>());
// mock-isolation: Exercise real Talk admission and terminal custody without starting a model runtime.
vi.mock("../../agents/embedded-agent.js", () => ({ runEmbeddedAgent: core }));
const scheduleSessionMaintenance = vi.hoisted(() => vi.fn());
vi.mock("../../agents/session-maintenance/run.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/session-maintenance/run.js")>()),
  scheduleSessionMaintenance,
}));

let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
let config: OpenClawConfig;
beforeAll(async () => {
  state = await createOpenClawTestState({ scenario: "minimal", label: "talk-terminal-writes" });
  config = { agents: { defaults: { workspace: state.workspaceDir, skipBootstrap: true } } };
  await state.writeConfig(config);
});
afterEach(() => {
  core.mockReset();
  scheduleSessionMaintenance.mockReset();
});
afterAll(async () => state?.cleanup());

it("refreshes browser Talk activity through accepted user-turn storage", async () => {
  const sessionTarget = await prepareTalkSessionTarget(config, "agent:main:talk-idle");
  const scope = { ...sessionTarget, sessionKey: sessionTarget.canonicalKey };
  const now = Date.now();
  const staleAt = now - 61 * 60_000;
  await replaceSessionEntry(scope, {
    sessionId: "talk-idle",
    updatedAt: staleAt,
    lastInteractionAt: staleAt,
  });
  core.mockImplementation(async (params) => {
    await runs.resolvePreparedRunAdmission({ ...params, runtimeKind: "embedded" });
    assert(params.userTurnTranscriptRecorder);
    await params.userTurnTranscriptRecorder.persistApproved();
    return { payloads: [{ text: "Answer" }], meta: { durationMs: 0 } };
  });
  using _ = vi.spyOn(Date, "now").mockReturnValue(now);
  const runner = createConsultRunner({ config, sessionTarget });
  await expect(runner.runPrompt({ prompt: "check" })).resolves.toEqual({ text: "Answer" });
  expect(loadSessionEntry(scope)).toMatchObject({ sessionId: "talk-idle", lastInteractionAt: now });
});

it("hands a completed consult to post-turn session maintenance", async () => {
  const sessionTarget = await prepareTalkSessionTarget(config, "agent:main:talk-upkeep");
  const scope = { ...sessionTarget, sessionKey: sessionTarget.canonicalKey };
  await replaceSessionEntry(scope, { sessionId: "talk-upkeep", updatedAt: Date.now() });
  core.mockImplementation(async (params) => {
    await runs.resolvePreparedRunAdmission({ ...params, runtimeKind: "embedded" });
    const internal = params as { onSuccessfulAuthProfile?: (id: string) => void };
    internal.onSuccessfulAuthProfile?.("anthropic:default");
    const agentMeta = { sessionId: "talk-upkeep", provider: "anthropic", model: "claude-opus-5-5" };
    return {
      payloads: [{ text: "Answer" }],
      meta: { durationMs: 0, agentMeta: { ...agentMeta, agentHarnessId: "openclaw" } },
    };
  });
  // The consult's work scope aborts what it still owns on return; upkeep must outlive it.
  let scheduledInsideConsultScope: boolean | undefined;
  scheduleSessionMaintenance.mockImplementation(() => {
    scheduledInsideConsultScope = getAsyncWorkSignal() !== undefined;
  });
  const runner = createConsultRunner({ config, sessionTarget });
  await expect(runner.runPrompt({ prompt: "check" })).resolves.toEqual({ text: "Answer" });
  await vi.waitFor(() => expect(scheduleSessionMaintenance).toHaveBeenCalledOnce());
  expect(scheduledInsideConsultScope).toBe(false);
  expect(scheduleSessionMaintenance.mock.calls[0]?.[0]).toMatchObject({
    prepared: { sessionKey: scope.sessionKey, storePath: scope.storePath },
    sessionId: "talk-upkeep",
    followupRun: {
      run: {
        sessionId: "talk-upkeep",
        provider: "anthropic",
        model: "claude-opus-5-5",
        authProfileId: "anthropic:default",
        authProfileIdSource: "auto",
      },
    },
  });
});

it.each([false, true])("drains writes; abort revokes authority (%s)", async (abort) => {
  const commit = createDeferred();
  const captured = createDeferred<{
    admitted: runs.AdmittedRunContext;
    writeContext: terminal.CapturedAgentRunTerminalWriteContext;
    persistence: Promise<void>;
  }>();
  core.mockImplementation(async (params) => {
    const admitted = await runs.resolvePreparedRunAdmission({ ...params, runtimeKind: "embedded" });
    const writeContext = terminal.captureAgentRunTerminalPersistence(params.runId).writeContext;
    assert(writeContext);
    const persistence = commit.promise.then(() => writeContext.run(() => {}));
    writeContext.track(persistence);
    captured.resolve({ admitted, writeContext, persistence });
    return { payloads: [{ text: "Answer" }], meta: { durationMs: 0 } };
  });
  const controller = new AbortController();
  const runner = createConsultRunner({
    config,
    sessionTarget: await prepareTalkSessionTarget(config, `agent:main:talk-terminal-${abort}`),
  });
  const settled = vi.fn();
  const run = runner.runPrompt({ prompt: "check", signal: controller.signal });
  void run.then(settled, settled);
  try {
    const { admitted, writeContext, persistence } = await awaitGateBeforeSettlement(
      captured.promise,
      run,
      "Talk must reach embedded execution",
    );
    // The wrapper registered its core continuation before this observer.
    await core.mock.results[0]?.value;
    if (abort) {
      controller.abort();
      expect(runs.getAdmittedRunDelegatedAuthority(admitted)).toBeUndefined();
    }
    expect(settled).not.toHaveBeenCalled();
    commit.resolve();
    await persistence;
    await (abort
      ? expect(run).rejects.toMatchObject({ name: "AbortError" })
      : expect(run).resolves.toEqual({ text: "Answer" }));
    expect(runs.getAdmittedRunDelegatedAuthority(admitted)).toBeUndefined();
    expect(() => writeContext.run(() => writeContext.assertCurrent())).toThrow(
      "Terminal write owner changed before commit",
    );
  } finally {
    commit.resolve();
    await run.catch(() => undefined);
  }
});
