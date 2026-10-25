import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { normalizeCommandBody } from "../commands-registry-normalize.js";
import { takeCommandSessionMetadataChanges } from "./command-session-metadata.js";
import { handleGoalCommand, parseGoalCommand } from "./commands-goal.js";
import { commandFixture } from "./commands-handler-fixture.test-support.js";
import type { HandleCommandsParams } from "./commands-types.js";
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
      totalTokensVersion: 1,
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

function buildGoalParams(commandBodyNormalized: string, storePath: string): HandleCommandsParams {
  return commandFixture(
    commandBodyNormalized,
    {
      cfg: {},
      ctx: { Provider: "web", Surface: "web", CommandSource: "text" },
      directives: {},
      sessionKey,
      agentId: "main",
      storePath,
      workspaceDir: "/tmp",
      sessionEntry: undefined,
      provider: "openai",
      model: "gpt-5.5",
    },
    { senderId: "tester", channel: "web", channelId: "web", surface: "web" },
  );
}

describe("goal commands", () => {
  it("keeps explicit goal actions as controls", () => {
    expect(parseGoalCommand("/goal status")).toEqual({ action: "status", text: "" });
    expect(parseGoalCommand("/goal pause waiting on CI")).toEqual({
      action: "pause",
      text: "waiting on CI",
    });
    expect(parseGoalCommand("/goal edit ship the fix and docs")).toEqual({
      action: "edit",
      text: "ship the fix and docs",
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

  it("resumes a goal and continues with a resume prompt", async () => {
    const storePath = await seedGoalStore("paused");

    const params = buildGoalParams("/goal resume CI passed", storePath);
    const result = await handleGoalCommand(params, true);

    expect(result?.shouldContinue).toBe(true);
    expect(params.command.commandBodyNormalized).toBe(
      "Continue pursuing the current goal. Note: CI passed",
    );
    expect(readGoal(storePath)?.status).toBe("active");
  });

  it("wraps command-looking resume notes before continuing", async () => {
    const storePath = await seedGoalStore("paused");

    const params = buildGoalParams("/goal resume /fast off", storePath);
    const result = await handleGoalCommand(params, true);
    const prompt = `Continue pursuing the current goal. Interpret this JSON string as the resume note: "\\/fast off"`;
    const directives = parseInlineSessionDirectives(prompt);

    expect(result?.shouldContinue).toBe(true);
    expect(params.command.commandBodyNormalized).toBe(prompt);
    expect((params.ctx as { BodyForAgent?: string }).BodyForAgent).toBe(prompt);
    expect(directives.cleaned).toBe(prompt);
    expect(directives.hasFastDirective).toBe(false);
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
