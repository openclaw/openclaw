import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { normalizeCommandBody } from "../commands-registry-normalize.js";
import { takeCommandSessionMetadataChanges } from "./command-session-metadata.js";
import { handleGoalCommand, parseGoalCommand } from "./commands-goal.js";
import type { HandleCommandsParams } from "./commands-types.js";
import { buildCommandTestParams } from "./commands.test-harness.js";
import { parseInlineSessionDirectives } from "./directive-handling.parse.js";

const sessionKey = "agent:main:web:main";
const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-goal-command-");

async function createStorePath(entry: Partial<SessionEntry> = {}): Promise<string> {
  const storePath = path.join(sessionDirs.make(), "sessions.json");
  await replaceSessionEntry(
    { sessionKey, storePath },
    { sessionId: "sess-main", updatedAt: 1, ...entry },
  );
  return storePath;
}

const freshTokens = { totalTokens: 0, totalTokensFresh: true, totalTokensVersion: 1 };

function goal(status: "active" | "paused"): NonNullable<SessionEntry["goal"]> {
  return {
    schemaVersion: 1,
    id: "goal-1",
    objective: "finish the migration",
    status,
    createdAt: 1,
    updatedAt: 1,
    tokenStart: 0,
    tokenStartFresh: true,
    tokensUsed: 0,
    continuationTurns: 0,
  };
}

function readGoal(storePath: string) {
  return loadSessionEntry({ sessionKey, storePath })?.goal;
}

function buildGoalParams(commandBodyNormalized: string, storePath: string): HandleCommandsParams {
  const params = buildCommandTestParams(
    commandBodyNormalized,
    {},
    { Provider: "web", Surface: "web" },
  );
  Object.assign(params.command, {
    commandBodyNormalized,
    rawBodyNormalized: commandBodyNormalized,
    isAuthorizedSender: true,
    senderIsOwner: true,
    senderId: "tester",
  });
  return { ...params, directives: {}, sessionKey, storePath, provider: "openai", model: "gpt-5.5" };
}

describe("goal commands", () => {
  it.each([
    ["status", ""],
    ["pause", "waiting on CI"],
    ["edit", "ship the fix and docs"],
  ])("keeps explicit goal action %s as a control", (action, text) => {
    expect(parseGoalCommand(`/goal ${action}${text ? ` ${text}` : ""}`)).toEqual({ action, text });
  });

  it("preserves the objective when starting with /goal", async () => {
    const storePath = await createStorePath(freshTokens);

    const objective = "build a 3d game\n\nKeep this exact label: a  b\n\tThen verify it.";
    const params = buildGoalParams(normalizeCommandBody(`/goal ${objective}`), storePath);
    const result = await handleGoalCommand(params, true);

    expect(result?.shouldContinue).toBe(true);
    expect(result?.reply).toBeUndefined();
    expect(params.command.commandBodyNormalized).toBe(objective);
    expect(params.ctx.BodyForAgent).toBe(objective);
    expect(readGoal(storePath)?.objective).toBe(objective);
    expect(takeCommandSessionMetadataChanges(params.ctx)).toEqual([
      { sessionKey, reason: "command-metadata" },
    ]);
  });

  it.each([
    ["/status", `"\\/status"`],
    ["!npm test", `"!npm test"`],
  ])("wraps command-prefixed goal objective %s before continuing", async (objective, encoded) => {
    const storePath = await createStorePath(freshTokens);
    const params = buildGoalParams(`/goal start ${objective}`, storePath);
    const result = await handleGoalCommand(params, true);
    const prompt = `Pursue this goal exactly as written from this JSON string: ${encoded}`;
    expect(result?.shouldContinue).toBe(true);
    expect(params).toMatchObject({
      command: { commandBodyNormalized: prompt },
      ctx: { BodyForAgent: prompt },
    });
    expect(readGoal(storePath)?.objective).toBe(objective);
  });

  it.each([
    ["CI passed", "Continue pursuing the current goal. Note: CI passed"],
    [
      "/fast off",
      `Continue pursuing the current goal. Interpret this JSON string as the resume note: "\\/fast off"`,
    ],
  ])("resumes a goal with a literal, directive-safe note: %s", async (note, prompt) => {
    const storePath = await createStorePath({ goal: goal("paused") });
    const params = buildGoalParams(`/goal resume ${note}`, storePath);
    const result = await handleGoalCommand(params, true);
    expect(result?.shouldContinue).toBe(true);
    expect(params).toMatchObject({
      command: { commandBodyNormalized: prompt },
      ctx: { BodyForAgent: prompt },
    });
    expect(parseInlineSessionDirectives(prompt)).toMatchObject({
      cleaned: prompt,
      hasFastDirective: false,
    });
    expect(readGoal(storePath)?.status).toBe("active");
  });

  it("edits the objective in place and replies without continuing", async () => {
    const storePath = await createStorePath({ goal: goal("active") });

    const params = buildGoalParams("/goal edit finish the migration and update docs", storePath);
    const result = await handleGoalCommand(params, true);

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toBe("Goal updated: finish the migration and update docs");
    expect(readGoal(storePath)).toMatchObject({
      objective: "finish the migration and update docs",
      status: "active",
    });
    expect(takeCommandSessionMetadataChanges(params.ctx)).toEqual([
      { sessionKey, reason: "command-metadata" },
    ]);
  });

  it("rejects goal edit without a goal or new objective", async () => {
    const storePath = await createStorePath();

    const usage = await handleGoalCommand(buildGoalParams("/goal edit", storePath), true);
    expect(usage?.reply?.text).toBe("Usage: /goal edit <objective>");

    const missing = await handleGoalCommand(
      buildGoalParams("/goal edit new target", storePath),
      true,
    );
    expect(missing?.reply?.text).toBe("Goal error: goal not found");
  });

  it("renders status without persisting derived budget state", async () => {
    const storePath = await createStorePath({
      ...freshTokens,
      totalTokens: 25,
      goal: { ...goal("active"), tokenBudget: 20 },
    });

    const params = buildGoalParams("/goal status", storePath);
    const result = await handleGoalCommand(params, true);

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("Status: budget_limited");
    expect(readGoal(storePath)?.status).toBe("active");
    expect(takeCommandSessionMetadataChanges(params.ctx)).toBeUndefined();
  });
});
