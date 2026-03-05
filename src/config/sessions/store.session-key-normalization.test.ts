import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MsgContext } from "../../auto-reply/templating.js";
import {
  clearSessionStoreCacheForTest,
  loadSessionStore,
  recordSessionMetaFromInbound,
  updateLastRoute,
} from "../sessions.js";

const CANONICAL_KEY = "agent:main:webchat:dm:mixed-user";
const MIXED_CASE_KEY = "Agent:Main:WebChat:DM:MiXeD-User";

function createInboundContext(): MsgContext {
  return {
    Provider: "webchat",
    Surface: "webchat",
    ChatType: "direct",
    From: "WebChat:User-1",
    To: "webchat:agent",
    SessionKey: MIXED_CASE_KEY,
    OriginatingTo: "webchat:user-1",
  };
}

describe("session store key normalization", () => {
  let tempDir = "";
  let storePath = "";

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-session-key-normalize-"));
    storePath = path.join(tempDir, "sessions.json");
    await fs.writeFile(storePath, "{}", "utf-8");
  });

  afterEach(async () => {
    clearSessionStoreCacheForTest();
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("records inbound metadata under a canonical lowercase key", async () => {
    await recordSessionMetaFromInbound({
      storePath,
      sessionKey: MIXED_CASE_KEY,
      ctx: createInboundContext(),
    });

    const store = loadSessionStore(storePath, { skipCache: true });
    expect(Object.keys(store)).toEqual([CANONICAL_KEY]);
    expect(store[CANONICAL_KEY]?.origin?.provider).toBe("webchat");
  });

  it("does not create a duplicate mixed-case key when last route is updated", async () => {
    await recordSessionMetaFromInbound({
      storePath,
      sessionKey: CANONICAL_KEY,
      ctx: createInboundContext(),
    });

    await updateLastRoute({
      storePath,
      sessionKey: MIXED_CASE_KEY,
      channel: "webchat",
      to: "webchat:user-1",
    });

    const store = loadSessionStore(storePath, { skipCache: true });
    expect(Object.keys(store)).toEqual([CANONICAL_KEY]);
    expect(store[CANONICAL_KEY]).toEqual(
      expect.objectContaining({
        lastChannel: "webchat",
        lastTo: "webchat:user-1",
      }),
    );
  });

  it("migrates legacy mixed-case entries to the canonical key on update", async () => {
    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
          [MIXED_CASE_KEY]: {
            sessionId: "legacy-session",
            updatedAt: 1,
            chatType: "direct",
            channel: "webchat",
          },
        },
        null,
        2,
      ),
      "utf-8",
    );
    clearSessionStoreCacheForTest();

    await updateLastRoute({
      storePath,
      sessionKey: CANONICAL_KEY,
      channel: "webchat",
      to: "webchat:user-2",
    });

    const store = loadSessionStore(storePath, { skipCache: true });
    expect(store[CANONICAL_KEY]?.sessionId).toBe("legacy-session");
    expect(store[MIXED_CASE_KEY]).toBeUndefined();
  });

  it("migrates legacy group/channel alias entries to the requested canonical key", async () => {
    const channelAliasKey = "agent:main:webchat:channel:mixed-user";
    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
          [channelAliasKey]: {
            sessionId: "legacy-channel-alias",
            updatedAt: 1,
            chatType: "group",
            channel: "webchat",
          },
        },
        null,
        2,
      ),
      "utf-8",
    );
    clearSessionStoreCacheForTest();

    await updateLastRoute({
      storePath,
      sessionKey: CANONICAL_KEY.replace(":dm:", ":group:"),
      channel: "webchat",
      to: "webchat:user-3",
    });

    const store = loadSessionStore(storePath, { skipCache: true });
    const canonicalGroupKey = CANONICAL_KEY.replace(":dm:", ":group:");
    expect(store[canonicalGroupKey]?.sessionId).toBe("legacy-channel-alias");
    expect(store[channelAliasKey]).toBeUndefined();
  });

  it("preserves updatedAt when recording inbound metadata for an existing session", async () => {
    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
          [CANONICAL_KEY]: {
            sessionId: "existing-session",
            updatedAt: 1111,
            chatType: "direct",
            channel: "webchat",
            origin: {
              provider: "webchat",
              chatType: "direct",
              from: "WebChat:User-1",
              to: "webchat:user-1",
            },
          },
        },
        null,
        2,
      ),
      "utf-8",
    );
    clearSessionStoreCacheForTest();

    await recordSessionMetaFromInbound({
      storePath,
      sessionKey: CANONICAL_KEY,
      ctx: createInboundContext(),
    });

    const store = loadSessionStore(storePath, { skipCache: true });
    expect(store[CANONICAL_KEY]?.sessionId).toBe("existing-session");
    expect(store[CANONICAL_KEY]?.updatedAt).toBe(1111);
    expect(store[CANONICAL_KEY]?.origin?.provider).toBe("webchat");
  });
});
