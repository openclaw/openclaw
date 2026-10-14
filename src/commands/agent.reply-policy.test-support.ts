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
  it.each([
    {
      name: "global tool-only",
      messages: { visibleReplies: "message_tool" },
      expected: "message_tool_only",
    },
    {
      name: "message unavailable",
      denyMessage: true,
      messages: { visibleReplies: "message_tool" },
      expected: "automatic",
    },
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
      const chatType = "direct";
      const sessionKey = "agent:main:telegram:direct:requester";
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
