import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  isCommandSourceTurn,
  resolveSourceReplyDeliveryMode,
  resolveSourceReplyVisibilityPolicy,
} from "./source-reply-delivery-mode.js";

const emptyConfig = {} as OpenClawConfig;
const automaticGroupReplyConfig = {
  messages: {
    groupChat: {
      visibleReplies: "automatic",
    },
  },
} as const satisfies OpenClawConfig;
const globalToolOnlyReplyConfig = {
  messages: {
    visibleReplies: "message_tool",
  },
} as const satisfies OpenClawConfig;

describe("resolveSourceReplyDeliveryMode", () => {
  it("defaults groups and channels to message-tool-only delivery", () => {
    expect(resolveSourceReplyDeliveryMode({ cfg: emptyConfig, ctx: { ChatType: "channel" } })).toBe(
      "message_tool_only",
    );
    expect(resolveSourceReplyDeliveryMode({ cfg: emptyConfig, ctx: { ChatType: "group" } })).toBe(
      "message_tool_only",
    );
    expect(resolveSourceReplyDeliveryMode({ cfg: emptyConfig, ctx: { ChatType: "direct" } })).toBe(
      "automatic",
    );
  });

  it("honors config and explicit requested mode", () => {
    expect(
      resolveSourceReplyDeliveryMode({
        cfg: automaticGroupReplyConfig,
        ctx: { ChatType: "group" },
      }),
    ).toBe("automatic");
    expect(
      resolveSourceReplyDeliveryMode({
        cfg: emptyConfig,
        ctx: { ChatType: "channel" },
        requested: "automatic",
      }),
    ).toBe("automatic");
  });

  it("allows message-tool-only delivery for any source chat via global config", () => {
    for (const ChatType of ["direct", "group", "channel"] as const) {
      expect(
        resolveSourceReplyDeliveryMode({ cfg: globalToolOnlyReplyConfig, ctx: { ChatType } }),
      ).toBe("message_tool_only");
    }
  });

  it("allows harnesses to default direct chats to message-tool-only delivery", () => {
    expect(
      resolveSourceReplyDeliveryMode({
        cfg: emptyConfig,
        ctx: { ChatType: "direct" },
        defaultVisibleReplies: "message_tool",
      }),
    ).toBe("message_tool_only");
    expect(
      resolveSourceReplyDeliveryMode({
        cfg: { messages: { visibleReplies: "automatic" } },
        ctx: { ChatType: "direct" },
        defaultVisibleReplies: "message_tool",
      }),
    ).toBe("automatic");
  });

  it("lets group/channel config override the global visible reply mode", () => {
    expect(
      resolveSourceReplyDeliveryMode({
        cfg: {
          messages: {
            visibleReplies: "message_tool",
            groupChat: { visibleReplies: "automatic" },
          },
        },
        ctx: { ChatType: "channel" },
      }),
    ).toBe("automatic");
  });

  it("treats native commands as explicit replies in groups", () => {
    expect(
      resolveSourceReplyDeliveryMode({
        cfg: emptyConfig,
        ctx: { ChatType: "group", CommandSource: "native" },
      }),
    ).toBe("automatic");
  });

  it("treats text-prefix slash commands as explicit replies in groups (regression #77260)", () => {
    // Matrix and Tlon surface every inbound message with `CommandSource: "text"`.
    // Their canned slash-command replies (e.g. "✅ New session started." for `/new`)
    // were silently dropped when `messages.groupChat.visibleReplies = "message_tool"`
    // because only `CommandSource === "native"` was exempted. The fix narrows the
    // exemption to `text` AND a body that starts with `/`, so the slash command
    // reply is visible while normal Matrix/Tlon user messages keep honoring the
    // configured visibility mode. Pinned to prevent the v2026.4.25 regression from
    // returning.
    expect(
      resolveSourceReplyDeliveryMode({
        cfg: emptyConfig,
        ctx: { ChatType: "group", CommandSource: "text", CommandBody: "/new" },
      }),
    ).toBe("automatic");
    expect(
      resolveSourceReplyDeliveryMode({
        cfg: globalToolOnlyReplyConfig,
        ctx: { ChatType: "channel", CommandSource: "text", CommandBody: "/status" },
      }),
    ).toBe("automatic");
    expect(
      resolveSourceReplyDeliveryMode({
        cfg: { messages: { groupChat: { visibleReplies: "message_tool" } } },
        ctx: { ChatType: "group", CommandSource: "text", CommandBody: "/new" },
      }),
    ).toBe("automatic");
  });

  it("keeps non-command Matrix/Tlon group turns suppressed when visibleReplies is message_tool", () => {
    // Matrix/Tlon set `CommandSource: "text"` for every inbound, including normal
    // user prose. Those messages must keep honoring the configured visibility
    // mode — otherwise the bypass would silently widen to all messages on those
    // surfaces, defeating the point of `messages.groupChat.visibleReplies`.
    expect(
      resolveSourceReplyDeliveryMode({
        cfg: { messages: { groupChat: { visibleReplies: "message_tool" } } },
        ctx: { ChatType: "group", CommandSource: "text", CommandBody: "hi everyone" },
      }),
    ).toBe("message_tool_only");
    expect(
      resolveSourceReplyDeliveryMode({
        cfg: globalToolOnlyReplyConfig,
        ctx: { ChatType: "channel", CommandSource: "text", Body: "regular question" },
      }),
    ).toBe("message_tool_only");
    expect(
      resolveSourceReplyDeliveryMode({
        cfg: emptyConfig,
        ctx: { ChatType: "group", CommandSource: "text" },
      }),
    ).toBe("message_tool_only");
  });

  it("falls back to Body when CommandBody is missing for the slash detection", () => {
    // Some upstream surfaces only finalize CommandBody downstream. The exemption
    // should still trigger as long as the raw inbound body starts with `/`.
    expect(
      resolveSourceReplyDeliveryMode({
        cfg: emptyConfig,
        ctx: { ChatType: "group", CommandSource: "text", Body: "/help" },
      }),
    ).toBe("automatic");
  });

  it("falls back to automatic when message tool is unavailable", () => {
    expect(
      resolveSourceReplyDeliveryMode({
        cfg: emptyConfig,
        ctx: { ChatType: "group" },
        messageToolAvailable: false,
      }),
    ).toBe("automatic");
    expect(
      resolveSourceReplyDeliveryMode({
        cfg: globalToolOnlyReplyConfig,
        ctx: { ChatType: "direct" },
        messageToolAvailable: false,
      }),
    ).toBe("automatic");
    expect(
      resolveSourceReplyDeliveryMode({
        cfg: emptyConfig,
        ctx: { ChatType: "channel" },
        requested: "message_tool_only",
        messageToolAvailable: false,
      }),
    ).toBe("automatic");
  });

  it("keeps message-tool-only delivery when message tool availability is unknown", () => {
    expect(
      resolveSourceReplyDeliveryMode({
        cfg: emptyConfig,
        ctx: { ChatType: "group" },
        messageToolAvailable: true,
      }),
    ).toBe("message_tool_only");
    expect(
      resolveSourceReplyDeliveryMode({
        cfg: emptyConfig,
        ctx: { ChatType: "channel" },
      }),
    ).toBe("message_tool_only");
  });
});

describe("resolveSourceReplyVisibilityPolicy", () => {
  it("allows direct automatic delivery without suppressing typing", () => {
    expect(
      resolveSourceReplyVisibilityPolicy({
        cfg: emptyConfig,
        ctx: { ChatType: "direct" },
        sendPolicy: "allow",
      }),
    ).toMatchObject({
      sourceReplyDeliveryMode: "automatic",
      sendPolicyDenied: false,
      suppressAutomaticSourceDelivery: false,
      suppressDelivery: false,
      suppressHookUserDelivery: false,
      suppressHookReplyLifecycle: false,
      suppressTyping: false,
      deliverySuppressionReason: "",
    });
  });

  it("suppresses automatic source delivery for default group turns without suppressing typing", () => {
    expect(
      resolveSourceReplyVisibilityPolicy({
        cfg: emptyConfig,
        ctx: { ChatType: "group" },
        sendPolicy: "allow",
      }),
    ).toMatchObject({
      sourceReplyDeliveryMode: "message_tool_only",
      sendPolicyDenied: false,
      suppressAutomaticSourceDelivery: true,
      suppressDelivery: true,
      suppressHookUserDelivery: true,
      suppressHookReplyLifecycle: false,
      suppressTyping: false,
      deliverySuppressionReason: "sourceReplyDeliveryMode: message_tool_only",
    });
  });

  it("keeps native command replies visible in groups", () => {
    expect(
      resolveSourceReplyVisibilityPolicy({
        cfg: emptyConfig,
        ctx: { ChatType: "group", CommandSource: "native" },
        sendPolicy: "allow",
      }),
    ).toMatchObject({
      sourceReplyDeliveryMode: "automatic",
      suppressAutomaticSourceDelivery: false,
      suppressDelivery: false,
      suppressHookReplyLifecycle: false,
      suppressTyping: false,
    });
  });

  it("keeps text-prefix slash command replies visible in groups (regression #77260)", () => {
    // Matrix `/new` etc. surface as CommandSource: "text" with a body starting
    // with `/`. Before the fix the policy returned message_tool_only,
    // suppressAutomaticSourceDelivery, and suppressDelivery — the canned command
    // reply was suppressed and users got no feedback even though the action ran.
    // The fix now mirrors the native-command behavior for text-prefix slash
    // commands while leaving normal Matrix/Tlon prose under the configured
    // visibility policy.
    expect(
      resolveSourceReplyVisibilityPolicy({
        cfg: { messages: { groupChat: { visibleReplies: "message_tool" } } },
        ctx: { ChatType: "group", CommandSource: "text", CommandBody: "/new" },
        sendPolicy: "allow",
      }),
    ).toMatchObject({
      sourceReplyDeliveryMode: "automatic",
      suppressAutomaticSourceDelivery: false,
      suppressDelivery: false,
      suppressHookUserDelivery: false,
      deliverySuppressionReason: "",
    });
    expect(
      resolveSourceReplyVisibilityPolicy({
        cfg: globalToolOnlyReplyConfig,
        ctx: { ChatType: "channel", CommandSource: "text", CommandBody: "/status" },
        sendPolicy: "allow",
      }),
    ).toMatchObject({
      sourceReplyDeliveryMode: "automatic",
      suppressAutomaticSourceDelivery: false,
      suppressDelivery: false,
      suppressHookReplyLifecycle: false,
      suppressTyping: false,
    });
  });

  it("keeps non-command Matrix/Tlon group prose under the configured visibility policy", () => {
    // Defensive coverage at the visibility-policy layer: a Matrix prose message
    // (`CommandSource: "text"` with a non-slash body) under
    // `visibleReplies = "message_tool"` must continue to suppress automatic
    // delivery. Without this pin a future tightening of the helper could
    // collapse the distinction between command replies and prose replies.
    expect(
      resolveSourceReplyVisibilityPolicy({
        cfg: { messages: { groupChat: { visibleReplies: "message_tool" } } },
        ctx: { ChatType: "group", CommandSource: "text", CommandBody: "hello there" },
        sendPolicy: "allow",
      }),
    ).toMatchObject({
      sourceReplyDeliveryMode: "message_tool_only",
      suppressAutomaticSourceDelivery: true,
      suppressDelivery: true,
      deliverySuppressionReason: "sourceReplyDeliveryMode: message_tool_only",
    });
  });

  it("keeps configured automatic group delivery visible", () => {
    expect(
      resolveSourceReplyVisibilityPolicy({
        cfg: automaticGroupReplyConfig,
        ctx: { ChatType: "channel" },
        sendPolicy: "allow",
      }),
    ).toMatchObject({
      sourceReplyDeliveryMode: "automatic",
      suppressAutomaticSourceDelivery: false,
      suppressDelivery: false,
      suppressHookReplyLifecycle: false,
      suppressTyping: false,
    });
  });

  it("supports explicit message-tool-only delivery for direct chats without suppressing typing", () => {
    expect(
      resolveSourceReplyVisibilityPolicy({
        cfg: emptyConfig,
        ctx: { ChatType: "direct" },
        requested: "message_tool_only",
        sendPolicy: "allow",
      }),
    ).toMatchObject({
      sourceReplyDeliveryMode: "message_tool_only",
      suppressAutomaticSourceDelivery: true,
      suppressDelivery: true,
      suppressHookReplyLifecycle: false,
      suppressTyping: false,
      deliverySuppressionReason: "sourceReplyDeliveryMode: message_tool_only",
    });
  });

  it("lets sendPolicy deny suppress delivery and typing", () => {
    expect(
      resolveSourceReplyVisibilityPolicy({
        cfg: emptyConfig,
        ctx: { ChatType: "group" },
        sendPolicy: "deny",
      }),
    ).toMatchObject({
      sourceReplyDeliveryMode: "message_tool_only",
      sendPolicyDenied: true,
      suppressDelivery: true,
      suppressHookUserDelivery: true,
      suppressHookReplyLifecycle: true,
      suppressTyping: true,
      deliverySuppressionReason: "sendPolicy: deny",
    });
  });

  it("keeps explicit typing suppression separate from delivery suppression", () => {
    expect(
      resolveSourceReplyVisibilityPolicy({
        cfg: emptyConfig,
        ctx: { ChatType: "direct" },
        sendPolicy: "allow",
        explicitSuppressTyping: true,
      }),
    ).toMatchObject({
      sourceReplyDeliveryMode: "automatic",
      suppressDelivery: false,
      suppressHookUserDelivery: false,
      suppressHookReplyLifecycle: true,
      suppressTyping: true,
    });
  });

  it("keeps ACP child user delivery suppression separate from source delivery", () => {
    expect(
      resolveSourceReplyVisibilityPolicy({
        cfg: emptyConfig,
        ctx: { ChatType: "direct" },
        sendPolicy: "allow",
        suppressAcpChildUserDelivery: true,
      }),
    ).toMatchObject({
      sourceReplyDeliveryMode: "automatic",
      suppressDelivery: false,
      suppressHookUserDelivery: true,
      suppressHookReplyLifecycle: true,
      suppressTyping: false,
    });
  });
  it("keeps delivery automatic when message-tool-only mode cannot send visibly", () => {
    expect(
      resolveSourceReplyVisibilityPolicy({
        cfg: emptyConfig,
        ctx: { ChatType: "group" },
        sendPolicy: "allow",
        messageToolAvailable: false,
      }),
    ).toMatchObject({
      sourceReplyDeliveryMode: "automatic",
      suppressAutomaticSourceDelivery: false,
      suppressDelivery: false,
      suppressHookUserDelivery: false,
      deliverySuppressionReason: "",
    });
    expect(
      resolveSourceReplyVisibilityPolicy({
        cfg: emptyConfig,
        ctx: { ChatType: "channel" },
        requested: "message_tool_only",
        sendPolicy: "allow",
        messageToolAvailable: false,
      }),
    ).toMatchObject({
      sourceReplyDeliveryMode: "automatic",
      suppressAutomaticSourceDelivery: false,
      suppressDelivery: false,
      deliverySuppressionReason: "",
    });
  });
});

describe("isCommandSourceTurn", () => {
  it("returns true for native command sources regardless of body", () => {
    // Slack/Mattermost slash-menu invocations come in as CommandSource: "native".
    // The protocol surface guarantees this is a command, so the body content is
    // irrelevant to the bypass.
    expect(isCommandSourceTurn({ CommandSource: "native" })).toBe(true);
    expect(isCommandSourceTurn({ CommandSource: "native", CommandBody: "" })).toBe(true);
    expect(isCommandSourceTurn({ CommandSource: "native", CommandBody: "no slash" })).toBe(true);
  });

  it("returns true for text command sources only when the body starts with /", () => {
    // Matrix and Tlon set CommandSource: "text" for every inbound. Only requests
    // that actually start with `/` should bypass the visibility policy.
    expect(isCommandSourceTurn({ CommandSource: "text", CommandBody: "/new" })).toBe(true);
    expect(isCommandSourceTurn({ CommandSource: "text", CommandBody: "  /status" })).toBe(true);
    expect(isCommandSourceTurn({ CommandSource: "text", Body: "/help" })).toBe(true);
  });

  it("returns false for text command sources with non-slash bodies", () => {
    expect(isCommandSourceTurn({ CommandSource: "text", CommandBody: "hello" })).toBe(false);
    expect(isCommandSourceTurn({ CommandSource: "text", CommandBody: "" })).toBe(false);
    expect(isCommandSourceTurn({ CommandSource: "text" })).toBe(false);
    expect(isCommandSourceTurn({ CommandSource: "text", Body: "what's up" })).toBe(false);
  });

  it("returns false when there is no command source", () => {
    expect(isCommandSourceTurn({})).toBe(false);
    expect(isCommandSourceTurn({ ChatType: "group" })).toBe(false);
    expect(isCommandSourceTurn({ CommandSource: undefined, CommandBody: "/new" })).toBe(false);
  });
});
