import { assert, afterEach, describe, expect, it } from "vitest";
import type { SubagentRunRecord } from "../../agents/subagents/registry/subagent-registry.js";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/config.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import type { TemplateContext } from "../templating.js";
import { buildThreadingToolContext } from "./agent-runner-utils.js";
import { applyReplyThreading } from "./reply-payloads-base.js";
import { formatRunLabel, resolveSubagentLabel } from "./subagents-utils.js";

describe("buildThreadingToolContext", () => {
  afterEach(() => {
    resetPluginRuntimeStateForTest();
  });

  it("uses the recipient id for other channels", () => {
    const result = buildThreadingToolContext({
      sessionCtx: { Provider: "telegram", From: "user:42", To: "chat:99" },
      config: {},
      hasRepliedRef: undefined,
    });

    expect(result.currentChannelId).toBe("chat:99");
  });

  it("lets plugin threading adapters suppress the generic message-id fallback", () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "googlechat",
          plugin: {
            ...createChannelTestPluginBase({ id: "googlechat", label: "Google Chat" }),
            threading: {
              buildToolContext: ({ context }) => ({
                currentChannelId: context.To?.replace(/^googlechat:/, ""),
                currentMessageId: undefined,
                currentThreadTs: context.ReplyToIdFull ?? context.ReplyToId,
              }),
            },
          } as ChannelPlugin,
          source: "test",
        },
      ]),
    );
    const sessionCtx = {
      Provider: "googlechat",
      To: "googlechat:spaces/AAA",
      MessageSidFull: "spaces/AAA/messages/msg-1",
      ReplyToId: "spaces/AAA/threads/short",
      ReplyToIdFull: "spaces/AAA/threads/full",
    } as TemplateContext;

    const result = buildThreadingToolContext({
      sessionCtx,
      config: { channels: { googlechat: { replyToMode: "all" } } } as OpenClawConfig,
      hasRepliedRef: undefined,
    });

    expect([result.currentChannelId, result.currentThreadTs, result.currentMessageId]).toEqual([
      "spaces/AAA",
      "spaces/AAA/threads/full",
      undefined,
    ]);
  });
});

describe("applyReplyThreading auto-threading", () => {
  type ThreadingCase = [
    string,
    string,
    Omit<Parameters<typeof applyReplyThreading>[0], "payloads" | "currentMessageId">,
    { replyToId?: string; replyToTag?: boolean; text?: string },
  ];
  it.each<ThreadingCase>([
    [
      "deny implicit",
      "Hello",
      { replyToMode: "batched", replyThreading: { implicitCurrentMessage: "deny" } },
      { replyToId: undefined },
    ],
    ["Slack off", "A", { replyToMode: "off", replyToChannel: "slack" }, { replyToId: undefined }],
    [
      "Telegram explicit",
      "[[reply_to_current]]A",
      { replyToMode: "off", replyToChannel: "telegram" },
      { replyToId: "42", replyToTag: true },
    ],
    [
      "explicit id",
      "[[reply_to:mm-post-xyz789]] threaded reply",
      { replyToMode: "all" },
      { replyToId: "mm-post-xyz789", text: "threaded reply" },
    ],
  ])("%s", (_name, text, options, expected) => {
    const result = applyReplyThreading({
      payloads: [{ text }],
      currentMessageId: "42",
      ...options,
    });
    expect(result).toHaveLength(1);
    const payload = result[0];
    assert(payload);
    expect(payload.replyToId).toBe(expected.replyToId);
    if (expected.replyToTag !== undefined) {
      expect(payload.replyToTag).toBe(expected.replyToTag);
    }
    if (expected.text !== undefined) {
      expect(payload.text).toBe(expected.text);
    }
  });
});

const baseRun: SubagentRunRecord = {
  runId: "run-1",
  childSessionKey: "agent:main:subagent:abc",
  requesterSessionKey: "agent:main:main",
  requesterDisplayKey: "main",
  task: "do thing",
  cleanup: "keep",
  createdAt: 1000,
  execution: { status: "running", startedAt: 1000 },
};

describe("subagents utils", () => {
  it("resolves labels from label, task, or fallback", () => {
    expect(resolveSubagentLabel({ ...baseRun, label: "Label" })).toBe("Label");
    expect(resolveSubagentLabel({ ...baseRun, label: " ", task: "Task" })).toBe("Task");
    expect(resolveSubagentLabel({ ...baseRun, label: " ", task: " " }, "fallback")).toBe(
      "fallback",
    );
  });

  it("formats run labels with truncation", () => {
    const formatted = formatRunLabel({ ...baseRun, label: "x".repeat(100) }, { maxLength: 10 });
    expect(formatted.startsWith("x".repeat(10))).toBe(true);
    expect(formatted.endsWith("…")).toBe(true);
  });

  it("sanitizes leaked internal runtime context from formatted run labels", () => {
    const run = {
      ...baseRun,
      label: [
        "OpenClaw runtime context (internal):",
        "This context is runtime-generated, not user-authored. Keep internal details private.",
        "",
        "[Internal task completion event]",
        "source: subagent",
      ].join("\n"),
    };

    expect(formatRunLabel(run)).toBe("subagent");
  });
});
