// exit_plan_mode lifecycle: persists a plan file, parks on the PR-A question, and returns
// approved / revise / expired based on how the question is resolved.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getSessionPlanState } from "../../config/sessions/plan-state.js";
import { upsertSessionEntry } from "../../config/sessions/store.js";
import { useTempSessionsFixture } from "../../config/sessions/test-helpers.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  getGlobalQuestionManager,
  resetGlobalQuestionManagerForTest,
} from "../../gateway/question-manager.js";
import { createEnterPlanModeTool, createExitPlanModeTool } from "./plan-mode-tools.js";

describe("plan-mode lifecycle tools", () => {
  const fixture = useTempSessionsFixture("openclaw-plan-tools-");
  const sessionKey = "agent:main:telegram:direct:777";
  let stateDir = "";
  let priorStateDir: string | undefined;

  beforeEach(() => {
    resetGlobalQuestionManagerForTest();
    priorStateDir = process.env.OPENCLAW_STATE_DIR;
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-plan-state-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
  });

  afterEach(() => {
    if (priorStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = priorStateDir;
    }
    fs.rmSync(stateDir, { recursive: true, force: true });
    resetGlobalQuestionManagerForTest();
  });

  function config(): OpenClawConfig {
    return { session: { store: fixture.storePath() } } as OpenClawConfig;
  }

  function options() {
    return { runSessionKey: sessionKey, sessionAgentId: "main", config: config() };
  }

  async function seedSession(): Promise<void> {
    await upsertSessionEntry({
      storePath: fixture.storePath(),
      sessionKey,
      entry: { sessionId: "sess-1", updatedAt: 1, totalTokens: 0, totalTokensFresh: true },
    });
  }

  async function resolvePendingQuestion(answer: string): Promise<void> {
    // The tool registers the question synchronously; poll briefly for it to appear.
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const [record] = getGlobalQuestionManager().list();
      if (record) {
        getGlobalQuestionManager().resolve(record.id, { q1: { text: answer } });
        return;
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 5);
      });
    }
    throw new Error("pending plan-approval question never registered");
  }

  it("enter_plan_mode flips the session into planning", async () => {
    await seedSession();
    const tool = createEnterPlanModeTool(options());
    await tool.execute("call-1", {}, undefined, undefined);
    const snapshot = await getSessionPlanState({ storePath: fixture.storePath(), sessionKey });
    expect(snapshot.status).toBe("planning");
  });

  it("exit_plan_mode approve: writes plan file, returns approved, clears state", async () => {
    await seedSession();
    await createEnterPlanModeTool(options()).execute("c1", {}, undefined, undefined);
    const exitTool = createExitPlanModeTool(options());
    const resultPromise = exitTool.execute(
      "c2",
      { plan_summary: "Ship the feature\n1. do a\n2. do b" },
      undefined,
      undefined,
    );
    await resolvePendingQuestion("Approve plan");
    const result = (await resultPromise) as { content: unknown[]; details?: unknown };
    const details = (result as unknown as { details: { status: string; planFilePath: string } })
      .details;
    expect(details.status).toBe("approved");
    expect(fs.existsSync(details.planFilePath)).toBe(true);
    const snapshot = await getSessionPlanState({ storePath: fixture.storePath(), sessionKey });
    expect(snapshot.status).toBe("inactive");
  });

  it("exit_plan_mode reject (Other feedback): returns revise + feedback, back to planning", async () => {
    await seedSession();
    await createEnterPlanModeTool(options()).execute("c1", {}, undefined, undefined);
    const exitTool = createExitPlanModeTool(options());
    const resultPromise = exitTool.execute("c2", { plan_summary: "Ship it" }, undefined, undefined);
    await resolvePendingQuestion("please add rollback steps");
    const details = (
      (await resultPromise) as unknown as {
        details: { status: string; feedback?: string };
      }
    ).details;
    expect(details.status).toBe("revise");
    expect(details.feedback).toBe("please add rollback steps");
    const snapshot = await getSessionPlanState({ storePath: fixture.storePath(), sessionKey });
    expect(snapshot.status).toBe("planning");
    expect(snapshot.plan?.lastFeedback).toBe("please add rollback steps");
  });

  it("exit_plan_mode 'Keep planning': returns revise with no feedback", async () => {
    await seedSession();
    await createEnterPlanModeTool(options()).execute("c1", {}, undefined, undefined);
    const exitTool = createExitPlanModeTool(options());
    const resultPromise = exitTool.execute("c2", { plan_summary: "Ship it" }, undefined, undefined);
    await resolvePendingQuestion("Keep planning");
    const details = (
      (await resultPromise) as unknown as { details: { status: string; feedback?: string } }
    ).details;
    expect(details.status).toBe("revise");
    expect(details.feedback).toBeUndefined();
  });
});
