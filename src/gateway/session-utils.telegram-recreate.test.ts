import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { MsgContext } from "../auto-reply/templating.js";
import {
  deleteSessionEntry,
  getSessionEntry,
  listSessionEntries,
  recordSessionMetaFromInbound,
  updateLastRoute,
  upsertSessionEntry,
} from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { listSessionsFromStore } from "./session-utils.js";

const TELEGRAM_DIRECT_KEY = "agent:main:telegram:direct:7463849194";

const cfg = {
  agents: {
    defaults: {
      model: "openai/gpt-5.4",
      workspace: "/tmp/openclaw",
    },
  },
  session: {
    dmScope: "per-channel-peer",
  },
} satisfies Partial<OpenClawConfig> as OpenClawConfig;

function createTelegramDirectContext(): MsgContext {
  return {
    Provider: "telegram",
    Surface: "telegram",
    OriginatingChannel: "telegram",
    OriginatingTo: "telegram:7463849194",
    AccountId: "default",
    ChatType: "direct",
    ConversationLabel: "Alice id:7463849194",
    From: "telegram:7463849194",
    To: "telegram:7463849194",
    SenderId: "7463849194",
    SenderName: "Alice",
    SessionKey: TELEGRAM_DIRECT_KEY,
  };
}

describe("Telegram direct session recreation after delete", () => {
  const suiteRootTracker = createSuiteTempRootTracker({
    prefix: "openclaw-telegram-session-recreate-",
  });
  let tempDir = "";

  beforeAll(async () => {
    await suiteRootTracker.setup();
  });

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    await suiteRootTracker.cleanup();
  });

  it("surfaces a deleted Telegram direct session again after the next inbound message", async () => {
    tempDir = await suiteRootTracker.make("direct");
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDir);
    upsertSessionEntry({
      agentId: "main",
      sessionKey: TELEGRAM_DIRECT_KEY,
      entry: {
        sessionId: "old-session",
        updatedAt: 1_700_000_000_000,
        chatType: "direct",
        channel: "telegram",
      },
    });

    deleteSessionEntry({ agentId: "main", sessionKey: TELEGRAM_DIRECT_KEY });
    expect(getSessionEntry({ agentId: "main", sessionKey: TELEGRAM_DIRECT_KEY })).toBeUndefined();

    const ctx = createTelegramDirectContext();
    await recordSessionMetaFromInbound({
      agentId: "main",
      sessionKey: TELEGRAM_DIRECT_KEY,
      ctx,
    });
    await updateLastRoute({
      agentId: "main",
      sessionKey: TELEGRAM_DIRECT_KEY,
      channel: "telegram",
      to: "telegram:7463849194",
      accountId: "default",
      ctx,
    });

    const store = Object.fromEntries(
      listSessionEntries({ agentId: "main" }).map(({ sessionKey, entry }) => [sessionKey, entry]),
    );
    const listed = listSessionsFromStore({
      cfg,
      store,
      opts: {},
    });

    expect(store[TELEGRAM_DIRECT_KEY]).toEqual(
      expect.objectContaining({
        lastChannel: "telegram",
        lastTo: "telegram:7463849194",
        origin: expect.objectContaining({
          chatType: "direct",
          provider: "telegram",
        }),
      }),
    );
    expect(listed.sessions.map((session) => session.key)).toContain(TELEGRAM_DIRECT_KEY);
  });
});
