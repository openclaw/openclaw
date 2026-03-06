import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveIMessageInboundDecision } from "./inbound-processing.js";
import { parseIMessageNotification } from "./parse-notification.js";

describe("parseIMessageNotification", () => {
  it("returns null for non-object input", () => {
    expect(parseIMessageNotification(null)).toBeNull();
    expect(parseIMessageNotification("string")).toBeNull();
    expect(parseIMessageNotification(42)).toBeNull();
  });

  it("returns null when .message is missing", () => {
    expect(parseIMessageNotification({})).toBeNull();
    expect(parseIMessageNotification({ other: 1 })).toBeNull();
  });

  it("parses standard snake_case payload", () => {
    const payload = {
      message: {
        id: 1,
        sender: "+15551234567",
        text: "hello",
        is_from_me: false,
        is_group: false,
        chat_id: 10,
      },
    };
    const result = parseIMessageNotification(payload);
    expect(result).not.toBeNull();
    expect(result!.is_from_me).toBe(false);
    expect(result!.is_group).toBe(false);
    expect(result!.chat_id).toBe(10);
  });

  it("normalizes camelCase isFromMe to is_from_me", () => {
    const payload = {
      message: {
        id: 2,
        sender: "+15551234567",
        text: "outbound echo",
        isFromMe: true,
        is_group: false,
      },
    };
    const result = parseIMessageNotification(payload);
    expect(result).not.toBeNull();
    expect(result!.is_from_me).toBe(true);
  });

  it("normalizes camelCase isGroup to is_group", () => {
    const payload = {
      message: {
        id: 3,
        sender: "+15551234567",
        text: "group msg",
        is_from_me: false,
        isGroup: true,
        chatId: 42,
      },
    };
    const result = parseIMessageNotification(payload);
    expect(result).not.toBeNull();
    expect(result!.is_group).toBe(true);
    expect(result!.chat_id).toBe(42);
  });

  it("normalizes all known camelCase keys", () => {
    const payload = {
      message: {
        id: 4,
        sender: "+15551234567",
        text: "full camel",
        isFromMe: false,
        isGroup: true,
        chatId: 99,
        chatGuid: "iMessage;-;+1555",
        chatName: "Test Group",
        chatIdentifier: "+1555",
        replyToId: "prev-1",
        replyToText: "earlier message",
        replyToSender: "+15559999999",
        createdAt: "2026-03-04T12:00:00Z",
      },
    };
    const result = parseIMessageNotification(payload);
    expect(result).not.toBeNull();
    expect(result!.is_from_me).toBe(false);
    expect(result!.is_group).toBe(true);
    expect(result!.chat_id).toBe(99);
    expect(result!.chat_guid).toBe("iMessage;-;+1555");
    expect(result!.chat_name).toBe("Test Group");
    expect(result!.chat_identifier).toBe("+1555");
    expect(result!.reply_to_id).toBe("prev-1");
    expect(result!.reply_to_text).toBe("earlier message");
    expect(result!.reply_to_sender).toBe("+15559999999");
    expect(result!.created_at).toBe("2026-03-04T12:00:00Z");
  });

  it("does not overwrite existing snake_case with camelCase", () => {
    const payload = {
      message: {
        id: 5,
        sender: "+15551234567",
        text: "both",
        is_from_me: false,
        isFromMe: true,
      },
    };
    const result = parseIMessageNotification(payload);
    expect(result).not.toBeNull();
    expect(result!.is_from_me).toBe(false);
  });

  it("normalizes camelCase in nested attachments", () => {
    const payload = {
      message: {
        id: 6,
        sender: "+15551234567",
        text: "",
        is_from_me: false,
        attachments: [{ originalPath: "/tmp/photo.jpg", mimeType: "image/jpeg" }],
      },
    };
    const result = parseIMessageNotification(payload);
    expect(result).not.toBeNull();
    expect(result!.attachments).toHaveLength(1);
    expect(result!.attachments![0].original_path).toBe("/tmp/photo.jpg");
    expect(result!.attachments![0].mime_type).toBe("image/jpeg");
  });
});

describe("parseIMessageNotification + resolveIMessageInboundDecision integration", () => {
  const cfg = {} as OpenClawConfig;

  it("camelCase isFromMe payload is dropped as 'from me' by inbound filter", () => {
    const payload = {
      message: {
        id: 100,
        sender: "+15551234567",
        text: "my own message",
        isFromMe: true,
      },
    };
    const message = parseIMessageNotification(payload);
    expect(message).not.toBeNull();

    const decision = resolveIMessageInboundDecision({
      cfg,
      accountId: "default",
      message: message!,
      opts: undefined,
      messageText: message!.text ?? "",
      bodyText: message!.text ?? "",
      allowFrom: [],
      groupAllowFrom: [],
      groupPolicy: "open",
      dmPolicy: "open",
      storeAllowFrom: [],
      historyLimit: 0,
      groupHistories: new Map(),
      echoCache: undefined,
      logVerbose: undefined,
    });

    expect(decision).toEqual({ kind: "drop", reason: "from me" });
  });
});
