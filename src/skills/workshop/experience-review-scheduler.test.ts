import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import type { TranscriptEntryAnchor } from "../../config/sessions/transcript-entry-anchor.js";
import {
  createSkillExperienceReviewScheduler,
  type ExperienceReviewCandidate,
  type SkillExperienceReviewParams,
} from "./experience-review-scheduler.js";
import { resolveWorkshopSkillsDir } from "./skills-root.js";

const source = {
  agentId: "main",
  sessionId: "session-1",
  sessionKey: "agent:main:telegram:direct:42",
  storePath: "/sessions",
  entryId: "entry-1",
} as TranscriptEntryAnchor;

function createHarness() {
  const timers: Array<() => void> = [];
  const runReview = vi.fn(async (_candidate: ExperienceReviewCandidate) => {});
  const scheduler = createSkillExperienceReviewScheduler({
    isSystemActive: () => false,
    runReview,
    setTimer: (callback) => {
      timers.push(callback);
      return { unref() {} } as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: () => {},
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
  const fireTimers = () => {
    for (const callback of timers.splice(0)) {
      callback();
    }
  };
  return { turn, fireTimers, runReview, timers };
}

describe("skill experience review scheduler", () => {
  it("accumulates model iterations across turns and reviews once the session reaches ten", async () => {
    const { turn, fireTimers, runReview, timers } = createHarness();

    turn(4);
    turn(4);
    expect(timers).toHaveLength(0);
    // Compacted sessions keep counting; only the running total matters.
    turn(3, { compacted: true });
    expect(timers).toHaveLength(1);
    fireTimers();
    await vi.waitFor(() => expect(runReview).toHaveBeenCalledTimes(1));
    expect(runReview.mock.calls[0]?.[0]).toMatchObject({ source, ctx: { runId: "run-3" } });

    // The counter restarts after scheduling.
    turn(9);
    expect(timers).toHaveLength(0);
  });

  it("counts the turn's assistant messages when the harness reports zero iterations", () => {
    const { turn, timers } = createHarness();
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
    expect(timers).toHaveLength(0);
    turn(0, assistantTurn(1));
    expect(timers).toHaveLength(1);
  });

  it("resets the counter when the foreground turn saved its own Workshop change", () => {
    const { turn, timers } = createHarness();

    turn(8);
    turn(1, { workshopMutated: true });
    turn(9);
    expect(timers).toHaveLength(0);
    turn(1);
    expect(timers).toHaveLength(1);
  });

  it("drops an already queued review when a later foreground turn saves its own change", async () => {
    const { turn, fireTimers, runReview, timers } = createHarness();

    turn(10);
    expect(timers).toHaveLength(1);
    turn(1, { workshopMutated: true });
    fireTimers();
    await setImmediate();
    expect(runReview).not.toHaveBeenCalled();
  });

  it("reviews right after a turn that used a learned skill, but not other skills", async () => {
    const { turn, fireTimers, runReview, timers } = createHarness();
    const workshopSkill = path.join(resolveWorkshopSkillsDir({}, "main"), "deploy", "SKILL.md");

    turn(1, {
      usedSkills: [
        { name: "notes", source: "workspace", activation: "read", skillFile: "/ws/notes/SKILL.md" },
      ],
    });
    expect(timers).toHaveLength(0);
    turn(1, {
      usedSkills: [
        { name: "deploy", source: "workspace", activation: "read", skillFile: workshopSkill },
      ],
    });
    expect(timers).toHaveLength(1);
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
    expect(timers).toHaveLength(0);
  });

  it("ignores errored turns and sessions while Workshop is off", () => {
    const { turn, timers } = createHarness();

    turn(8);
    turn(20, { event: { messages: [], success: false, error: "provider 500" } });
    turn(20, { config: { skills: { workshop: { autonomous: { mode: "off" } } } } });
    turn(8);
    expect(timers).toHaveLength(0);
  });

  it("never reviews ACP child sessions", () => {
    const { turn, timers } = createHarness();

    turn(20, { sessionKey: "agent:main:acp:child-1" });
    expect(timers).toHaveLength(0);
  });
});
