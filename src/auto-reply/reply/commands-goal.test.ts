import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { SESSION_TOTAL_TOKENS_VERSION, type SessionEntry } from "../../config/sessions/types.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { normalizeCommandBody } from "../commands-registry-normalize.js";
import { takeCommandSessionMetadataChanges } from "./command-session-metadata.js";
import { handleGoalCommand, parseGoalCommand } from "./commands-goal.js";
import { commandFixture } from "./commands-handler-fixture.test-support.js";
import { parseInlineSessionDirectives } from "./directive-handling.parse.js";

const sessionKey = "agent:main:web:main";
const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-goal-command-");

async function seedGoalStore(status?: "active" | "paused", budgetLimited = false) {
  const storePath = path.join(sessionDirs.make(), "sessions.json");
  const entry: SessionEntry = { sessionId: "sess-main", updatedAt: 1 };
  if (!status || budgetLimited) {
    Object.assign(entry, {
      totalTokens: budgetLimited ? 25 : 0,
      totalTokensFresh: true,
      totalTokensVersion: SESSION_TOTAL_TOKENS_VERSION,
    });
  }
  if (status) {
    entry.goal = {
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
      ...(budgetLimited ? { tokenBudget: 20 } : {}),
    };
  }
  await replaceSessionEntry({ storePath, sessionKey }, entry);
  return storePath;
}

const readGoal = (storePath: string) => loadSessionEntry({ storePath, sessionKey })?.goal;

function buildGoalParams(body: string, storePath: string) {
  return commandFixture(body, { sessionKey, agentId: "main", storePath, sessionEntry: undefined });
}

describe("goal commands", () => {
  it("keeps pause actions separate from goal objectives", () => {
    expect(parseGoalCommand("/goal pause waiting on CI")).toEqual({
      action: "pause",
      text: "waiting on CI",
    });
  });

  it("preserves the objective when starting with /goal", async () => {
    const storePath = await seedGoalStore();

    const objective = "build a 3d game\n\nKeep this exact label: a  b\n\tThen verify it.";
    const params = buildGoalParams(normalizeCommandBody(`/goal ${objective}`), storePath);
    const result = await handleGoalCommand(params, true);

    expect(result?.shouldContinue).toBe(true);
    expect(result?.reply).toBeUndefined();
    expect(params.command.commandBodyNormalized).toBe(objective);
    expect((params.ctx as { BodyForAgent?: string }).BodyForAgent).toBe(objective);
    expect(readGoal(storePath)?.objective).toBe(objective);
    expect(takeCommandSessionMetadataChanges(params.ctx)).toEqual([
      { sessionKey, agentId: "main", reason: "command-metadata" },
    ]);
  });

  it.each([
    ["/status", `Pursue this goal exactly as written from this JSON string: "\\/status"`],
    ["!npm test", `Pursue this goal exactly as written from this JSON string: "!npm test"`],
  ])("wraps command-prefixed goal objective %s before continuing", async (objective, prompt) => {
    const storePath = await seedGoalStore();
    const params = buildGoalParams(`/goal start ${objective}`, storePath);
    expect((await handleGoalCommand(params, true))?.shouldContinue).toBe(true);
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
  ])("resumes without interpreting the note as a command: %s", async (note, prompt) => {
    const storePath = await seedGoalStore("paused");
    const params = buildGoalParams(`/goal resume ${note}`, storePath);
    expect((await handleGoalCommand(params, true))?.shouldContinue).toBe(true);
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
    const storePath = await seedGoalStore("active");

    const params = buildGoalParams("/goal edit finish the migration and update docs", storePath);
    const result = await handleGoalCommand(params, true);

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toBe("Goal updated: finish the migration and update docs");
    const goal = readGoal(storePath);
    expect(goal).toMatchObject({
      objective: "finish the migration and update docs",
      status: "active",
    });
    expect(takeCommandSessionMetadataChanges(params.ctx)).toEqual([
      { sessionKey, agentId: "main", reason: "command-metadata" },
    ]);
  });

  it("rejects goal edit without a goal or new objective", async () => {
    const storePath = await seedGoalStore();

    const usage = await handleGoalCommand(buildGoalParams("/goal edit", storePath), true);
    expect(usage?.reply?.text).toBe("Usage: /goal edit <objective>");

    const missing = await handleGoalCommand(
      buildGoalParams("/goal edit new target", storePath),
      true,
    );
    expect(missing?.reply?.text).toBe("Goal error: goal not found");
  });

  it("renders status without persisting derived budget state", async () => {
    const storePath = await seedGoalStore("active", true);

    const params = buildGoalParams("/goal status", storePath);
    const result = await handleGoalCommand(params, true);

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toContain("Status: budget_limited");
    expect(readGoal(storePath)?.status).toBe("active");
    expect(takeCommandSessionMetadataChanges(params.ctx)).toBeUndefined();
  });
});
