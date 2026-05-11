import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { upsertSessionEntry } from "../config/sessions/store.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import {
  buildAgentHookContextChannelFields,
  resolveAgentHookChannelId,
} from "./hook-agent-context.js";

const ORIGINAL_STATE_DIR = process.env.OPENCLAW_STATE_DIR;

function useTempStateDir(): NodeJS.ProcessEnv {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-hook-context-"));
  process.env.OPENCLAW_STATE_DIR = stateDir;
  return { OPENCLAW_STATE_DIR: stateDir };
}

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  if (ORIGINAL_STATE_DIR === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = ORIGINAL_STATE_DIR;
  }
});

describe("resolveAgentHookChannelId", () => {
  it("prefers typed SQLite conversation identity over session-key shape", () => {
    const env = useTempStateDir();
    upsertSessionEntry({
      agentId: "main",
      env,
      sessionKey: "agent:main:discord:channel:stale",
      entry: {
        sessionId: "session-1",
        updatedAt: Date.now(),
        deliveryContext: {
          channel: "discord",
          to: "channel:typed",
          accountId: "default",
        },
        chatType: "channel",
      },
    });

    expect(
      resolveAgentHookChannelId({
        sessionKey: "agent:main:discord:channel:stale",
        messageChannel: "discord",
        messageProvider: "discord",
        currentChannelId: "channel:metadata",
      }),
    ).toBe("typed");
  });

  it("uses target metadata instead of deriving conversation id from session keys", () => {
    expect(
      resolveAgentHookChannelId({
        sessionKey: "agent:main:discord:channel:1472750640760623226",
        messageChannel: "discord",
        messageProvider: "discord",
        currentChannelId: "channel:1472750640760623226",
      }),
    ).toBe("1472750640760623226");
  });

  it("uses target metadata when the session key is not a channel conversation", () => {
    expect(
      resolveAgentHookChannelId({
        sessionKey: "agent:main:main",
        messageProvider: "telegram",
        currentChannelId: "telegram:-1003841603622",
      }),
    ).toBe("-1003841603622");
  });

  it("uses prefixed message targets before falling back to the provider", () => {
    expect(
      resolveAgentHookChannelId({
        messageChannel: "channel:1472750640760623226",
        messageProvider: "discord",
      }),
    ).toBe("1472750640760623226");
  });

  it("falls back to legacy channel/provider values when no conversation id is available", () => {
    expect(
      resolveAgentHookChannelId({
        messageChannel: "discord",
        messageProvider: "discord",
      }),
    ).toBe("discord");
  });
});

describe("buildAgentHookContextChannelFields", () => {
  it("keeps provider and conversation id separate", () => {
    const env = useTempStateDir();
    upsertSessionEntry({
      agentId: "main",
      env,
      sessionKey: "agent:main:discord:channel:c1",
      entry: {
        sessionId: "session-2",
        updatedAt: Date.now(),
        deliveryContext: {
          channel: "discord",
          to: "channel:c1",
          accountId: "default",
        },
        chatType: "channel",
      },
    });

    expect(
      buildAgentHookContextChannelFields({
        sessionKey: "agent:main:discord:channel:c1",
        messageChannel: "discord",
        messageProvider: "discord",
      }),
    ).toEqual({
      messageProvider: "discord",
      channelId: "c1",
    });
  });
});
