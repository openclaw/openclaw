import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MsgContext } from "../auto-reply/templating.js";
import { loadSessionStore } from "../config/sessions.js";
import { recordInboundSession } from "./session.js";

const recordSessionMetaFromInboundMock = vi.fn((_args?: unknown) => Promise.resolve(undefined));
const updateLastRouteMock = vi.fn((_args?: unknown) => Promise.resolve(undefined));

vi.mock("../config/sessions.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/sessions.js")>();
  return {
    ...actual,
    recordSessionMetaFromInbound: (args: unknown) => recordSessionMetaFromInboundMock(args),
    updateLastRoute: (args: unknown) => updateLastRouteMock(args),
  };
});

describe("recordInboundSession - session routing", () => {
  const ctx: MsgContext = {
    Provider: "telegram",
    From: "telegram:1234",
    SessionKey: "agent:main:telegram:1234:thread:42",
    OriginatingTo: "telegram:1234",
  };

  beforeEach(() => {
    recordSessionMetaFromInboundMock.mockClear();
    updateLastRouteMock.mockClear();
  });

  it("does not pass ctx when updating a different session key", async () => {
    await recordInboundSession({
      storePath: "/tmp/openclaw-session-store.json",
      sessionKey: "agent:main:telegram:1234:thread:42",
      ctx,
      updateLastRoute: {
        sessionKey: "agent:main:main",
        channel: "telegram",
        to: "telegram:1234",
      },
      onRecordError: vi.fn(),
    });

    expect(updateLastRouteMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:main",
        ctx: undefined,
        deliveryContext: expect.objectContaining({
          channel: "telegram",
          to: "telegram:1234",
        }),
      }),
    );
  });

  it("passes ctx when updating the same session key", async () => {
    await recordInboundSession({
      storePath: "/tmp/openclaw-session-store.json",
      sessionKey: "agent:main:telegram:1234:thread:42",
      ctx,
      updateLastRoute: {
        sessionKey: "agent:main:telegram:1234:thread:42",
        channel: "telegram",
        to: "telegram:1234",
      },
      onRecordError: vi.fn(),
    });

    expect(updateLastRouteMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:telegram:1234:thread:42",
        ctx,
        deliveryContext: expect.objectContaining({
          channel: "telegram",
          to: "telegram:1234",
        }),
      }),
    );
  });
});

describe("recordInboundSession - webchat delivery context", () => {
  let dir: string;
  let storePath: string;

  afterEach(async () => {
    if (dir) {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("skips updateLastRoute when channel is webchat (internal)", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-webchat-"));
    storePath = path.join(dir, "sessions.json");

    // Seed store with main session owned by telegram
    const mainKey = "agent:main:main";
    await fs.writeFile(
      storePath,
      JSON.stringify({
        [mainKey]: {
          sessionId: "sess-1",
          updatedAt: Date.now(),
          lastChannel: "telegram",
          lastTo: "telegram:123",
          lastAccountId: "default",
          deliveryContext: {
            channel: "telegram",
            to: "telegram:123",
            accountId: "default",
          },
        },
      }),
      "utf-8",
    );

    // WebChat sends to main session
    await recordInboundSession({
      storePath,
      sessionKey: mainKey,
      ctx: {
        Body: "hello from webchat",
        SessionKey: mainKey,
        Provider: "webchat",
        Surface: "webchat",
        OriginatingChannel: "webchat",
        ChatType: "direct",
      },
      updateLastRoute: {
        sessionKey: mainKey,
        channel: "webchat",
        to: "",
      },
      onRecordError: () => {},
    });

    // Delivery context should still be telegram, not webchat
    const store = loadSessionStore(storePath);
    const entry = store[mainKey];
    expect(entry?.lastChannel).toBe("telegram");
    expect(entry?.deliveryContext?.channel).toBe("telegram");
    expect(entry?.deliveryContext?.to).toBe("telegram:123");
  });

  it("updates lastRoute normally for external channels", async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-external-"));
    storePath = path.join(dir, "sessions.json");

    const mainKey = "agent:main:main";
    await fs.writeFile(
      storePath,
      JSON.stringify({
        [mainKey]: {
          sessionId: "sess-1",
          updatedAt: Date.now(),
          lastChannel: "telegram",
          lastTo: "telegram:123",
          deliveryContext: {
            channel: "telegram",
            to: "telegram:123",
          },
        },
      }),
      "utf-8",
    );

    // Discord sends to main session
    await recordInboundSession({
      storePath,
      sessionKey: mainKey,
      ctx: {
        Body: "hello from discord",
        SessionKey: mainKey,
        Provider: "discord",
        Surface: "discord",
        OriginatingChannel: "discord",
        ChatType: "group",
      },
      updateLastRoute: {
        sessionKey: mainKey,
        channel: "discord",
        to: "channel:discord-456",
        accountId: "bot-1",
      },
      onRecordError: () => {},
    });

    // Delivery context should now be discord
    const store = loadSessionStore(storePath);
    const entry = store[mainKey];
    expect(entry?.lastChannel).toBe("discord");
    expect(entry?.deliveryContext?.channel).toBe("discord");
    expect(entry?.deliveryContext?.to).toBe("channel:discord-456");
  });
});
