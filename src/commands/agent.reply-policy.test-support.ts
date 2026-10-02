// Registered in the command suite to reuse its runtime and database fixture.
import path from "node:path";
import { expect, it, vi } from "vitest";
import { prepareAgentCommandExecution } from "../agents/command/prepare.js";
import { resolveSessionStableReplyMode } from "../auto-reply/reply/session-stable-reply-mode.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeEnv } from "../runtime.js";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";
import { writeSessionStoreSeed } from "./agent-session.test-support.js";

export function registerAgentReplyPolicyTests({
  withTempHome,
  mockConfig,
  runtime,
}: {
  withTempHome: <T>(fn: (home: string) => Promise<T>) => Promise<T>;
  mockConfig: (
    home: string,
    storePath: string,
    agentOverrides?: Partial<NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>>,
  ) => OpenClawConfig;
  runtime: RuntimeEnv;
}) {
  it("keeps synthetic direct-DM delivery mode out of existing CLI binding facts", async () => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      const sessionKey = "agent:main:discord:direct:requester";
      await writeSessionStoreSeed(store, {
        [sessionKey]: {
          sessionId: "requester-session",
          updatedAt: Date.now(),
          chatType: "direct",
          modelProvider: "anthropic",
          model: "claude-opus-4-6",
          cliSessionBindings: {
            "claude-cli": {
              sessionId: "native-claude-session",
              messageToolPolicyHash: "automatic-policy-hash",
            },
          },
          delivery: normalizeSessionDeliveryState({
            context: { channel: "discord", to: "user:requester" },
            origin: { provider: "discord", chatType: "direct", to: "user:requester" },
          }),
        },
      });
      const cfg = mockConfig(home, store, {
        models: {
          "anthropic/claude-opus-4-6": { agentRuntime: { id: "claude-cli" } },
        },
      });
      cfg.messages = { visibleReplies: "automatic" };

      const prepared = await prepareAgentCommandExecution(
        {
          message: "child completed",
          sessionKey,
          sourceReplyDeliveryMode: "message_tool_only",
          inputProvenance: {
            kind: "inter_session",
            sourceSessionKey: "agent:main:subagent:child",
            sourceTool: "subagent_announce",
          },
        },
        runtime,
      );

      expect(prepared.opts.sourceReplyDeliveryMode).toBe("message_tool_only");
      expect(prepared.opts.cliSessionBindingFacts).toEqual({
        sourceReplyDeliveryMode: "automatic",
      });
      expect(prepared.sessionEntry?.cliSessionBindings?.["claude-cli"]).toMatchObject({
        sessionId: "native-claude-session",
        messageToolPolicyHash: "automatic-policy-hash",
      });
    });
  });

  it.each([
    {
      name: "global tool-only",
      messages: { visibleReplies: "message_tool" },
      expected: "message_tool_only",
    },
    { name: "global automatic", messages: { visibleReplies: "automatic" }, expected: "automatic" },
    {
      name: "group automatic override",
      group: true,
      messages: { visibleReplies: "message_tool", groupChat: { visibleReplies: "automatic" } },
      expected: "automatic",
    },
    {
      name: "group tool-only override",
      group: true,
      messages: { visibleReplies: "automatic", groupChat: { visibleReplies: "message_tool" } },
      expected: "message_tool_only",
    },
    {
      name: "message unavailable",
      denyMessage: true,
      messages: { visibleReplies: "message_tool" },
      expected: "automatic",
    },
    { name: "default group", group: true, messages: {}, expected: "automatic" },
    {
      name: "private turn override",
      requested: "automatic",
      messages: { visibleReplies: "message_tool" },
      expected: "automatic",
      stable: "message_tool_only",
    },
  ] as const)("applies $name to an effective requester-settle run", async (testCase) => {
    await withTempHome(async (home) => {
      const store = path.join(home, "sessions.json");
      const chatType = "group" in testCase ? "group" : "direct";
      const sessionKey = "agent:main:telegram:" + chatType + ":requester";
      await writeSessionStoreSeed(store, {
        [sessionKey]: {
          sessionId: "requester-session",
          updatedAt: Date.now(),
          chatType,
          delivery: normalizeSessionDeliveryState({
            context: { channel: "telegram", to: "requester" },
            origin: { provider: "telegram", chatType, to: "requester" },
          }),
        },
      });
      const cfg = mockConfig(home, store, { models: {} });
      cfg.messages = testCase.messages;
      if ("denyMessage" in testCase) {
        cfg.tools = { deny: ["message"] };
      }
      const replyPolicy = await vi.importActual<
        typeof import("../auto-reply/reply/session-stable-reply-mode.js")
      >("../auto-reply/reply/session-stable-reply-mode.js");
      vi.mocked(resolveSessionStableReplyMode).mockImplementationOnce(
        replyPolicy.resolveSessionStableReplyMode,
      );
      const prepared = await prepareAgentCommandExecution(
        {
          message: "settled child findings",
          sessionKey,
          deliver: true,
          ...("requested" in testCase ? { sourceReplyDeliveryMode: testCase.requested } : {}),
          inputProvenance: { kind: "inter_session", sourceTool: "subagent_settle" },
        },
        runtime,
      );
      expect(prepared.opts.sourceReplyDeliveryMode).toBe(testCase.expected);
      expect(prepared.opts.cliSessionBindingFacts?.sourceReplyDeliveryMode).toBe(
        "stable" in testCase ? testCase.stable : testCase.expected,
      );
    });
  });
}
