// Tests source reply delivery visibility across message tool and visible reply modes.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { CommandTurnContext } from "../command-turn-context.js";
import {
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

function expectPolicyFields(
  policy: ReturnType<typeof resolveSourceReplyVisibilityPolicy>,
  fields: Partial<ReturnType<typeof resolveSourceReplyVisibilityPolicy>>,
): void {
  for (const [key, value] of Object.entries(fields)) {
    expect(policy[key as keyof typeof policy]).toBe(value);
  }
}

describe("resolveSourceReplyDeliveryMode", () => {
  it("keeps progress refresh replies, hooks and typing silent without changing session reply mode", () => {
    const policy = resolveSourceReplyVisibilityPolicy({
      cfg: emptyConfig,
      ctx: {
        Provider: "webchat",
        Surface: "webchat",
        InputProvenance: { kind: "internal_system", sourceTool: "progress_card_refresh" },
      },
      sendPolicy: "allow",
    });
    expect(policy).toMatchObject({
      sourceReplyDeliveryMode: "automatic",
      sessionStableSourceReplyDeliveryMode: "automatic",
      suppressDelivery: true,
      suppressHookUserDelivery: true,
      suppressHookReplyLifecycle: true,
      suppressTyping: true,
    });
  });

  it("keeps routed external room events message-tool-only when provider is WebChat", () => {
    expect(
      resolveSourceReplyDeliveryMode({
        cfg: automaticGroupReplyConfig,
        ctx: {
          ChatType: "group",
          InboundEventKind: "room_event",
          Provider: "webchat",
          Surface: "telegram",
        },
      }),
    ).toBe("message_tool_only");
    expect(
      resolveSourceReplyDeliveryMode({
        cfg: emptyConfig,
        ctx: {
          ChatType: "direct",
          InboundEventKind: "room_event",
          Provider: "webchat",
          Surface: "webchat",
          ExplicitDeliverRoute: true,
        },
        requested: "automatic",
      }),
    ).toBe("message_tool_only");
  });

  it("treats authorized control-command bodies as explicit replies even when CommandSource is missing", () => {
    expect(
      resolveSourceReplyDeliveryMode({
        cfg: globalToolOnlyReplyConfig,
        ctx: {
          ChatType: "direct",
          CommandAuthorized: true,
          CommandBody: "/reset",
        },
      }),
    ).toBe("automatic");
    expect(
      resolveSourceReplyDeliveryMode({
        cfg: globalToolOnlyReplyConfig,
        ctx: {
          ChatType: "direct",
          CommandAuthorized: true,
          CommandBody: "hey can you /status please",
        },
      }),
    ).toBe("message_tool_only");
  });

  it("keeps unauthorized text slash command turns tool-only under the default group mode", () => {
    expect(
      resolveSourceReplyDeliveryMode({
        cfg: emptyConfig,
        ctx: {
          ChatType: "group",
          CommandSource: "text",
          CommandAuthorized: false,
          CommandBody: "/status",
        },
      }),
    ).toBe("message_tool_only");
  });

  it("uses structured native and text command context for visible replies", () => {
    const commandTurns: CommandTurnContext[] = [
      { kind: "text-slash", source: "text", authorized: true, body: "/status" },
      { kind: "native", source: "native", authorized: true, body: "/status" },
    ];
    for (const CommandTurn of commandTurns) {
      expect(
        resolveSourceReplyDeliveryMode({
          cfg: emptyConfig,
          ctx: {
            ChatType: "group",
            CommandTurn,
          },
        }),
      ).toBe("automatic");
    }
  });

  it("keeps unauthorized text slash command turns tool-only when groups opt into message-tool replies", () => {
    expect(
      resolveSourceReplyDeliveryMode({
        cfg: globalToolOnlyReplyConfig,
        ctx: {
          ChatType: "group",
          CommandTurn: {
            kind: "text-slash",
            source: "text",
            authorized: false,
            body: "/status",
          },
        },
      }),
    ).toBe("message_tool_only");
  });
});

describe("resolveSourceReplyVisibilityPolicy", () => {
  it.each([[automaticGroupReplyConfig, "automatic"]] as const)(
    "keeps room-event effective delivery tool-only while session-stable mode follows config",
    (cfg, expectedStableMode) => {
      expectPolicyFields(
        resolveSourceReplyVisibilityPolicy({
          cfg,
          ctx: { ChatType: "group", InboundEventKind: "room_event" },
          sendPolicy: "allow",
        }),
        {
          sourceReplyDeliveryMode: "message_tool_only",
          sessionStableSourceReplyDeliveryMode: expectedStableMode,
          suppressAutomaticSourceDelivery: true,
          suppressDelivery: true,
        },
      );
    },
  );

  it("keeps the stable mode tool-only under a sender-scoped message denial", () => {
    // A sender-scoped denial downgrades the sender's effective delivery, but
    // the session-stable mode feeds CLI binding facts shared by sender-less
    // synthetic turns; downgrading it too splits the policy hash and resets
    // the CLI session on chat<->heartbeat transitions.
    expectPolicyFields(
      resolveSourceReplyVisibilityPolicy({
        cfg: globalToolOnlyReplyConfig,
        ctx: { ChatType: "direct" },
        sendPolicy: "allow",
        messageToolAvailable: false,
        sessionStableMessageToolAvailable: true,
      }),
      {
        sourceReplyDeliveryMode: "automatic",
        sessionStableSourceReplyDeliveryMode: "message_tool_only",
      },
    );
    // Without a sender-independent verdict, the stable mode still follows the
    // turn's availability (session-wide denials downgrade both).
    expectPolicyFields(
      resolveSourceReplyVisibilityPolicy({
        cfg: globalToolOnlyReplyConfig,
        ctx: { ChatType: "direct" },
        sendPolicy: "allow",
        messageToolAvailable: false,
      }),
      {
        sourceReplyDeliveryMode: "automatic",
        sessionStableSourceReplyDeliveryMode: "automatic",
      },
    );
  });

  it.each([
    {
      name: "internal lifecycle handoff",
      ctx: {
        ChatType: "direct",
        InputProvenance: { kind: "internal_system" as const, sourceTool: "restart-sentinel" },
      },
    },
  ])("keeps $name overrides out of session-stable policy", ({ ctx }) => {
    expectPolicyFields(
      resolveSourceReplyVisibilityPolicy({
        cfg: emptyConfig,
        ctx,
        requested: "message_tool_only",
        sendPolicy: "allow",
      }),
      {
        sourceReplyDeliveryMode: "message_tool_only",
        sessionStableSourceReplyDeliveryMode: "automatic",
        suppressAutomaticSourceDelivery: true,
        suppressDelivery: true,
      },
    );
  });

  it("lets sendPolicy deny suppress delivery and typing", () => {
    expectPolicyFields(
      resolveSourceReplyVisibilityPolicy({
        cfg: emptyConfig,
        ctx: { ChatType: "group" },
        sendPolicy: "deny",
      }),
      {
        sourceReplyDeliveryMode: "automatic",
        sendPolicyDenied: true,
        suppressDelivery: true,
        suppressHookUserDelivery: true,
        suppressHookReplyLifecycle: true,
        suppressTyping: true,
        deliverySuppressionReason: "sendPolicy: deny",
      },
    );
  });

  it("keeps ACP child user delivery suppression separate from source delivery", () => {
    expectPolicyFields(
      resolveSourceReplyVisibilityPolicy({
        cfg: emptyConfig,
        ctx: { ChatType: "direct" },
        sendPolicy: "allow",
        suppressAcpChildUserDelivery: true,
      }),
      {
        sourceReplyDeliveryMode: "automatic",
        suppressDelivery: false,
        suppressHookUserDelivery: true,
        suppressHookReplyLifecycle: true,
        suppressTyping: false,
      },
    );
  });
  it("falls back to automatic when message-tool-only delivery cannot use the message tool", () => {
    expectPolicyFields(
      resolveSourceReplyVisibilityPolicy({
        cfg: globalToolOnlyReplyConfig,
        ctx: { ChatType: "group" },
        sendPolicy: "allow",
        messageToolAvailable: false,
      }),
      {
        sourceReplyDeliveryMode: "automatic",
        suppressAutomaticSourceDelivery: false,
        suppressDelivery: false,
        suppressHookUserDelivery: false,
        deliverySuppressionReason: "",
      },
    );
    expectPolicyFields(
      resolveSourceReplyVisibilityPolicy({
        cfg: emptyConfig,
        ctx: { ChatType: "channel" },
        requested: "message_tool_only",
        sendPolicy: "allow",
        messageToolAvailable: false,
      }),
      {
        sourceReplyDeliveryMode: "automatic",
        suppressAutomaticSourceDelivery: false,
        suppressDelivery: false,
        deliverySuppressionReason: "",
      },
    );
  });

  it("keeps strict message-tool-only delivery suppressed when the message tool is unavailable", () => {
    expectPolicyFields(
      resolveSourceReplyVisibilityPolicy({
        cfg: emptyConfig,
        ctx: { ChatType: "channel" },
        requested: "message_tool_only",
        strictMessageToolOnly: true,
        sendPolicy: "allow",
        messageToolAvailable: false,
      }),
      {
        sourceReplyDeliveryMode: "message_tool_only",
        suppressAutomaticSourceDelivery: true,
        suppressDelivery: true,
        deliverySuppressionReason: "sourceReplyDeliveryMode: message_tool_only",
      },
    );
    expectPolicyFields(
      resolveSourceReplyVisibilityPolicy({
        cfg: automaticGroupReplyConfig,
        ctx: { ChatType: "channel" },
        requested: "automatic",
        strictMessageToolOnly: true,
        sendPolicy: "allow",
      }),
      {
        sourceReplyDeliveryMode: "message_tool_only",
        suppressAutomaticSourceDelivery: true,
        suppressDelivery: true,
        deliverySuppressionReason: "sourceReplyDeliveryMode: message_tool_only",
      },
    );
  });
});
