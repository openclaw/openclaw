import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  clearInternalHooks,
  createInternalHookEvent,
  triggerInternalHook,
} from "../hooks/internal-hooks.js";
import type { OutboundSendDeps } from "../infra/outbound/deliver.js";
import {
  buildNotificationText,
  registerPairingNotifyHook,
  resolvePairingNotifyConfig,
  sanitizeField,
  unregisterPairingNotifyHook,
} from "./notify-owner.js";

beforeEach(() => {
  clearInternalHooks();
});

afterEach(() => {
  unregisterPairingNotifyHook();
  clearInternalHooks();
});

describe("sanitizeField", () => {
  it("strips control characters", () => {
    expect(sanitizeField("hello\x00world\x1f!", 64)).toBe("helloworld!");
  });

  it("strips zero-width characters", () => {
    expect(sanitizeField("test\u200bvalue\ufeff", 64)).toBe("testvalue");
  });

  it("truncates to max length", () => {
    expect(sanitizeField("abcdef", 3)).toBe("abc");
  });

  it("handles empty string", () => {
    expect(sanitizeField("", 10)).toBe("");
  });
});

describe("buildNotificationText", () => {
  it("formats with name from meta", () => {
    const text = buildNotificationText({
      requesterId: "+14155551234",
      channelId: "whatsapp",
      code: "ABCD1234",
      meta: { name: "Alice" },
    });
    expect(text).toBe("Pairing request: Alice (+14155551234) via whatsapp — code ABCD1234");
  });

  it("formats with displayName from meta", () => {
    const text = buildNotificationText({
      requesterId: "123456",
      channelId: "telegram",
      code: "XYZ789",
      meta: { displayName: "Bob" },
    });
    expect(text).toBe("Pairing request: Bob (123456) via telegram — code XYZ789");
  });

  it("falls back to 'unknown' when no name in meta", () => {
    const text = buildNotificationText({
      requesterId: "+14155551234",
      channelId: "imessage",
      code: "CODE1234",
    });
    expect(text).toBe("Pairing request: unknown (+14155551234) via imessage — code CODE1234");
  });

  it("sanitizes injection attempts in name", () => {
    const text = buildNotificationText({
      requesterId: "+14155551234",
      channelId: "whatsapp",
      code: "ABCD1234",
      meta: { name: "Evil\x00Name\u200b" },
    });
    expect(text).toContain("EvilName");
    expect(text).not.toContain("\x00");
    expect(text).not.toContain("\u200b");
  });
});

describe("resolvePairingNotifyConfig", () => {
  it("returns null when no pairing config", () => {
    expect(resolvePairingNotifyConfig({})).toBeNull();
  });

  it("returns null when no notify config", () => {
    expect(resolvePairingNotifyConfig({ pairing: {} })).toBeNull();
  });

  it("returns null when no target", () => {
    expect(resolvePairingNotifyConfig({ pairing: { notify: {} } })).toBeNull();
  });

  it("returns null when target is whitespace only", () => {
    expect(resolvePairingNotifyConfig({ pairing: { notify: { target: "   " } } })).toBeNull();
  });

  it("returns null when explicitly disabled", () => {
    expect(
      resolvePairingNotifyConfig({
        pairing: { notify: { target: "+14155551234", enabled: false } },
      }),
    ).toBeNull();
  });

  it("returns config when target is set", () => {
    const cfg: OpenClawConfig = {
      pairing: { notify: { target: "+14155551234", channel: "imessage" } },
    };
    const result = resolvePairingNotifyConfig(cfg);
    expect(result).toEqual({ target: "+14155551234", channel: "imessage" });
  });

  it("returns config when target is set and enabled is true", () => {
    const cfg: OpenClawConfig = {
      pairing: { notify: { target: "+14155551234", enabled: true } },
    };
    const result = resolvePairingNotifyConfig(cfg);
    expect(result).toEqual({ target: "+14155551234", enabled: true });
  });
});

describe("registerPairingNotifyHook", () => {
  it("does not register when no target configured", () => {
    const sendIMessage = vi.fn().mockResolvedValue({ messageId: "m1" });
    registerPairingNotifyHook({
      cfg: {},
      sendDeps: { sendIMessage } as unknown as OutboundSendDeps,
    });

    const event = createInternalHookEvent("pairing", "request", "", {
      channelId: "whatsapp",
      requesterId: "+14155551234",
      code: "ABCD1234",
    });
    void triggerInternalHook(event);
    expect(sendIMessage).not.toHaveBeenCalled();
  });

  it("sends iMessage notification on pairing:request event", async () => {
    const sendIMessage = vi.fn().mockResolvedValue({ messageId: "m1" });
    registerPairingNotifyHook({
      cfg: {
        pairing: { notify: { target: "+14158605055", channel: "imessage" } },
      },
      sendDeps: { sendIMessage } as unknown as OutboundSendDeps,
    });

    const event = createInternalHookEvent("pairing", "request", "", {
      channelId: "whatsapp",
      requesterId: "+14155551234",
      code: "ABCD1234",
      meta: { name: "Alice" },
    });
    await triggerInternalHook(event);

    expect(sendIMessage).toHaveBeenCalledOnce();
    const [to, text] = sendIMessage.mock.calls[0];
    expect(to).toBe("+14158605055");
    expect(text).toContain("Alice");
    expect(text).toContain("+14155551234");
    expect(text).toContain("whatsapp");
    expect(text).toContain("ABCD1234");
  });

  it("sends Telegram notification when configured", async () => {
    const sendTelegram = vi.fn().mockResolvedValue({ messageId: "t1" });
    registerPairingNotifyHook({
      cfg: {
        pairing: { notify: { target: "12345", channel: "telegram" } },
      },
      sendDeps: { sendTelegram } as unknown as OutboundSendDeps,
    });

    const event = createInternalHookEvent("pairing", "request", "", {
      channelId: "discord",
      requesterId: "user#1234",
      code: "XYZ789",
    });
    await triggerInternalHook(event);

    expect(sendTelegram).toHaveBeenCalledOnce();
    expect(sendTelegram.mock.calls[0][0]).toBe("12345");
  });

  it("does not fire on non-pairing events", async () => {
    const sendIMessage = vi.fn().mockResolvedValue({ messageId: "m1" });
    registerPairingNotifyHook({
      cfg: {
        pairing: { notify: { target: "+14158605055" } },
      },
      sendDeps: { sendIMessage } as unknown as OutboundSendDeps,
    });

    const event = createInternalHookEvent("message", "received", "test-session", {
      from: "+14155551234",
      channelId: "whatsapp",
    });
    await triggerInternalHook(event);

    expect(sendIMessage).not.toHaveBeenCalled();
  });

  it("does not throw when send fails", async () => {
    const sendIMessage = vi.fn().mockRejectedValue(new Error("send failed"));
    registerPairingNotifyHook({
      cfg: {
        pairing: { notify: { target: "+14158605055" } },
      },
      sendDeps: { sendIMessage } as unknown as OutboundSendDeps,
    });

    const event = createInternalHookEvent("pairing", "request", "", {
      channelId: "whatsapp",
      requesterId: "+14155551234",
      code: "ABCD1234",
    });
    // Should not throw.
    await triggerInternalHook(event);
    expect(sendIMessage).toHaveBeenCalledOnce();
  });

  it("unregisters cleanly", async () => {
    const sendIMessage = vi.fn().mockResolvedValue({ messageId: "m1" });
    registerPairingNotifyHook({
      cfg: {
        pairing: { notify: { target: "+14158605055" } },
      },
      sendDeps: { sendIMessage } as unknown as OutboundSendDeps,
    });
    unregisterPairingNotifyHook();

    const event = createInternalHookEvent("pairing", "request", "", {
      channelId: "whatsapp",
      requesterId: "+14155551234",
      code: "ABCD1234",
    });
    await triggerInternalHook(event);
    expect(sendIMessage).not.toHaveBeenCalled();
  });

  it("passes accountId from config to send function", async () => {
    const sendTelegram = vi.fn().mockResolvedValue({ messageId: "t1" });
    registerPairingNotifyHook({
      cfg: {
        pairing: {
          notify: { target: "12345", channel: "telegram", accountId: "bot-2" },
        },
      },
      sendDeps: { sendTelegram } as unknown as OutboundSendDeps,
    });

    const event = createInternalHookEvent("pairing", "request", "", {
      channelId: "whatsapp",
      requesterId: "+14155551234",
      code: "ABCD1234",
    });
    await triggerInternalHook(event);

    expect(sendTelegram).toHaveBeenCalledOnce();
    const opts = sendTelegram.mock.calls[0][2];
    expect(opts).toEqual({ accountId: "bot-2" });
  });
});
