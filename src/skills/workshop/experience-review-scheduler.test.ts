import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TranscriptEntryAnchor } from "../../config/sessions/transcript-entry-anchor.js";
import {
  createSkillExperienceReviewScheduler,
  type ExperienceReviewCandidate,
  type SkillExperienceReviewParams,
} from "./experience-review-scheduler.js";

// mock-isolation: Keep scheduler failures out of real log sinks.
vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ debug: vi.fn(), warn: vi.fn() }),
}));
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
  vi.resetAllMocks();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  now = 1_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  vi.spyOn(performance, "now").mockImplementation(() => now);
  scheduler = createSkillExperienceReviewScheduler({ isSystemActive: () => false, runReview });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
type TurnOptions = Partial<SkillExperienceReviewParams> & { sessionKey?: string };
function turn(
  modelIterations: number,
  { sessionKey = source.sessionKey, ...overrides }: TurnOptions = {},
) {
  scheduler.schedule({
    event: { messages: [], success: true, modelIterations },
    ctx: {
      runId: `run-${modelIterations}`,
      sessionKey,
      workspaceDir: "/workspace",
      modelProviderId: "openai",
      modelId: "gpt-test",
      toolNames: ["read", "skill_workshop"],
      agentId: "main",
      trigger: "user",
    },
    config: {},
    source,
    ...overrides,
  });
}
function countedTurn(iterations: number, timers: number, options?: TurnOptions) {
  turn(iterations, options);
  expect(vi.getTimerCount()).toBe(timers);
}
async function fireTimers(calls = 1) {
  vi.runOnlyPendingTimers();
  await setImmediate();
  expect(runReview).toHaveBeenCalledTimes(calls);
}

it("backs off all sessions after a TPM rejection without replaying the failed review", async () => {
  runReview.mockRejectedValue(new Error("429 Rate limit reached: tokens per min (TPM)"));
  turn(10);
  await fireTimers(1);
  for (const [index, minutes] of [15, 30, 60].entries()) {
    turn(10, { sessionKey: `agent:main:session-${minutes}` });
    now += minutes * 60_000 - 1;
    await fireTimers(index + 1);
    now += 1;
    await fireTimers(index + 2);
  }
  now += 60 * 60_000;
  await fireTimers(4);
});

it("defers queued reviews when a foreground turn hits the shared rate limit", async () => {
  const foregroundRejection = () =>
    turn(1, {
      sessionKey: "agent:other:interactive",
      event: { messages: [], success: false, error: "429 Rate limit reached (TPM)" },
    });
  turn(10);
  foregroundRejection();
  await fireTimers(0);
  now += 15 * 60_000 - 1;
  foregroundRejection();
  now += 1;
  await fireTimers(0);
  now += 15 * 60_000;
  await fireTimers(1);
});

it.each(["reported", "messages", "interrupted"])("accumulates %s iterations", async (kind) => {
  const usedSkills = [{ name: "deploy", source: "workspace", activation: "read" }] as const;
  for (const count of [6, 3, 1]) {
    const messages =
      kind !== "messages"
        ? []
        : [
            { role: "assistant" },
            { role: "user" },
            ...Array.from({ length: count }, () => ({ role: "assistant" })),
          ];
    countedTurn(kind !== "messages" ? count : 0, count === 1 ? 1 : 0, {
      event: {
        messages,
        success: kind !== "interrupted",
        ...(kind !== "messages" ? { modelIterations: count } : {}),
        skillsUsed: usedSkills,
      },
    });
  }
  await fireTimers();
  expect(runReview).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      source,
      ctx: expect.objectContaining({ runId: kind !== "messages" ? "run-1" : "run-0" }),
      usedSkills,
    }),
    expect.any(AbortSignal),
  );
  countedTurn(9, 0);
});

it.each([false, true])("resets review state (Stop=%s)", async (stopped) => {
  for (const iterations of [8, 10]) {
    countedTurn(iterations, iterations === 10 ? 1 : 0);
    if (stopped) {
      scheduler.cancelSession(source);
      scheduler.suppressRuns(["run-20"]);
      turn(20, { event: { messages: [], success: false } });
    } else {
      turn(1, { workshopMutated: true });
    }
    await fireTimers(0);
    countedTurn(9, 0);
    countedTurn(1, 1);
    turn(1, { workshopMutated: true });
  }
});

it("waits for 30 quiet seconds after the session's latest turn", async () => {
  countedTurn(10, 1);
  vi.advanceTimersByTime(29_999);
  countedTurn(1, 1);
  vi.advanceTimersByTime(29_999);
  await setImmediate();
  expect(runReview).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  await fireTimers();
});

it("ignores errored turns and sessions while Workshop is off", () => {
  turn(8);
  turn(20, { event: { messages: [], success: false, error: "provider 500" } });
  turn(20, { config: { skills: { workshop: { autonomous: { mode: "off" } } } } });
  countedTurn(8, 0);
});
it("still queues reviews while Workshop proposes drafts", () => {
  countedTurn(10, 1, { config: { skills: { workshop: { autonomous: { mode: "propose" } } } } });
});
it("never reviews ACP child sessions", () => {
  countedTurn(20, 0, { sessionKey: "agent:main:acp:child-1" });
});
