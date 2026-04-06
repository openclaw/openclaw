import { beforeEach, describe, expect, it } from "vitest";
import {
  addSubagentRunForTests,
  resetSubagentRegistryForTests,
} from "../../agents/subagent-registry.test-helpers.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { ReplyPayload } from "../types.js";
import { buildStatusReply } from "./commands-status.js";
import type { CommandHandlerResult } from "./commands-types.js";

async function buildStatusReplyForTests(params: {
  cfg: OpenClawConfig;
  sessionKey?: string;
  verbose?: boolean;
}): Promise<CommandHandlerResult> {
  const sessionKey = params.sessionKey ?? "agent:main:main";
  const reply = await buildStatusReply({
    cfg: params.cfg,
    command: {
      isAuthorizedSender: true,
      channel: "whatsapp",
      senderId: "owner",
    } as never,
    sessionEntry: {
      sessionId: "status-session",
      updatedAt: Date.now(),
    },
    sessionKey,
    parentSessionKey: sessionKey,
    provider: "anthropic",
    model: "claude-opus-4-6",
    contextTokens: 0,
    resolvedFastMode: false,
    resolvedVerboseLevel: params.verbose ? "on" : "off",
    resolvedReasoningLevel: "off",
    resolvedElevatedLevel: "off",
    resolveDefaultThinkingLevel: async () => undefined,
    isGroup: false,
    defaultGroupActivation: () => "mention",
  });
  return { shouldContinue: false, reply };
}

function requireReplyText(reply: ReplyPayload | undefined): string {
  expect(reply?.text).toBeDefined();
  return reply?.text as string;
}

beforeEach(() => {
  resetSubagentRegistryForTests();
});

describe("subagents status", () => {
  it.each([
    {
      name: "omits subagent status line when none exist",
      seedRuns: () => undefined,
      verboseLevel: "on" as const,
      expectedText: [] as string[],
      unexpectedText: ["Subagents:"],
    },
    {
      name: "includes subagent count in /status when active",
      seedRuns: () => {
        addSubagentRunForTests({
          runId: "run-1",
          childSessionKey: "agent:main:subagent:abc",
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          task: "do thing",
          cleanup: "keep",
          createdAt: 1000,
          startedAt: 1000,
        });
      },
      verboseLevel: "off" as const,
      expectedText: ["🤖 Subagents: 1 active"],
      unexpectedText: [] as string[],
    },
    {
      name: "includes subagent details in /status when verbose",
      seedRuns: () => {
        addSubagentRunForTests({
          runId: "run-1",
          childSessionKey: "agent:main:subagent:abc",
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          task: "do thing",
          cleanup: "keep",
          createdAt: 1000,
          startedAt: 1000,
        });
        addSubagentRunForTests({
          runId: "run-2",
          childSessionKey: "agent:main:subagent:def",
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          task: "finished task",
          cleanup: "keep",
          createdAt: 900,
          startedAt: 900,
          endedAt: 1200,
          outcome: { status: "ok" },
        });
      },
      verboseLevel: "on" as const,
      expectedText: ["🤖 Subagents: 1 active", "· 1 done"],
      unexpectedText: [] as string[],
    },
  ])("$name", async ({ seedRuns, verboseLevel, expectedText, unexpectedText }) => {
    seedRuns();
    const cfg = {
      commands: { text: true },
      channels: { whatsapp: { allowFrom: ["*"] } },
      session: { mainKey: "main", scope: "per-sender" },
    } as OpenClawConfig;
    const result = await buildStatusReplyForTests({
      cfg,
      verbose: verboseLevel === "on",
    });
    expect(result.shouldContinue).toBe(false);
    const text = requireReplyText(result.reply);
    for (const expected of expectedText) {
      expect(text).toContain(expected);
    }
    for (const blocked of unexpectedText) {
      expect(text).not.toContain(blocked);
    }
  });
});
