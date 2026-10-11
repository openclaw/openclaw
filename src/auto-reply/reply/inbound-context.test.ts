// Tests inbound context text built from sender and conversation metadata.
import { describe, expect, it } from "vitest";
import { resolveCommandTurnTargetSessionKey } from "../command-turn-context.js";
import type { MsgContext } from "../templating.js";
import { appendChannelPromptContext } from "./channel-prompt-context.js";
import { markInboundContextLabel } from "./inbound-context-marker.js";
import { finalizeInboundContext, finalizeInboundContextForSdk } from "./inbound-context.js";
import { buildInboundUserContextPrefix } from "./inbound-meta.js";

describe("inbound context contract (providers + extensions)", () => {
  it.each([["exec-event", "exec"]] as const)(
    "folds the legacy %s source without changing the reply route",
    (provider, source) => {
      const input: MsgContext = {
        Body: "An internal turn",
        Provider: provider,
        Surface: provider,
        OriginatingChannel: "telegram",
        OriginatingTo: "chat:123",
        MessageThreadId: "456",
        InputProvenance: { kind: "internal_system", sourceTool: "existing-source" },
      };
      const ctx = finalizeInboundContextForSdk(input);
      expect(ctx).toMatchObject({
        InternalTurnSource: source,
        OriginatingChannel: "telegram",
        OriginatingTo: "chat:123",
        MessageThreadId: "456",
        InputProvenance: { kind: "internal_system", sourceTool: "existing-source" },
      });
      expect(ctx.Provider).toBeUndefined();
      expect(ctx.Surface).toBeUndefined();
    },
  );

  it("preserves a typed wake without inventing a transport", () => {
    const ctx = finalizeInboundContext({ Body: "Background work", InternalTurnSource: "exec" });
    expect(ctx.InternalTurnSource).toBe("exec");
    expect(ctx.Provider).toBeUndefined();
    expect(ctx.OriginatingChannel).toBeUndefined();
  });

  it("removes a legacy wake label from the reply channel", () => {
    const ctx = finalizeInboundContextForSdk({
      Body: "Background work",
      Provider: "cron-event",
      OriginatingChannel: "cron-event",
    });
    expect(ctx.InternalTurnSource).toBe("cron");
    expect(ctx.OriginatingChannel).toBeUndefined();
  });

  it("finalizes the group text and conversation contract", () => {
    const ctx = finalizeInboundContext({
      ChatType: "group",
      From: "test:123",
      Body: "[Test] hello",
      RawBody: "hello",
      SenderName: "Alice",
      GroupSubject: "Room",
    });

    expect(ctx).toMatchObject({
      Body: "[Test] hello",
      BodyForAgent: "hello",
      BodyForCommands: "hello",
      ConversationLabel: "Room id:123",
      CommandAuthorized: false,
    });
  });
});

describe("finalizeInboundContext text facts", () => {
  it("keeps suppressed text command input literal across repeated finalization", () => {
    const body = "/new keep this as task text";
    const ctx = finalizeInboundContext({
      Body: body,
      RawBody: body,
      CommandBody: body,
      BodyForCommands: body,
      commandText: body,
      CommandInterpretationSuppressed: true,
      CommandAuthorized: true,
      CommandSource: "text",
      CommandTargetSessionKey: "agent:other:main",
      CommandTurn: {
        kind: "text-slash",
        source: "text",
        authorized: true,
        commandName: "new",
        body,
      },
    });

    const expected = {
      agentText: body,
      rawText: body,
      BodyForAgent: body,
      commandText: "",
      BodyForCommands: "",
      CommandAuthorized: false,
      CommandSource: undefined,
      CommandTurn: { kind: "normal", source: "message", authorized: false, body: "" },
    };
    expect(ctx).toMatchObject(expected);
    expect(resolveCommandTurnTargetSessionKey(ctx)).toBeUndefined();
    expect(finalizeInboundContext(ctx, { forceBodyForCommands: true })).toMatchObject(expected);
  });

  it("preserves an explicitly empty raw projection", () => {
    const ctx = finalizeInboundContext({
      Body: "fallback body",
      BodyForCommands: "/new payload",
      RawBody: "",
    });

    expect(ctx).toMatchObject({
      commandText: "/new payload",
      agentText: "",
      rawText: "",
    });
  });
});

describe("finalizeInboundContext media cleanup", () => {
  it("restores legacy media projections only for the shipped SDK adapter", () => {
    const ctx = finalizeInboundContextForSdk({
      Body: "hello",
      MediaPath: "/tmp/photo.jpg",
      MediaUrl: "file:///tmp/photo.jpg",
      MediaType: "image/jpeg",
      MediaDir: "/tmp/media",
      MediaWorkspaceDir: "/tmp/workspace",
      MediaStaged: true,
    });

    expect(ctx).toMatchObject({
      MediaPath: "/tmp/photo.jpg",
      MediaUrl: "file:///tmp/photo.jpg",
      MediaType: "image/jpeg",
      MediaPaths: ["/tmp/photo.jpg"],
      MediaUrls: ["file:///tmp/photo.jpg"],
      MediaTypes: ["image/jpeg"],
      MediaDir: "/tmp/media",
      MediaWorkspaceDir: "/tmp/workspace",
      MediaStaged: true,
    });
  });

  it("keeps a singular legacy MediaUrl off the second inbound attachment slot", () => {
    const ctx = finalizeInboundContext({
      Body: "two attachments",
      MediaPaths: ["/tmp/a.png", "/tmp/b.png"],
      MediaUrls: ["file:///tmp/a.png"],
      MediaUrl: "file:///tmp/a.png",
    });

    expect(ctx.media).toHaveLength(2);
    expect(ctx.media?.[0]).toMatchObject({
      path: "/tmp/a.png",
      url: "file:///tmp/a.png",
    });
    expect(ctx.media?.[1]).toMatchObject({ path: "/tmp/b.png" });
    expect(ctx.media?.[1]?.url).toBeUndefined();
  });
});

describe("finalizeInboundContext supplemental projection", () => {
  it("projects supplemental facts into legacy context fields", () => {
    const ctx = finalizeInboundContext({
      Body: "hello",
      SupplementalContext: {
        quote: {
          id: "reply-1",
          fullId: "room/reply-1",
          body: "quoted",
          sender: "Alice",
          isQuote: true,
        },
        forwarded: {
          from: "Bob",
          fromType: "user",
          fromId: "bob",
          date: 1_700_000_000,
        },
        thread: {
          starterBody: "starter",
          historyBody: "history",
          label: "thread label",
        },
        groupSystemPrompt: "group prompt",
        channelStructuredContext: [{ label: "raw", payload: { ok: true } }],
      },
    });

    expect(ctx).toMatchObject({
      ReplyToId: "reply-1",
      ReplyToIdFull: "room/reply-1",
      ReplyToBody: "quoted",
      ReplyToSender: "Alice",
      ReplyToIsQuote: true,
      ForwardedFrom: "Bob",
      ForwardedFromType: "user",
      ForwardedFromId: "bob",
      ForwardedDate: 1_700_000_000,
      ThreadStarterBody: "starter",
      ThreadHistoryBody: "history",
      ThreadLabel: "thread label",
      GroupSystemPrompt: "group prompt",
      ChannelStructuredContext: [{ label: "raw", payload: { ok: true } }],
    });
    expect(Object.hasOwn(ctx, "SupplementalContext")).toBe(false);
  });

  it("folds the deprecated supplemental structured-context key", () => {
    const supplemental: NonNullable<MsgContext["SupplementalContext"]> = {
      untrustedContext: [{ label: "raw", payload: { ok: true } }],
    };
    const ctx = finalizeInboundContext({ Body: "hello", SupplementalContext: supplemental });

    expect(ctx.ChannelStructuredContext).toEqual([{ label: "raw", payload: { ok: true } }]);
    expect(supplemental.channelStructuredContext).toEqual([
      { label: "raw", payload: { ok: true } },
    ]);
    expect(Object.hasOwn(supplemental, "untrustedContext")).toBe(false);
  });
});

describe("finalizeInboundContext deprecated prompt-context aliases", () => {
  it("folds deprecated UntrustedStructuredContext before prompt rendering", () => {
    const entry = {
      label: "Channel metadata",
      source: "test",
      type: "channel_metadata",
      payload: { value: "same bytes" },
    };
    const deprecated = finalizeInboundContext({
      Body: "hello",
      UntrustedStructuredContext: [entry],
    });
    const canonical = finalizeInboundContext({
      Body: "hello",
      ChannelStructuredContext: [entry],
    });

    expect(buildInboundUserContextPrefix(deprecated)).toBe(
      buildInboundUserContextPrefix(canonical),
    );
    expect(deprecated.ChannelStructuredContext).toEqual([entry]);
    expect(Object.hasOwn(deprecated, "UntrustedStructuredContext")).toBe(false);
  });

  it("folds deprecated UntrustedContext before prompt rendering", () => {
    const deprecated = finalizeInboundContext({
      Body: "hello",
      UntrustedContext: ["Channel metadata (src)\r\nvalue"],
    });
    const canonical = finalizeInboundContext({
      Body: "hello",
      ChannelPromptContext: ["Channel metadata (src)\r\nvalue"],
    });

    const rendered = appendChannelPromptContext("hello", deprecated.ChannelPromptContext);
    expect(rendered).toBe(appendChannelPromptContext("hello", canonical.ChannelPromptContext));
    expect(rendered).toContain(markInboundContextLabel("Context:"));
    expect(deprecated.ChannelPromptContext).toEqual(["Channel metadata (src)\nvalue"]);
    expect(Object.hasOwn(deprecated, "UntrustedContext")).toBe(false);
  });
});
