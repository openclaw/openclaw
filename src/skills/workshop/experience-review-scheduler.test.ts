import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SessionTranscriptReadFenceError } from "../../config/sessions/session-transcript-read-fence-error.js";
import type { TranscriptEntryAnchor } from "../../config/sessions/transcript-entry-anchor.js";
import { GatewayDrainingError } from "../../process/gateway-work-admission.js";
import {
  createSkillExperienceReviewScheduler,
  type ExperienceReviewCandidate,
  type SkillExperienceReviewParams,
} from "./experience-review-scheduler.js";
import { resolveWorkshopSkillsDir } from "./skills-root.js";

const log = vi.hoisted(() => ({ debug: vi.fn(), warn: vi.fn() }));
// mock-isolation: Capture severity without initializing real log sinks.
vi.mock("../../logging/subsystem.js", () => ({ createSubsystemLogger: () => log }));
const source = {
  agentId: "main",
  sessionId: "session-1",
  sessionKey: "agent:main:telegram:direct:42",
  storePath: "/sessions",
  entryId: "entry-1",
} as TranscriptEntryAnchor;
const runReview = vi.fn(async (_candidate: ExperienceReviewCandidate, _signal: AbortSignal) => {});
let scheduler: ReturnType<typeof createSkillExperienceReviewScheduler>;
let now: number;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  now = 1_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  log.debug.mockReset();
  log.warn.mockReset();
  runReview.mockReset();
  scheduler = createSkillExperienceReviewScheduler({ isSystemActive: () => false, runReview });
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
type TurnOptions = Partial<SkillExperienceReviewParams> & {
  sessionKey?: string;
  runId?: string;
};
function turn(
  modelIterations: number,
  {
    sessionKey = source.sessionKey,
    runId = `run-${modelIterations}`,
    ...overrides
  }: TurnOptions = {},
) {
  scheduler.schedule({
    event: { messages: [], success: true },
    ctx: {
      runId,
      sessionKey,
      workspaceDir: "/workspace",
      modelProviderId: "openai",
      modelId: "gpt-test",
      modelIterations,
      skillWorkshopAvailable: true,
      foregroundPromptContext: {
        agentId: "main",
        workspaceDir: "/workspace",
        sandboxSessionKey: source.sessionKey,
        trigger: "user",
      },
    },
    config: { skills: { workshop: { autonomous: { mode: "auto" } } } },
    source,
    ...overrides,
  });
}
function countedTurn(iterations: number, timers: number, options?: TurnOptions) {
  turn(iterations, options);
  expect(vi.getTimerCount()).toBe(timers);
}
async function fireTimers() {
  vi.runOnlyPendingTimers();
  await setImmediate();
}
const fenceError = () =>
  new SessionTranscriptReadFenceError("Session transcript changed during context read");

it("backs off all sessions after a TPM rejection without replaying the failed review", async () => {
  runReview.mockRejectedValue(new Error("429 Rate limit reached: tokens per min (TPM)"));
  turn(10);
  await fireTimers();
  expect(runReview).toHaveBeenCalledTimes(1);
  for (const [index, minutes] of [15, 30, 60].entries()) {
    turn(10, { sessionKey: `agent:main:session-${minutes}` });
    now += minutes * 60_000 - 1;
    await fireTimers();
    expect(runReview).toHaveBeenCalledTimes(index + 1);
    now += 1;
    await fireTimers();
    expect(runReview).toHaveBeenCalledTimes(index + 2);
  }
  now += 60 * 60_000;
  await fireTimers();
  expect(runReview).toHaveBeenCalledTimes(4);
});

it("defers queued reviews when a foreground turn hits the shared rate limit", async () => {
  const foregroundRejection = () =>
    turn(1, {
      sessionKey: "agent:other:interactive",
      event: { messages: [], success: false, error: "429 Rate limit reached (TPM)" },
    });
  turn(10);
  foregroundRejection();
  await fireTimers();
  expect(runReview).not.toHaveBeenCalled();
  now += 15 * 60_000 - 1;
  foregroundRejection();
  now += 1;
  await fireTimers();
  expect(runReview).not.toHaveBeenCalled();
  now += 15 * 60_000;
  await fireTimers();
  expect(runReview).toHaveBeenCalledOnce();
});

it.each([
  ["Gateway shutdown", new GatewayDrainingError(), "debug"],
  ["source transcript change", fenceError(), "debug"],
  [
    "wrapped source authority revocation",
    new Error("admitted run authority is no longer active", { cause: fenceError() }),
    "debug",
  ],
  [
    "cancellation with cleanup failure",
    new AggregateError([new GatewayDrainingError(), new Error("database close failed")]),
    "warn",
  ],
  ["provider failure", new Error("provider request failed"), "warn"],
] as const)("reports %s with the appropriate log level", async (_reason, error, level) => {
  runReview.mockRejectedValue(error);
  turn(10);
  log.debug.mockClear();
  await fireTimers();
  expect(log[level]).toHaveBeenCalledWith(
    expect.stringContaining(
      `skill experience review ${level === "debug" ? "cancelled" : "failed"}:`,
    ),
  );
  expect(log[level === "debug" ? "warn" : "debug"]).not.toHaveBeenCalled();
});

it("accumulates model iterations across turns and reviews once the session reaches ten", async () => {
  turn(4);
  countedTurn(4, 0);
  countedTurn(3, 1);
  await fireTimers();
  expect(runReview).toHaveBeenCalledTimes(1);
  expect(runReview.mock.calls[0]?.[0]).toMatchObject({ source, ctx: { runId: "run-3" } });
  countedTurn(9, 0);
});

it("counts only assistant messages after the last user when the harness reports zero iterations", () => {
  const assistantTurn = (count: number): TurnOptions => ({
    event: {
      messages: [
        { role: "assistant" },
        { role: "user" },
        ...Array.from({ length: count }, () => ({ role: "assistant" })),
      ],
      success: true,
    },
  });
  turn(0, assistantTurn(6));
  countedTurn(0, 0, assistantTurn(3));
  countedTurn(0, 1, assistantTurn(1));
});

it.each([8, 10])(
  "resets %i accumulated iterations and queued work after a Workshop change",
  async (iterations) => {
    countedTurn(iterations, iterations === 10 ? 1 : 0);
    turn(1, { workshopMutated: true });
    await fireTimers();
    expect(runReview).not.toHaveBeenCalled();
    countedTurn(9, 0);
    countedTurn(1, 1);
  },
);

it("cancels a queued review for a session the user stopped", async () => {
  countedTurn(10, 1);

  scheduler.cancelSession({ agentId: "main", sessionKey: source.sessionKey });

  expect(vi.getTimerCount()).toBe(0);
  await fireTimers();
  expect(runReview).not.toHaveBeenCalled();
});

it("suppresses the stopped run's own aborted completion without blocking later turns", async () => {
  // The stopped turn already accumulated nine iterations; its aborted agent_end
  // would push the session over the threshold and re-arm the review.
  countedTurn(9, 0, { runId: "stopped-run" });
  scheduler.cancelSession({ agentId: "main", sessionKey: source.sessionKey });
  scheduler.suppressRuns(["stopped-run"]);

  turn(10, { runId: "stopped-run", event: { messages: [], success: false } });
  expect(vi.getTimerCount()).toBe(0);
  await fireTimers();
  expect(runReview).not.toHaveBeenCalled();

  // Suppression is run-scoped and one-shot: the very next turn schedules normally.
  countedTurn(10, 1, { runId: "next-run" });
  await fireTimers();
  expect(runReview).toHaveBeenCalledOnce();
  expect(runReview.mock.calls[0]?.[0].ctx.runId).toBe("next-run");
});

it("suppression never blocks another session's run", async () => {
  scheduler.suppressRuns(["stopped-run"]);

  turn(10, { runId: "stopped-run" });
  turn(10, {
    runId: "other-run",
    sessionKey: "agent:main:other",
    source: { ...source, sessionKey: "agent:main:other" },
  });
  await fireTimers();

  expect(runReview).toHaveBeenCalledOnce();
  expect(runReview.mock.calls[0]?.[0].ctx.runId).toBe("other-run");
});

it("aborts the in-flight review for a session the user stopped", async () => {
  const receivedSignals: AbortSignal[] = [];
  runReview.mockImplementation(
    (_candidate, signal) =>
      new Promise<void>((_resolve, reject) => {
        receivedSignals.push(signal);
        // Production settles as a plain Error, not an AbortError; the scheduler must
        // classify it by its own controller's abort state.
        signal.addEventListener(
          "abort",
          () => reject(new Error("Skill review model run aborted.")),
          { once: true },
        );
      }),
  );
  turn(10);
  await fireTimers();
  expect(runReview).toHaveBeenCalledOnce();
  expect(receivedSignals[0]?.aborted).toBe(false);

  scheduler.cancelSession({ agentId: "main", sessionKey: source.sessionKey });
  await setImmediate();

  expect(receivedSignals[0]?.aborted).toBe(true);
  // Cancellation is expected work, not a review failure.
  expect(log.warn).not.toHaveBeenCalled();
  expect(log.debug).toHaveBeenCalledWith(expect.stringContaining("cancelled"));

  // The stop belongs to this review only; a later turn may schedule a new one.
  runReview.mockReset();
  runReview.mockResolvedValue(undefined);
  turn(10);
  await fireTimers();
  expect(runReview).toHaveBeenCalledOnce();
});

it("keeps an independent cleanup failure visible after cancellation", async () => {
  runReview.mockImplementation(
    (_candidate, signal) =>
      new Promise<void>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () =>
            reject(
              new AggregateError(
                [
                  new Error("Skill review model run aborted."),
                  new Error("workshop change read failed"),
                ],
                "Skill experience review and its cleanup failed",
              ),
            ),
          { once: true },
        );
      }),
  );
  turn(10);
  await fireTimers();
  scheduler.cancelSession({ agentId: "main", sessionKey: source.sessionKey });
  await setImmediate();

  expect(log.debug).not.toHaveBeenCalled();
  expect(log.warn).toHaveBeenCalledWith(
    expect.stringContaining("Skill experience review and its cleanup failed"),
  );
});

it("keeps a cleanup-only failure visible after a stopped successful review", async () => {
  runReview.mockImplementation(
    (_candidate, signal) =>
      new Promise<void>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () =>
            reject(
              new AggregateError(
                [new Error("workshop change read failed")],
                "Skill experience review cleanup failed",
              ),
            ),
          { once: true },
        );
      }),
  );
  turn(10);
  await fireTimers();
  scheduler.cancelSession({ agentId: "main", sessionKey: source.sessionKey });
  await setImmediate();

  expect(log.debug).not.toHaveBeenCalled();
  expect(log.warn).toHaveBeenCalledWith(
    expect.stringContaining("Skill experience review cleanup failed"),
  );
});

it("cancels only the stopped session's queued review", async () => {
  turn(10);
  turn(10, {
    sessionKey: "agent:main:other",
    source: { ...source, sessionKey: "agent:main:other" },
  });

  scheduler.cancelSession({ agentId: "main", sessionKey: source.sessionKey });
  await fireTimers();

  expect(runReview).toHaveBeenCalledOnce();
  expect(runReview.mock.calls[0]?.[0].source.sessionKey).toBe("agent:main:other");
});

it("keeps reviews for interrupted turns that were not explicitly stopped", async () => {
  turn(10, { event: { messages: [], success: false } });
  await fireTimers();
  expect(runReview).toHaveBeenCalledOnce();
  expect(runReview.mock.calls[0]?.[0].turnAborted).toBe(true);
});

it("waits for ten accumulated iterations even when turns use a learned skill", async () => {
  const usedSkill = (name: string, skillFile: string) =>
    [{ name, source: "workspace", activation: "read", skillFile }] as const;
  countedTurn(1, 0, { usedSkills: usedSkill("notes", "/ws/notes/SKILL.md") });
  const usedSkills = usedSkill(
    "deploy",
    path.join(resolveWorkshopSkillsDir({}, "main"), "deploy", "SKILL.md"),
  );
  countedTurn(1, 0, { usedSkills });
  countedTurn(7, 0, { usedSkills });
  countedTurn(1, 1, { usedSkills });
  await fireTimers();
  expect(runReview).toHaveBeenCalledTimes(1);
  expect(runReview.mock.calls[0]?.[0].usedSkills).toEqual([
    expect.objectContaining({ name: "deploy" }),
  ]);
  countedTurn(1, 0, { workshopMutated: true, usedSkills });
});

it("ignores errored turns and sessions while Workshop is off", () => {
  turn(8);
  turn(20, { event: { messages: [], success: false, error: "provider 500" } });
  turn(20, { config: { skills: { workshop: { autonomous: { mode: "off" } } } } });
  countedTurn(8, 0);
});

it("never reviews ACP child sessions", () => {
  countedTurn(20, 0, { sessionKey: "agent:main:acp:child-1" });
});
