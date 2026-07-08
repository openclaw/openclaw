// Wire-contract integration: exit_plan_mode parks on the PR-A question, /plan accept resolves
// it through the same process-global manager, and the tool returns approved with state cleared.
// This asserts the real tool <-> QuestionManager <-> channel-command seam, not a mock of either.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createExitPlanModeTool } from "../../agents/tools/plan-mode-tools.js";
import { enterPlanMode, getSessionPlanState } from "../../config/sessions.js";
import { upsertSessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resetGlobalQuestionManagerForTest } from "../../gateway/question-manager.js";
import { handlePlanCommand } from "./commands-plan.js";
import type { HandleCommandsParams } from "./commands-types.js";

const sessionKey = "agent:main:web:main";
let tempRoots: string[] = [];
let stateDir = "";
let priorStateDir: string | undefined;

beforeEach(() => {
  resetGlobalQuestionManagerForTest();
  priorStateDir = process.env.OPENCLAW_STATE_DIR;
});

afterEach(async () => {
  await Promise.all(tempRoots.map((root) => fs.rm(root, { recursive: true, force: true })));
  tempRoots = [];
  if (priorStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = priorStateDir;
  }
  if (stateDir) {
    await fs.rm(stateDir, { recursive: true, force: true });
  }
  resetGlobalQuestionManagerForTest();
});

async function createStorePath(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-plan-wire-"));
  tempRoots.push(root);
  return path.join(root, "sessions.json");
}

function planParams(commandBody: string, storePath: string): HandleCommandsParams {
  return {
    cfg: {} as OpenClawConfig,
    ctx: { Provider: "web", Surface: "web", CommandSource: "text" },
    command: {
      commandBodyNormalized: commandBody,
      isAuthorizedSender: true,
      senderIsOwner: true,
      senderId: "tester",
      channel: "web",
      channelId: "web",
      surface: "web",
      ownerList: [],
      rawBodyNormalized: commandBody,
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

async function driveCommandWhenQuestionReady(command: string, storePath: string): Promise<void> {
  // The exit tool sets pending_approval synchronously before awaiting; poll then dispatch.
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const snapshot = await getSessionPlanState({ storePath, sessionKey });
    if (snapshot.status === "pending_approval") {
      await handlePlanCommand(planParams(command, storePath), true);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("exit_plan_mode never reached pending_approval");
}

describe("plan approval wire contract", () => {
  it("/plan accept resolves exit_plan_mode -> approved and clears plan state", async () => {
    const storePath = await createStorePath();
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-plan-wire-state-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    await upsertSessionEntry({
      storePath,
      sessionKey,
      entry: { sessionId: "s", updatedAt: 1, totalTokens: 0, totalTokensFresh: true },
    });
    await enterPlanMode({ storePath, sessionKey });

    const exitTool = createExitPlanModeTool({
      runSessionKey: sessionKey,
      sessionAgentId: "main",
      config: { session: { store: storePath } } as OpenClawConfig,
    });
    const resultPromise = exitTool.execute("c1", { plan_summary: "Ship it" }, undefined, undefined);
    await driveCommandWhenQuestionReady("/plan accept", storePath);

    const details = ((await resultPromise) as unknown as { details: { status: string } }).details;
    expect(details.status).toBe("approved");
    expect((await getSessionPlanState({ storePath, sessionKey })).status).toBe("inactive");
  });

  it("/plan reject resolves exit_plan_mode -> revise and returns to planning", async () => {
    const storePath = await createStorePath();
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-plan-wire-state2-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    await upsertSessionEntry({
      storePath,
      sessionKey,
      entry: { sessionId: "s", updatedAt: 1, totalTokens: 0, totalTokensFresh: true },
    });
    await enterPlanMode({ storePath, sessionKey });

    const exitTool = createExitPlanModeTool({
      runSessionKey: sessionKey,
      sessionAgentId: "main",
      config: { session: { store: storePath } } as OpenClawConfig,
    });
    const resultPromise = exitTool.execute("c1", { plan_summary: "Ship it" }, undefined, undefined);
    await driveCommandWhenQuestionReady("/plan reject needs rollback steps", storePath);

    const details = (
      (await resultPromise) as unknown as { details: { status: string; feedback?: string } }
    ).details;
    expect(details.status).toBe("revise");
    expect(details.feedback).toBe("needs rollback steps");
    expect((await getSessionPlanState({ storePath, sessionKey })).status).toBe("planning");
  });
});
