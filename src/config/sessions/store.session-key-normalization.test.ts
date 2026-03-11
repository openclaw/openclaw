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
import { useSessionStoreTestDb } from "./test-helpers.sqlite.js";
import type { SessionEntry } from "./types.js";

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

let caseId = 0;

describe("session store key normalization", () => {
  const testDb = useSessionStoreTestDb();
  let storePath = "";

  beforeEach(() => {
    const agentId = `key-norm-${caseId++}`;
    storePath = path.join(os.tmpdir(), "agents", agentId, "sessions", "sessions.json");
  });

  afterEach(() => {
    clearSessionStoreCacheForTest();
  });

  it("records inbound metadata under a canonical lowercase key", async () => {
    testDb.seed(storePath, {});

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
    testDb.seed(storePath, {});

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
    testDb.seed(storePath, {
      [MIXED_CASE_KEY]: {
        sessionId: "legacy-session",
        updatedAt: 1,
        chatType: "direct",
        channel: "webchat",
      } as SessionEntry,
    });

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

  it("preserves updatedAt when recording inbound metadata for an existing session", async () => {
    testDb.seed(storePath, {
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
      } as SessionEntry,
    });

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
