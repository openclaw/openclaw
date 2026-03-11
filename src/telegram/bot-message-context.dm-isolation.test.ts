import { afterEach, describe, expect, it, vi, beforeEach } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/config.js";
import {
  baseTelegramMessageContextConfig,
  buildTelegramMessageContextForTest,
} from "./bot-message-context.test-harness.js";

// Mock recordInboundSession to capture session key
const recordInboundSessionMock = vi.fn().mockResolvedValue(undefined);
vi.mock("../channels/session.js", () => ({
  recordInboundSession: (...args: unknown[]) => recordInboundSessionMock(...args),
}));

describe("Telegram DM session isolation (#41165)", () => {
  beforeEach(() => {
    recordInboundSessionMock.mockClear();
  });
  afterEach(() => {
    clearRuntimeConfigSnapshot();
  });

  it("isolates DMs from agent:main:main when dmScope is unset (default)", async () => {
    const ctx = await buildTelegramMessageContextForTest({
      message: {
        chat: { id: 7463849194, type: "private" },
        from: { id: 7463849194, first_name: "Alice" },
        text: "hello",
      },
    });

    expect(ctx).toBeTruthy();
    if (!ctx) {
      return;
    }

    // Session key should NOT be agent:main:main — it should be isolated
    const sessionKey = ctx.ctxPayload.SessionKey;
    expect(sessionKey).not.toBe("agent:main:main");
    // Should use per-channel-peer format: agent:main:telegram:direct:<id>
    expect(sessionKey).toMatch(/^agent:main:telegram:direct:\d+$/);
  });

  it("respects explicit dmScope: main (operator opt-in)", async () => {
    // Set runtime config so loadConfig() also returns dmScope: "main"
    setRuntimeConfigSnapshot({
      ...baseTelegramMessageContextConfig,
      session: { dmScope: "main" },
    } as never);

    const ctx = await buildTelegramMessageContextForTest({
      message: {
        chat: { id: 7463849194, type: "private" },
        from: { id: 7463849194, first_name: "Alice" },
        text: "hello",
      },
      cfg: {
        ...baseTelegramMessageContextConfig,
        session: { dmScope: "main" },
      },
    });

    expect(ctx).toBeTruthy();
    if (!ctx) {
      return;
    }

    // When operator explicitly sets dmScope: "main", DMs should route to main
    const sessionKey = ctx.ctxPayload.SessionKey;
    expect(sessionKey).toBe("agent:main:main");
  });

  it("does not rewrite explicit DM peer bindings that intentionally target main", async () => {
    const cfg = {
      ...baseTelegramMessageContextConfig,
      bindings: [
        {
          agentId: "main",
          match: {
            channel: "telegram",
            peer: { kind: "direct", id: "7463849194" },
          },
        },
      ],
    } as const;
    setRuntimeConfigSnapshot(cfg as never);

    const ctx = await buildTelegramMessageContextForTest({
      message: {
        chat: { id: 7463849194, type: "private" },
        from: { id: 7463849194, first_name: "Alice" },
        text: "hello",
      },
      cfg,
    });

    expect(ctx).toBeTruthy();
    if (!ctx) {
      return;
    }

    expect(ctx.route.matchedBy).toBe("binding.peer");
    expect(ctx.ctxPayload.SessionKey).toBe("agent:main:main");
  });

  it("does not rewrite explicit account bindings that intentionally target main", async () => {
    const cfg = {
      ...baseTelegramMessageContextConfig,
      bindings: [
        {
          agentId: "main",
          match: {
            channel: "telegram",
            account: "default",
          },
        },
      ],
    } as const;
    setRuntimeConfigSnapshot(cfg as never);

    const ctx = await buildTelegramMessageContextForTest({
      message: {
        chat: { id: 7463849194, type: "private" },
        from: { id: 7463849194, first_name: "Alice" },
        text: "hello",
      },
      cfg,
    });

    expect(ctx).toBeTruthy();
    if (!ctx) {
      return;
    }

    expect(ctx.route.matchedBy).toBe("binding.account");
    expect(ctx.ctxPayload.SessionKey).toBe("agent:main:main");
  });

  it("preserves per-peer isolation when dmScope is per-peer", async () => {
    setRuntimeConfigSnapshot({
      ...baseTelegramMessageContextConfig,
      session: { dmScope: "per-peer" },
    } as never);

    const ctx = await buildTelegramMessageContextForTest({
      message: {
        chat: { id: 7463849194, type: "private" },
        from: { id: 7463849194, first_name: "Alice" },
        text: "hello",
      },
      cfg: {
        ...baseTelegramMessageContextConfig,
        session: { dmScope: "per-peer" },
      },
    });

    expect(ctx).toBeTruthy();
    if (!ctx) {
      return;
    }

    const sessionKey = ctx.ctxPayload.SessionKey;
    expect(sessionKey).not.toBe("agent:main:main");
    expect(sessionKey).toBe("agent:main:direct:7463849194");
  });

  it("preserves per-channel-peer isolation when dmScope is per-channel-peer", async () => {
    setRuntimeConfigSnapshot({
      ...baseTelegramMessageContextConfig,
      session: { dmScope: "per-channel-peer" },
    } as never);

    const ctx = await buildTelegramMessageContextForTest({
      message: {
        chat: { id: 7463849194, type: "private" },
        from: { id: 7463849194, first_name: "Alice" },
        text: "hello",
      },
      cfg: {
        ...baseTelegramMessageContextConfig,
        session: { dmScope: "per-channel-peer" },
      },
    });

    expect(ctx).toBeTruthy();
    if (!ctx) {
      return;
    }

    const sessionKey = ctx.ctxPayload.SessionKey;
    expect(sessionKey).not.toBe("agent:main:main");
    // per-channel-peer format: agent:main:telegram:direct:<id>
    expect(sessionKey).toMatch(/^agent:main:telegram:direct:\d+$/);
  });

  it("does not affect group routing", async () => {
    const ctx = await buildTelegramMessageContextForTest({
      message: {
        chat: { id: -100123456, type: "supergroup", title: "Test Group" },
        from: { id: 42, first_name: "Alice" },
        text: "hello",
      },
    });

    expect(ctx).toBeTruthy();
    if (!ctx) {
      return;
    }

    // Group session key should contain the group peer id
    const sessionKey = ctx.ctxPayload.SessionKey;
    expect(sessionKey).toContain("group");
  });
});
