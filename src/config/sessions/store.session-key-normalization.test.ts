import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { MsgContext } from "../../auto-reply/templating.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { createSuiteTempRootTracker } from "../../test-helpers/temp-dir.js";
import { recordSessionMetaFromInbound, updateLastRoute } from "../sessions.js";
import { listSessionEntries, upsertSessionEntry } from "./store.js";
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

describe("session store key normalization", () => {
  const suiteRootTracker = createSuiteTempRootTracker({
    prefix: "openclaw-session-key-normalize-",
  });
  let tempDir = "";
  let previousStateDir: string | undefined;

  beforeAll(async () => {
    await suiteRootTracker.setup();
  });

  beforeEach(async () => {
    tempDir = await suiteRootTracker.make("case");
    previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = tempDir;
  });

  afterEach(async () => {
    closeOpenClawAgentDatabasesForTest();
    if (previousStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
  });

  afterAll(async () => {
    await suiteRootTracker.cleanup();
  });

  function readMainSessionRows(): Record<string, SessionEntry> {
    return Object.fromEntries(
      listSessionEntries({ agentId: "main" }).map(({ sessionKey, entry }) => [sessionKey, entry]),
    );
  }

  function seedRawSessionEntry(sessionKey: string, entry: SessionEntry): void {
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    database.db
      .prepare(
        `
          INSERT INTO session_entries (session_key, entry_json, updated_at)
          VALUES (?, ?, ?)
        `,
      )
      .run(sessionKey, JSON.stringify(entry), entry.updatedAt ?? Date.now());
  }

  it("records inbound metadata under a canonical lowercase key", async () => {
    await recordSessionMetaFromInbound({
      agentId: "main",
      sessionKey: MIXED_CASE_KEY,
      ctx: createInboundContext(),
    });

    const store = readMainSessionRows();
    expect(Object.keys(store)).toEqual([CANONICAL_KEY]);
    expect(store[CANONICAL_KEY]?.origin?.provider).toBe("webchat");
  });

  it("does not create a duplicate mixed-case key when last route is updated", async () => {
    await recordSessionMetaFromInbound({
      agentId: "main",
      sessionKey: CANONICAL_KEY,
      ctx: createInboundContext(),
    });

    await updateLastRoute({
      agentId: "main",
      sessionKey: MIXED_CASE_KEY,
      channel: "webchat",
      to: "webchat:user-1",
    });

    const store = readMainSessionRows();
    expect(Object.keys(store)).toEqual([CANONICAL_KEY]);
    expect(store[CANONICAL_KEY]).toEqual(
      expect.objectContaining({
        lastChannel: "webchat",
        lastTo: "webchat:user-1",
      }),
    );
  });

  it("does not migrate legacy mixed-case entries during runtime updates", async () => {
    seedRawSessionEntry(MIXED_CASE_KEY, {
      sessionId: "legacy-session",
      updatedAt: 1,
      chatType: "direct",
      channel: "webchat",
    });

    await updateLastRoute({
      agentId: "main",
      sessionKey: CANONICAL_KEY,
      channel: "webchat",
      to: "webchat:user-2",
    });

    const store = readMainSessionRows();
    expect(store[CANONICAL_KEY]?.sessionId).not.toBe("legacy-session");
    expect(store[MIXED_CASE_KEY]?.sessionId).toBe("legacy-session");
  });

  it("preserves updatedAt when recording inbound metadata for an existing session", async () => {
    const existingUpdatedAt = Date.now();
    upsertSessionEntry({
      agentId: "main",
      sessionKey: CANONICAL_KEY,
      entry: {
        sessionId: "existing-session",
        updatedAt: existingUpdatedAt,
        chatType: "direct",
        channel: "webchat",
        origin: {
          provider: "webchat",
          chatType: "direct",
          from: "WebChat:User-1",
          to: "webchat:user-1",
        },
      },
    });

    await recordSessionMetaFromInbound({
      agentId: "main",
      sessionKey: CANONICAL_KEY,
      ctx: createInboundContext(),
    });

    const store = readMainSessionRows();
    expect(store[CANONICAL_KEY]?.sessionId).toBe("existing-session");
    expect(store[CANONICAL_KEY]?.updatedAt).toBe(existingUpdatedAt);
    expect(store[CANONICAL_KEY]?.origin?.provider).toBe("webchat");
  });
});
