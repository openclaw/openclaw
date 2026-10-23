import { afterAll, afterEach, assert, beforeAll, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import * as runs from "../../agents/admitted-run-context.js";
import type { runEmbeddedAgent } from "../../agents/embedded-agent.js";
import { evaluateSessionFreshness } from "../../config/sessions/reset-policy.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import * as terminal from "../../infra/agent-run-terminal-writes.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createConsultRunner } from "./client-gateway-control.agent-consult-fixture.test-support.js";
import { prepareTalkSessionTarget } from "./session-target.js";

const core = vi.hoisted(() => vi.fn<typeof runEmbeddedAgent>());
// mock-isolation: Exercise real Talk admission and terminal custody without starting a model runtime.
vi.mock("../../agents/embedded-agent.js", () => ({ runEmbeddedAgent: core }));

let state: OpenClawTestState;
let config: OpenClawConfig;
beforeAll(async () => {
  state = await createOpenClawTestState({ scenario: "minimal", label: "talk-terminal-writes" });
  config = { agents: { defaults: { workspace: state.workspaceDir, skipBootstrap: true } } };
  await state.writeConfig(config);
});
afterEach(() => core.mockReset());
afterAll(async () => state?.cleanup());

it("keeps browser Talk consults idle-fresh through accepted user-turn storage", async () => {
  const sessionTarget = await prepareTalkSessionTarget(config, "agent:main:talk-idle");
  const scope = { ...sessionTarget, sessionKey: sessionTarget.canonicalKey };
  const now = Date.now();
  const staleAt = now - 61 * 60_000;
  await replaceSessionEntry(scope, {
    sessionId: "talk-idle",
    sessionStartedAt: staleAt,
    updatedAt: staleAt,
    lastInteractionAt: staleAt,
  });
  core.mockImplementation(async (params) => {
    await runs.resolvePreparedRunAdmission({ ...params, runtimeKind: "embedded" });
    assert(params.userTurnTranscriptRecorder);
    await params.userTurnTranscriptRecorder.persistApproved();
    return { payloads: [{ text: "Answer" }], meta: { durationMs: 0 } };
  });
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  try {
    const runner = createConsultRunner({ config, sessionTarget });
    await expect(runner.runPrompt({ prompt: "check" })).resolves.toEqual({ text: "Answer" });
    const entry = loadSessionEntry(scope);
    expect(entry).toMatchObject({ sessionId: "talk-idle", lastInteractionAt: now });
    assert(entry);
    expect(
      evaluateSessionFreshness({
        ...entry,
        now: now + 1,
        policy: { mode: "idle", idleMinutes: 60, atHour: 4 },
      }).fresh,
    ).toBe(true);
  } finally {
    clock.mockRestore();
  }
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
    const persistence = commit.promise.then(() =>
      writeContext.run(() => writeContext.assertCurrent()),
    );
    writeContext.track(persistence);
    captured.resolve({ admitted, writeContext, persistence });
    return {
      payloads: [{ text: "Answer" }],
      meta: { durationMs: 0, terminalReply: { disposition: "visible", text: "Answer" } },
    };
  });
  const controller = new AbortController();
  const runner = createConsultRunner({
    config,
    context: { logGateway: createSubsystemLogger("test/talk-terminal-writes") },
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
    if (abort) {
      await expect(run).rejects.toMatchObject({ name: "AbortError" });
    } else {
      await expect(run).resolves.toEqual({ text: "Answer" });
    }
    expect(runs.getAdmittedRunDelegatedAuthority(admitted)).toBeUndefined();
    expect(() => writeContext.run(() => writeContext.assertCurrent())).toThrow(
      "Terminal write owner changed before commit",
    );
  } finally {
    commit.resolve();
    await run.catch(() => undefined);
  }
});
