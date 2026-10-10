// Tests reply plumbing helpers that connect payloads, routes, and delivery modes.

import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it } from "vitest";
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
  const cfg = {} as OpenClawConfig;

  afterEach(() => {
    resetPluginRuntimeStateForTest();
  });

  it.each([
    [
      "uses the recipient id for other channels",
      { Provider: "telegram", From: "user:42", To: "chat:99" },
      "chat:99",
    ],
  ])("%s", (_name, sessionCtx, expectedChannelId) => {
    const result = buildThreadingToolContext({
      sessionCtx: { ...sessionCtx } as TemplateContext,
      config: cfg,
      hasRepliedRef: undefined,
    });

    expect(result.currentChannelId).toBe(expectedChannelId);
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

    expect(result.currentChannelId).toBe("spaces/AAA");
    expect(result.currentThreadTs).toBe("spaces/AAA/threads/full");
    expect(result.currentMessageId).toBeUndefined();
  });
});

describe("applyReplyThreading auto-threading", () => {
  it("can disable implicit reply threading for the current turn", () => {
    const result = applyReplyThreading({
      payloads: [{ text: "Hello" }],
      replyToMode: "batched",
      currentMessageId: "42",
      replyThreading: { implicitCurrentMessage: "deny" },
    });

    expect(result).toHaveLength(1);
    expect(expectDefined(result[0], "result[0] test invariant").replyToId).toBeUndefined();
  });

  it("does not bypass off mode for Slack when reply is implicit", () => {
    const result = applyReplyThreading({
      payloads: [{ text: "A" }],
      replyToMode: "off",
      replyToChannel: "slack",
      currentMessageId: "42",
    });

    expect(result).toHaveLength(1);
    expect(expectDefined(result[0], "result[0] test invariant").replyToId).toBeUndefined();
  });

  it("keeps explicit tags for Telegram when off mode is enabled", () => {
    const result = applyReplyThreading({
      payloads: [{ text: "[[reply_to_current]]A" }],
      replyToMode: "off",
      replyToChannel: "telegram",
      currentMessageId: "42",
    });

    expect(result).toHaveLength(1);
    expect(expectDefined(result[0], "result[0] test invariant").replyToId).toBe("42");
    expect(expectDefined(result[0], "result[0] test invariant").replyToTag).toBe(true);
  });

  it("resolves [[reply_to:<id>]] to explicit id when replyToMode is 'all'", () => {
    const result = applyReplyThreading({
      payloads: [{ text: "[[reply_to:mm-post-xyz789]] threaded reply" }],
      replyToMode: "all",
      currentMessageId: "mm-post-abc123",
    });

    expect(result).toHaveLength(1);
    expect(expectDefined(result[0], "result[0] test invariant").replyToId).toBe("mm-post-xyz789");
    expect(expectDefined(result[0], "result[0] test invariant").text).toBe("threaded reply");
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
    const long = "x".repeat(100);
    const run = { ...baseRun, label: long };
    const formatted = formatRunLabel(run, { maxLength: 10 });
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
