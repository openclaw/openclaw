import { afterEach, describe, expect, it } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/config.js";
import { buildTelegramMessageContextForTest } from "./bot-message-context.test-harness.js";

/**
 * Regression tests for issue #32351: DMs on named Telegram accounts were
 * silently dropped when there was no explicit binding (matchedBy === "default").
 * The fix allows DMs through with a per-account session key so each named
 * account's conversations remain isolated even when sharing the default agent.
 */
describe("buildTelegramMessageContext named-account DM routing (issue #32351)", () => {
  const namedAccountCfg = {
    agents: { defaults: { model: "anthropic/claude-opus-4-5", workspace: "/tmp/openclaw" } },
    channels: { telegram: {} },
    messages: { groupChat: { mentionPatterns: [] } },
    // no bindings → route.matchedBy will be "default"
  };

  afterEach(() => {
    clearRuntimeConfigSnapshot();
  });

  it("allows DM through for named account with no explicit binding", async () => {
    setRuntimeConfigSnapshot(namedAccountCfg);

    const ctx = await buildTelegramMessageContextForTest({
      cfg: namedAccountCfg,
      accountId: "atlas",
      dmPolicy: "open",
      message: {
        message_id: 1,
        chat: { id: 814912386, type: "private" },
        date: 1700000000,
        text: "hello",
        from: { id: 814912386, first_name: "Alice" },
      },
    });

    expect(ctx).not.toBeNull();
  });

  it("uses per-account session key for named account DMs with no explicit binding", async () => {
    setRuntimeConfigSnapshot(namedAccountCfg);

    const ctx = await buildTelegramMessageContextForTest({
      cfg: namedAccountCfg,
      accountId: "atlas",
      dmPolicy: "open",
      message: {
        message_id: 1,
        chat: { id: 814912386, type: "private" },
        date: 1700000000,
        text: "hello",
        from: { id: 814912386, first_name: "Alice" },
      },
    });

    expect(ctx).not.toBeNull();
    // Key format: agent:<agentId>:telegram:<accountId>:direct:<peerId>
    expect(ctx?.ctxPayload?.SessionKey).toBe("agent:main:telegram:atlas:direct:814912386");
  });

  it("isolates DM sessions between two different named accounts with the same default agent", async () => {
    setRuntimeConfigSnapshot(namedAccountCfg);

    const ctxAtlas = await buildTelegramMessageContextForTest({
      cfg: namedAccountCfg,
      accountId: "atlas",
      dmPolicy: "open",
      message: {
        message_id: 1,
        chat: { id: 814912386, type: "private" },
        date: 1700000000,
        text: "hello",
        from: { id: 814912386, first_name: "Alice" },
      },
    });

    const ctxSkynet = await buildTelegramMessageContextForTest({
      cfg: namedAccountCfg,
      accountId: "skynet",
      dmPolicy: "open",
      message: {
        message_id: 2,
        chat: { id: 814912386, type: "private" },
        date: 1700000001,
        text: "hello",
        from: { id: 814912386, first_name: "Alice" },
      },
    });

    expect(ctxAtlas).not.toBeNull();
    expect(ctxSkynet).not.toBeNull();
    // Each named account gets a distinct session key, preventing cross-account contamination.
    expect(ctxAtlas?.ctxPayload?.SessionKey).not.toBe(ctxSkynet?.ctxPayload?.SessionKey);
    expect(ctxAtlas?.ctxPayload?.SessionKey).toBe("agent:main:telegram:atlas:direct:814912386");
    expect(ctxSkynet?.ctxPayload?.SessionKey).toBe("agent:main:telegram:skynet:direct:814912386");
  });

  it("still drops group messages for named accounts with no explicit binding", async () => {
    setRuntimeConfigSnapshot(namedAccountCfg);

    const ctx = await buildTelegramMessageContextForTest({
      cfg: namedAccountCfg,
      accountId: "atlas",
      dmPolicy: "open",
      options: { forceWasMentioned: true },
      resolveGroupActivation: () => true,
      message: {
        message_id: 1,
        chat: { id: -1001234567890, type: "supergroup", title: "Test Group" },
        date: 1700000000,
        text: "@bot hello",
        from: { id: 814912386, first_name: "Alice" },
      },
    });

    // Groups require an explicit binding; named accounts without one are still dropped.
    expect(ctx).toBeNull();
  });

  it("default account DM still uses normal session key (no regression)", async () => {
    setRuntimeConfigSnapshot(namedAccountCfg);

    const ctx = await buildTelegramMessageContextForTest({
      cfg: namedAccountCfg,
      // accountId defaults to "default"
      dmPolicy: "open",
      message: {
        message_id: 1,
        chat: { id: 42, type: "private" },
        date: 1700000000,
        text: "hello",
        from: { id: 42, first_name: "Alice" },
      },
    });

    expect(ctx).not.toBeNull();
    // Default account uses the normal dmScope="main" session key.
    expect(ctx?.ctxPayload?.SessionKey).toBe("agent:main:main");
  });
});
