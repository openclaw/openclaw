import { describe, expect, it, vi } from "vitest";
import { resolveInboundDebounceMs } from "../auto-reply/inbound-debounce.js";
import {
  createChannelInboundDebouncer,
  shouldDebounceTextInbound,
} from "./inbound-debounce-policy.js";

describe("shouldDebounceTextInbound", () => {
  it("rejects blank text, media, and control commands", () => {
    const cfg = {} as Parameters<typeof shouldDebounceTextInbound>[0]["cfg"];

    expect(shouldDebounceTextInbound({ text: "   ", cfg })).toBe(false);
    expect(shouldDebounceTextInbound({ text: "hello", cfg, hasMedia: true })).toBe(false);
    expect(shouldDebounceTextInbound({ text: "/status", cfg })).toBe(false);
  });

  it("accepts normal text when debounce is allowed", () => {
    const cfg = {} as Parameters<typeof shouldDebounceTextInbound>[0]["cfg"];
    expect(shouldDebounceTextInbound({ text: "hello there", cfg })).toBe(true);
    expect(shouldDebounceTextInbound({ text: "hello there", cfg, allowDebounce: false })).toBe(
      false,
    );
  });
});

describe("resolveInboundDebounceMs", () => {
  it("respects override precedence: explicit > session > channel > base", () => {
    const cfg = {
      messages: {
        inbound: {
          debounceMs: 10,
          byChannel: {
            discord: 20,
          },
          bySessionId: {
            "discord:default:c1": 30,
          },
        },
      },
    } as Parameters<typeof resolveInboundDebounceMs>[0]["cfg"];

    expect(
      resolveInboundDebounceMs({
        cfg,
        channel: "discord",
        sessionId: "discord:default:c1",
      }),
    ).toBe(30);
    expect(
      resolveInboundDebounceMs({
        cfg,
        channel: "discord",
        sessionId: "discord:default:c1",
        overrideMs: 40,
      }),
    ).toBe(40);
    expect(
      resolveInboundDebounceMs({
        cfg,
        channel: "discord",
        sessionId: "discord:default:c2",
      }),
    ).toBe(20);
    expect(resolveInboundDebounceMs({ cfg, channel: "telegram" })).toBe(10);
  });

  it("uses longest matching session prefix and supports zero-valued overrides", () => {
    const cfg = {
      messages: {
        inbound: {
          debounceMs: 25,
          bySessionId: {
            "discord:default:": 12,
            "discord:default:ch-": 8,
            "discord:default:ch-1": 0,
          },
        },
      },
    } as Parameters<typeof resolveInboundDebounceMs>[0]["cfg"];

    expect(
      resolveInboundDebounceMs({
        cfg,
        channel: "discord",
        sessionId: "discord:default:ch-1",
      }),
    ).toBe(0);
    expect(
      resolveInboundDebounceMs({
        cfg,
        channel: "discord",
        sessionId: "discord:default:ch-2",
      }),
    ).toBe(8);
    expect(
      resolveInboundDebounceMs({
        cfg,
        channel: "discord",
        sessionId: "discord:other:ch-2",
      }),
    ).toBe(25);
  });
});

describe("createChannelInboundDebouncer", () => {
  it("resolves per-channel debounce and forwards callbacks", async () => {
    vi.useFakeTimers();
    try {
      const flushed: string[][] = [];
      const cfg = {
        messages: {
          inbound: {
            debounceMs: 10,
            byChannel: {
              slack: 25,
            },
          },
        },
      } as Parameters<typeof createChannelInboundDebouncer<{ id: string }>>[0]["cfg"];

      const { debounceMs, debouncer } = createChannelInboundDebouncer<{ id: string }>({
        cfg,
        channel: "slack",
        buildKey: (item) => item.id,
        onFlush: async (items) => {
          flushed.push(items.map((entry) => entry.id));
        },
      });

      expect(debounceMs).toBe(25);

      await debouncer.enqueue({ id: "a" });
      await debouncer.enqueue({ id: "a" });
      await vi.advanceTimersByTimeAsync(30);

      expect(flushed).toEqual([["a", "a"]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("applies per-session overrides, including zero to disable debouncing", async () => {
    const flushed: string[][] = [];
    const cfg = {
      messages: {
        inbound: {
          debounceMs: 30,
          bySessionId: {
            "discord:default:ch-1": 0,
          },
        },
      },
    } as Parameters<typeof createChannelInboundDebouncer<{ id: string }>>[0]["cfg"];

    const { debounceMs, debouncer } = createChannelInboundDebouncer<{ id: string }>({
      cfg,
      channel: "discord",
      sessionId: "discord:default:ch-1",
      buildKey: (item) => item.id,
      onFlush: async (items) => {
        flushed.push(items.map((entry) => entry.id));
      },
    });

    expect(debounceMs).toBe(0);

    await debouncer.enqueue({ id: "a" });
    await debouncer.enqueue({ id: "a" });

    expect(flushed).toEqual([["a"], ["a"]]);
  });
});
