import { beforeAll, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/config.js";
import type { HookHandler } from "../../hooks.js";
import { createHookEvent } from "../../hooks.js";
import type { InboundMessageHookContext } from "../../internal-hooks.js";

let handler: HookHandler;

beforeAll(async () => {
  ({ default: handler } = await import("./handler.js"));
});

function makeMessageEvent(
  body: string,
  opts?: {
    senderId?: string;
    channel?: string;
    cfg?: OpenClawConfig;
  },
) {
  const context: InboundMessageHookContext = {
    bodyForCommands: body,
    senderId: opts?.senderId ?? "+15551234567",
    channel: opts?.channel ?? "imessage",
    cfg: opts?.cfg,
  };
  return {
    event: createHookEvent(
      "message",
      "inbound",
      "agent:main:main",
      context as unknown as Record<string, unknown>,
    ),
    context,
  };
}

function enabledConfig(overrides?: Record<string, unknown>): OpenClawConfig {
  return {
    hooks: {
      internal: {
        entries: {
          "message-filter": { enabled: true, ...overrides },
        },
      },
    },
  };
}

describe("message-filter hook", () => {
  it("skips non-message events", async () => {
    const event = createHookEvent("command", "new", "agent:main:main", {});
    await handler(event);
    // Should not throw or set skip
    expect(event.context.skip).toBeUndefined();
  });

  it("does nothing when not enabled in config", async () => {
    const { event, context } = makeMessageEvent("Your verification code is 483920");
    await handler(event);
    expect(context.skip).toBeUndefined();
  });

  it("does nothing when config has enabled=false", async () => {
    const cfg: OpenClawConfig = {
      hooks: {
        internal: {
          entries: {
            "message-filter": { enabled: false },
          },
        },
      },
    };
    const { event, context } = makeMessageEvent("Your verification code is 483920", { cfg });
    await handler(event);
    expect(context.skip).toBeUndefined();
  });

  it("sets skip=true for OTP message", async () => {
    const cfg = enabledConfig();
    const { event, context } = makeMessageEvent("Your verification code is 483920", { cfg });
    await handler(event);
    expect(context.skip).toBe(true);
    expect(context.skipReason).toBe("message-filter:otp");
  });

  it("sets skip=true for marketing message", async () => {
    const cfg = enabledConfig();
    const { event, context } = makeMessageEvent(
      "Get 50% off your next order! Reply STOP to unsubscribe",
      { cfg },
    );
    await handler(event);
    expect(context.skip).toBe(true);
    expect(context.skipReason).toBe("message-filter:marketing");
  });

  it("sets skip=true for appointment reminder", async () => {
    const cfg = enabledConfig();
    const { event, context } = makeMessageEvent(
      "Reminder: Your appointment with Dr. Smith is tomorrow at 2pm. Reply C to confirm.",
      { cfg },
    );
    await handler(event);
    expect(context.skip).toBe(true);
    expect(context.skipReason).toBe("message-filter:appointments");
  });

  it("sets skip=true for fitness notification", async () => {
    const cfg = enabledConfig();
    const { event, context } = makeMessageEvent("Your gym class starts in 30 minutes", { cfg });
    await handler(event);
    expect(context.skip).toBe(true);
    expect(context.skipReason).toBe("message-filter:fitness");
  });

  it("passes through normal conversational message", async () => {
    const cfg = enabledConfig();
    const { event, context } = makeMessageEvent("Hey, what's the weather today?", { cfg });
    await handler(event);
    expect(context.skip).toBeUndefined();
  });

  it("never filters messages starting with /", async () => {
    const cfg = enabledConfig();
    // Even though body contains "verification code", the / prefix should bypass
    const { event, context } = makeMessageEvent("/help verification code is 123456", { cfg });
    await handler(event);
    expect(context.skip).toBeUndefined();
  });

  it("never filters allowed senders", async () => {
    const cfg = enabledConfig({ allowedSenders: ["+14046637573"] });
    const { event, context } = makeMessageEvent("Your verification code is 483920", {
      cfg,
      senderId: "+14046637573",
    });
    await handler(event);
    expect(context.skip).toBeUndefined();
  });

  it("always filters blocked senders", async () => {
    const cfg = enabledConfig({ blockedSenders: ["22395"] });
    const { event, context } = makeMessageEvent("Hello, how are you?", {
      cfg,
      senderId: "22395",
    });
    await handler(event);
    expect(context.skip).toBe(true);
    expect(context.skipReason).toBe("message-filter:blocked-sender");
  });

  it("respects disabled categories", async () => {
    const cfg = enabledConfig({ categories: { otp: false } });
    const { event, context } = makeMessageEvent("Your verification code is 483920", { cfg });
    await handler(event);
    // OTP category disabled, should pass through
    expect(context.skip).toBeUndefined();
  });

  it("matches custom patterns", async () => {
    const cfg = enabledConfig({ customPatterns: ["prescription .* is ready"] });
    const { event, context } = makeMessageEvent(
      "Your prescription refill is ready for pickup at CVS",
      { cfg },
    );
    await handler(event);
    expect(context.skip).toBe(true);
    expect(context.skipReason).toBe("message-filter:custom");
  });

  it("handles invalid custom patterns gracefully", async () => {
    const cfg = enabledConfig({ customPatterns: ["[invalid(regex"] });
    const { event, context } = makeMessageEvent("Hello there", { cfg });
    // Should not throw
    await handler(event);
    expect(context.skip).toBeUndefined();
  });

  it("detects delivery notifications", async () => {
    const cfg = enabledConfig();
    const { event, context } = makeMessageEvent("Your package has been delivered to front door", {
      cfg,
    });
    await handler(event);
    expect(context.skip).toBe(true);
    expect(context.skipReason).toBe("message-filter:delivery");
  });

  it("detects banking alerts", async () => {
    const cfg = enabledConfig();
    const { event, context } = makeMessageEvent("Transaction alert: Purchase of $42.50 at Amazon", {
      cfg,
    });
    await handler(event);
    expect(context.skip).toBe(true);
    expect(context.skipReason).toBe("message-filter:banking");
  });

  it("filters shortcode senders (5-6 digit numbers)", async () => {
    const cfg = enabledConfig();
    const { event, context } = makeMessageEvent(
      "Tiffany & Co.: There's still time to make it an unforgettable Valentine's Day. Shop now: tiffany.attn.tv/abc",
      { cfg, senderId: "74640" },
    );
    await handler(event);
    expect(context.skip).toBe(true);
    expect(context.skipReason).toBe("message-filter:shortcode");
  });

  it("does not filter normal phone numbers as shortcodes", async () => {
    const cfg = enabledConfig();
    const { event, context } = makeMessageEvent("Hey, what's up?", {
      cfg,
      senderId: "+14046637573",
    });
    await handler(event);
    expect(context.skip).toBeUndefined();
  });

  it("allows shortcodes when filterShortcodes is false", async () => {
    const cfg = enabledConfig({ filterShortcodes: false });
    const { event, context } = makeMessageEvent("Some message from shortcode", {
      cfg,
      senderId: "74640",
    });
    await handler(event);
    // Shortcode filtering disabled, passes through (unless content matches)
    expect(context.skipReason).not.toBe("message-filter:shortcode");
  });

  it("detects 'Shop now' marketing (Tiffany real-world example)", async () => {
    const cfg = enabledConfig();
    const { event, context } = makeMessageEvent(
      "Tiffany & Co.: There's still time to make it an unforgettable Valentine's Day. Explore quintessential expressions of love. Shop now: tiffany.attn.tv/abc",
      { cfg },
    );
    await handler(event);
    expect(context.skip).toBe(true);
    expect(context.skipReason).toBe("message-filter:marketing");
  });

  it("detects appointment with 'reserved' phrasing (dentist real-world example)", async () => {
    const cfg = enabledConfig();
    const { event, context } = makeMessageEvent(
      "Christopher, you have an appointment reserved with New Face Dentistry on Thursday, Feb 12th at 11:00 AM.",
      { cfg },
    );
    await handler(event);
    expect(context.skip).toBe(true);
    expect(context.skipReason).toBe("message-filter:appointments");
  });

  it("detects 'you have an appointment' phrasing", async () => {
    const cfg = enabledConfig();
    const { event, context } = makeMessageEvent(
      "You have an appointment at 3pm tomorrow with Dr. Lee",
      { cfg },
    );
    await handler(event);
    expect(context.skip).toBe(true);
    expect(context.skipReason).toBe("message-filter:appointments");
  });
});
