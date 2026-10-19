import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
// mock-isolation: Capture review log severity without initializing real log sinks.
vi.mock("../../logging/subsystem.js", () => ({ createSubsystemLogger: () => log }));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  log.debug.mockReset();
  log.warn.mockReset();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const source = {
  agentId: "main",
  sessionId: "session-1",
  sessionKey: "agent:main:telegram:direct:42",
  storePath: "/sessions",
  entryId: "entry-1",
} as TranscriptEntryAnchor;

function createHarness() {
  const runReview = vi.fn(async (_candidate: ExperienceReviewCandidate) => {});
  const scheduler = createSkillExperienceReviewScheduler({
    isSystemActive: () => false,
    runReview,
  });
  const turn = (
    modelIterations: number,
    {
      sessionKey = source.sessionKey,
      ...overrides
    }: Partial<SkillExperienceReviewParams> & { compacted?: boolean; sessionKey?: string } = {},
  ) =>
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
        compacted: overrides.compacted,
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
  const fireTimers = () => vi.runOnlyPendingTimers();
  return { turn, fireTimers, runReview };
}

describe("skill experience review scheduler", () => {
  it("backs off all sessions after a TPM rejection without replaying the failed review", async () => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const { turn, fireTimers, runReview } = createHarness();
    runReview.mockRejectedValue(new Error("429 Rate limit reached: tokens per min (TPM)"));

    turn(10);
    fireTimers();
    await setImmediate();
    expect(runReview).toHaveBeenCalledTimes(1);
    for (const minutes of [15, 30, 60]) {
      turn(10, { sessionKey: `agent:main:session-${minutes}` });
      now += minutes * 60_000 - 1;
      fireTimers();
      await setImmediate();
      const before = runReview.mock.calls.length;
      // The queue cannot bypass a cooldown through another session.
      expect(before).toBe([15, 30, 60].indexOf(minutes) + 1);
      now += 1;
      fireTimers();
      await setImmediate();
      expect(runReview).toHaveBeenCalledTimes(before + 1);
    }
    now += 60 * 60_000;
    fireTimers();
    await setImmediate();
    expect(runReview).toHaveBeenCalledTimes(4);
  });

  it("defers queued reviews when a foreground turn hits the shared rate limit", async () => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const { turn, fireTimers, runReview } = createHarness();
    turn(10);
    turn(1, {
      sessionKey: "agent:other:interactive",
      event: { messages: [], success: false, error: "429 Rate limit reached (TPM)" },
    });
    fireTimers();
    await setImmediate();
    expect(runReview).not.toHaveBeenCalled();
    now += 15 * 60_000 - 1;
    turn(1, {
      sessionKey: "agent:other:interactive",
      event: { messages: [], success: false, error: "429 Rate limit reached (TPM)" },
    });
    now += 1;
    fireTimers();
    await setImmediate();
    expect(runReview).not.toHaveBeenCalled();
    now += 15 * 60_000;
    fireTimers();
    await setImmediate();
    expect(runReview).toHaveBeenCalledOnce();
  });

  it.each([
    ["Gateway shutdown", new GatewayDrainingError(), "debug"],
    [
      "source transcript change",
      new SessionTranscriptReadFenceError("Session transcript changed during context read"),
      "debug",
    ],
    [
      "wrapped source authority revocation",
      new Error("admitted run authority is no longer active", {
        cause: new SessionTranscriptReadFenceError(
          "Session transcript changed during context read",
        ),
      }),
      "debug",
    ],
    [
      "cancellation with cleanup failure",
      new AggregateError([new GatewayDrainingError(), new Error("database close failed")]),
      "warn",
    ],
    ["provider failure", new Error("provider request failed"), "warn"],
  ] as const)("reports %s with the appropriate log level", async (_reason, error, level) => {
    const { turn, fireTimers, runReview } = createHarness();
    const reported = Promise.withResolvers<void>();
    const observe = (message: string) => {
      if (message.startsWith("skill experience review ")) {
        reported.resolve();
      }
    };
    log.debug.mockImplementation(observe);
    log.warn.mockImplementation(observe);
    runReview.mockRejectedValue(error);

    turn(10);
    log.debug.mockClear();
    fireTimers();
    await reported.promise;

    expect(log[level]).toHaveBeenCalledWith(
      expect.stringContaining(
        `skill experience review ${level === "debug" ? "cancelled" : "failed"}:`,
      ),
    );
    expect(log[level === "debug" ? "warn" : "debug"]).not.toHaveBeenCalled();
  });

  it("accumulates model iterations across turns and reviews once the session reaches ten", async () => {
    const { turn, fireTimers, runReview } = createHarness();

    turn(4);
    turn(4);
    expect(vi.getTimerCount()).toBe(0);
    // Compacted sessions keep counting; only the running total matters.
    turn(3, { compacted: true });
    expect(vi.getTimerCount()).toBe(1);
    fireTimers();
    await vi.waitFor(() => expect(runReview).toHaveBeenCalledTimes(1));
    expect(runReview.mock.calls[0]?.[0]).toMatchObject({ source, ctx: { runId: "run-3" } });

    // The counter restarts after scheduling.
    turn(9);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("counts the turn's assistant messages when the harness reports zero iterations", () => {
    const { turn } = createHarness();
    const assistantTurn = (assistantMessages: number) => ({
      event: {
        messages: [
          { role: "assistant" },
          { role: "user" },
          ...Array.from({ length: assistantMessages }, () => ({ role: "assistant" })),
        ],
        success: true,
      },
    });

    // Only messages after the last user message belong to the turn: 6 + 3 stays below ten.
    turn(0, assistantTurn(6));
    turn(0, assistantTurn(3));
    expect(vi.getTimerCount()).toBe(0);
    turn(0, assistantTurn(1));
    expect(vi.getTimerCount()).toBe(1);
  });

  it("resets the counter when the foreground turn saved its own Workshop change", () => {
    const { turn } = createHarness();

    turn(8);
    turn(1, { workshopMutated: true });
    turn(9);
    expect(vi.getTimerCount()).toBe(0);
    turn(1);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("drops an already queued review when a later foreground turn saves its own change", async () => {
    const { turn, fireTimers, runReview } = createHarness();

    turn(10);
    expect(vi.getTimerCount()).toBe(1);
    turn(1, { workshopMutated: true });
    fireTimers();
    await setImmediate();
    expect(runReview).not.toHaveBeenCalled();
  });

  it("waits for ten accumulated iterations even when turns use a learned skill", async () => {
    const { turn, fireTimers, runReview } = createHarness();
    const workshopSkill = path.join(resolveWorkshopSkillsDir({}, "main"), "deploy", "SKILL.md");

    turn(1, {
      usedSkills: [
        { name: "notes", source: "workspace", activation: "read", skillFile: "/ws/notes/SKILL.md" },
      ],
    });
    expect(vi.getTimerCount()).toBe(0);
    const usedSkills = [
      { name: "deploy", source: "workspace", activation: "read", skillFile: workshopSkill },
    ] as const;
    turn(1, { usedSkills });
    expect(vi.getTimerCount()).toBe(0);
    turn(7, { usedSkills });
    expect(vi.getTimerCount()).toBe(0);
    turn(1, { usedSkills });
    expect(vi.getTimerCount()).toBe(1);
    fireTimers();
    await vi.waitFor(() => expect(runReview).toHaveBeenCalledTimes(1));
    expect(runReview.mock.calls[0]?.[0].usedSkills).toEqual([
      expect.objectContaining({ name: "deploy" }),
    ]);

    // Saving its own change already captured the lesson; the used skill does not re-trigger.
    turn(1, {
      workshopMutated: true,
      usedSkills: [
        { name: "deploy", source: "workspace", activation: "read", skillFile: workshopSkill },
      ],
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores errored turns and sessions while Workshop is off", () => {
    const { turn } = createHarness();

    turn(8);
    turn(20, { event: { messages: [], success: false, error: "provider 500" } });
    turn(20, { config: { skills: { workshop: { autonomous: { mode: "off" } } } } });
    turn(8);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never reviews ACP child sessions", () => {
    const { turn } = createHarness();

    turn(20, { sessionKey: "agent:main:acp:child-1" });
    expect(vi.getTimerCount()).toBe(0);
  });
});
