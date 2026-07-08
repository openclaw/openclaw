// /plan command: parsing, status rendering, and accept/reject resolving the pending question.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildPlanApprovalQuestion } from "../../agents/plan-mode/approval.js";
import { enterPlanMode, getSessionPlanState } from "../../config/sessions.js";
import { upsertSessionEntry } from "../../config/sessions.js";
import { setPlanPendingApproval } from "../../config/sessions/plan-state.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  getGlobalQuestionManager,
  resetGlobalQuestionManagerForTest,
} from "../../gateway/question-manager.js";
import { handlePlanCommand, parsePlanCommand } from "./commands-plan.js";
import type { HandleCommandsParams } from "./commands-types.js";

const sessionKey = "agent:main:web:main";
let tempRoots: string[] = [];

beforeEach(() => resetGlobalQuestionManagerForTest());
afterEach(async () => {
  await Promise.all(tempRoots.map((root) => fs.rm(root, { recursive: true, force: true })));
  tempRoots = [];
  resetGlobalQuestionManagerForTest();
});

async function createStorePath(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-plan-command-"));
  tempRoots.push(root);
  return path.join(root, "sessions.json");
}

function buildPlanParams(commandBodyNormalized: string, storePath: string): HandleCommandsParams {
  return {
    cfg: {} as OpenClawConfig,
    ctx: { Provider: "web", Surface: "web", CommandSource: "text" },
    command: {
      commandBodyNormalized,
      isAuthorizedSender: true,
      senderIsOwner: true,
      senderId: "tester",
      channel: "web",
      channelId: "web",
      surface: "web",
      ownerList: [],
      rawBodyNormalized: commandBodyNormalized,
    },
    directives: {},
    elevated: { enabled: true, allowed: true, failures: [] },
    sessionKey,
    storePath,
    workspaceDir: "/tmp",
    provider: "openai",
    model: "gpt-5.5",
    contextTokens: 0,
    defaultGroupActivation: () => "mention",
    resolvedVerboseLevel: "off",
    resolvedReasoningLevel: "off",
    resolveDefaultThinkingLevel: async () => undefined,
    isGroup: false,
  } as unknown as HandleCommandsParams;
}

async function seedSession(storePath: string): Promise<void> {
  await upsertSessionEntry({
    storePath,
    sessionKey,
    entry: { sessionId: "s", updatedAt: 1, totalTokens: 0, totalTokensFresh: true },
  });
}

describe("plan commands", () => {
  it("parses /plan actions and defaults to status", () => {
    expect(parsePlanCommand("/plan")).toEqual({ action: "status", text: "" });
    expect(parsePlanCommand("/plan show")).toEqual({ action: "show", text: "" });
    expect(parsePlanCommand("/plan reject add more tests")).toEqual({
      action: "reject",
      text: "add more tests",
    });
    expect(parsePlanCommand("/goal foo")).toBeNull();
  });

  it("reports not-in-plan-mode for /plan show when inactive", async () => {
    const storePath = await createStorePath();
    await seedSession(storePath);
    const result = await handlePlanCommand(buildPlanParams("/plan show", storePath), true);
    expect(result?.reply?.text).toMatch(/Not in plan mode/);
  });

  it("enters plan mode from /plan enter", async () => {
    const storePath = await createStorePath();
    await seedSession(storePath);
    const result = await handlePlanCommand(buildPlanParams("/plan enter", storePath), true);
    expect(result?.reply?.text).toMatch(/Entered plan mode/);
    expect((await getSessionPlanState({ storePath, sessionKey })).status).toBe("planning");
  });

  it("/plan accept resolves the pending plan-approval question", async () => {
    const storePath = await createStorePath();
    await seedSession(storePath);
    await enterPlanMode({ storePath, sessionKey });
    const { record, wait } = getGlobalQuestionManager().register({
      id: "plan-approval-main-123",
      sessionKey,
      agentId: "main",
      questions: [buildPlanApprovalQuestion("do it")],
    });
    await setPlanPendingApproval({
      storePath,
      sessionKey,
      planFilePath: "/tmp/plan.md",
      pendingQuestionId: record.id,
    });

    const result = await handlePlanCommand(buildPlanParams("/plan accept", storePath), true);
    expect(result?.reply?.text).toMatch(/approved/i);
    const answers = await wait;
    expect(answers?.q1?.text).toBe("Approve plan");
  });

  it("/plan reject <feedback> resolves the question with the feedback text", async () => {
    const storePath = await createStorePath();
    await seedSession(storePath);
    await enterPlanMode({ storePath, sessionKey });
    const { record, wait } = getGlobalQuestionManager().register({
      id: "plan-approval-main-456",
      sessionKey,
      agentId: "main",
      questions: [buildPlanApprovalQuestion("do it")],
    });
    await setPlanPendingApproval({
      storePath,
      sessionKey,
      planFilePath: "/tmp/plan.md",
      pendingQuestionId: record.id,
    });

    const result = await handlePlanCommand(
      buildPlanParams("/plan reject please add rollback", storePath),
      true,
    );
    expect(result?.reply?.text).toMatch(/revision/i);
    const answers = await wait;
    expect(answers?.q1?.text).toBe("please add rollback");
  });

  it("/plan accept with no pending question replies gracefully", async () => {
    const storePath = await createStorePath();
    await seedSession(storePath);
    const result = await handlePlanCommand(buildPlanParams("/plan accept", storePath), true);
    expect(result?.reply?.text).toMatch(/No plan is awaiting approval/);
  });
});
