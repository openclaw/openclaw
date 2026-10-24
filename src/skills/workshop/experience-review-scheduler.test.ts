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
const runReview = vi.fn(async (_candidate: ExperienceReviewCandidate) => {});
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
};
function turn(
  modelIterations: number,
  { sessionKey = source.sessionKey, ...overrides }: TurnOptions = {},
) {
  scheduler.schedule({
    event: { messages: [], success: true },
    ctx: {
      runId: `run-${modelIterations}`,
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
