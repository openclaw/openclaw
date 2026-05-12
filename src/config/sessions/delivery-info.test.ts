import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { createSessionConversationTestRegistry } from "../../test-utils/session-conversation-registry.js";
import { extractDeliveryInfo, parseSessionThreadInfo } from "./delivery-info.js";
import { upsertSessionEntry } from "./store.js";
import type { SessionEntry } from "./types.js";

const ORIGINAL_STATE_DIR = process.env.OPENCLAW_STATE_DIR;

type DeliveryInfoTestDatabase = Pick<
  OpenClawAgentKyselyDatabase,
  "conversations" | "session_conversations" | "session_entries" | "sessions"
>;

const buildEntry = (deliveryContext: SessionEntry["deliveryContext"]): SessionEntry => ({
  sessionId: "session-1",
  updatedAt: Date.now(),
  deliveryContext,
});

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-delivery-info-"));
}

function useTempStateDir(): { env: NodeJS.ProcessEnv; stateDir: string } {
  const stateDir = createTempDir();
  process.env.OPENCLAW_STATE_DIR = stateDir;
  return { env: { OPENCLAW_STATE_DIR: stateDir }, stateDir };
}

function corruptStoredEntryJson(params: {
  agentId: string;
  env: NodeJS.ProcessEnv;
  sessionKey: string;
}): void {
  const database = openOpenClawAgentDatabase({ agentId: params.agentId, env: params.env });
  const db = getNodeSqliteKysely<DeliveryInfoTestDatabase>(database.db);
  executeSqliteQuerySync(
    database.db,
    db
      .updateTable("session_entries")
      .set({
        entry_json: JSON.stringify({
          sessionId: "session-1",
          updatedAt: Date.now(),
        }),
      })
      .where("session_key", "=", params.sessionKey),
  );
}

function removeTypedConversationRows(params: {
  agentId: string;
  env: NodeJS.ProcessEnv;
  sessionId: string;
}): void {
  const database = openOpenClawAgentDatabase({ agentId: params.agentId, env: params.env });
  const db = getNodeSqliteKysely<DeliveryInfoTestDatabase>(database.db);
  executeSqliteQuerySync(
    database.db,
    db
      .updateTable("sessions")
      .set({ primary_conversation_id: null })
      .where("session_id", "=", params.sessionId),
  );
  executeSqliteQuerySync(
    database.db,
    db.deleteFrom("session_conversations").where("session_id", "=", params.sessionId),
  );
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

beforeEach(() => {
  setActivePluginRegistry(createSessionConversationTestRegistry());
});

describe("extractDeliveryInfo", () => {
  it("parses base session and thread/topic ids", () => {
    expect(parseSessionThreadInfo("agent:main:telegram:group:1:topic:55")).toEqual({
      baseSessionKey: "agent:main:telegram:group:1",
      threadId: "55",
    });
    expect(parseSessionThreadInfo("agent:main:slack:channel:C1:thread:123.456")).toEqual({
      baseSessionKey: "agent:main:slack:channel:C1",
      threadId: "123.456",
    });
    expect(
      parseSessionThreadInfo(
        "agent:main:matrix:channel:!room:example.org:thread:$AbC123:example.org",
      ),
    ).toEqual({
      baseSessionKey: "agent:main:matrix:channel:!room:example.org",
      threadId: "$AbC123:example.org",
    });
    expect(
      parseSessionThreadInfo(
        "agent:main:feishu:group:oc_group_chat:topic:om_topic_root:sender:ou_topic_user",
      ),
    ).toEqual({
      baseSessionKey:
        "agent:main:feishu:group:oc_group_chat:topic:om_topic_root:sender:ou_topic_user",
      threadId: undefined,
    });
    expect(parseSessionThreadInfo(undefined)).toEqual({
      baseSessionKey: undefined,
      threadId: undefined,
    });
  });

  it("returns typed delivery context for direct session keys", () => {
    const { env } = useTempStateDir();
    const sessionKey = "agent:main:webchat:dm:user-123";
    upsertSessionEntry({
      agentId: "main",
      env,
      sessionKey,
      entry: buildEntry({
        channel: "webchat",
        to: "webchat:user-123",
        accountId: "default",
      }),
    });

    expect(extractDeliveryInfo(sessionKey)).toEqual({
      deliveryContext: {
        channel: "webchat",
        to: "webchat:user-123",
        accountId: "default",
      },
      threadId: undefined,
    });
  });

  it("uses typed conversation rows before compatibility entry_json", () => {
    const { env } = useTempStateDir();
    const sessionKey = "agent:main:webchat:dm:user-123";
    upsertSessionEntry({
      agentId: "main",
      env,
      sessionKey,
      entry: buildEntry({
        channel: "webchat",
        to: "webchat:user-123",
        accountId: "default",
      }),
    });
    corruptStoredEntryJson({ agentId: "main", env, sessionKey });

    expect(extractDeliveryInfo(sessionKey)).toEqual({
      deliveryContext: {
        channel: "webchat",
        to: "webchat:user-123",
        accountId: "default",
      },
      threadId: undefined,
    });
  });

  it("does not reconstruct delivery context from compatibility entry_json", () => {
    const { env } = useTempStateDir();
    const sessionKey = "agent:main:webchat:dm:user-123";
    upsertSessionEntry({
      agentId: "main",
      env,
      sessionKey,
      entry: buildEntry({
        channel: "webchat",
        to: "webchat:user-123",
        accountId: "default",
      }),
    });
    corruptStoredEntryJson({ agentId: "main", env, sessionKey });
    removeTypedConversationRows({ agentId: "main", env, sessionId: "session-1" });

    expect(extractDeliveryInfo(sessionKey)).toEqual({
      deliveryContext: undefined,
      threadId: undefined,
    });
  });

  it("falls back to base sessions for thread keys", () => {
    const { env } = useTempStateDir();
    const baseKey = "agent:main:slack:channel:C0123ABC";
    const threadKey = `${baseKey}:thread:1234567890.123456`;
    upsertSessionEntry({
      agentId: "main",
      env,
      sessionKey: baseKey,
      entry: buildEntry({
        channel: "slack",
        to: "slack:C0123ABC",
        accountId: "workspace-1",
      }),
    });

    expect(extractDeliveryInfo(threadKey)).toEqual({
      deliveryContext: {
        channel: "slack",
        to: "slack:C0123ABC",
        accountId: "workspace-1",
      },
      threadId: "1234567890.123456",
    });
  });

  it("falls back to base sessions for topic keys", () => {
    const { env } = useTempStateDir();
    const baseKey = "agent:main:telegram:group:98765";
    const topicKey = `${baseKey}:topic:55`;
    upsertSessionEntry({
      agentId: "main",
      env,
      sessionKey: baseKey,
      entry: {
        ...buildEntry({
          channel: "telegram",
          to: "group:98765",
          accountId: "main",
        }),
        lastThreadId: "55",
      },
    });

    expect(extractDeliveryInfo(topicKey)).toEqual({
      deliveryContext: {
        channel: "telegram",
        to: "group:98765",
        accountId: "main",
        threadId: "55",
      },
      threadId: "55",
    });
  });

  it("prefers typed SQLite thread ids over thread ids parsed from session keys", () => {
    const { env } = useTempStateDir();
    const baseKey = "agent:main:telegram:group:98765";
    const topicKey = `${baseKey}:topic:55`;
    upsertSessionEntry({
      agentId: "main",
      env,
      sessionKey: topicKey,
      entry: {
        ...buildEntry({
          channel: "telegram",
          to: "group:98765",
          accountId: "main",
          threadId: "66",
        }),
        lastThreadId: "66",
      },
    });

    expect(extractDeliveryInfo(topicKey)).toEqual({
      deliveryContext: {
        channel: "telegram",
        to: "group:98765",
        accountId: "main",
        threadId: "66",
      },
      threadId: "66",
    });
  });

  it("falls back to typed lastThreadId when deliveryContext.threadId is missing", () => {
    const { env } = useTempStateDir();
    const sessionKey = "agent:main:telegram:group:98765";
    upsertSessionEntry({
      agentId: "main",
      env,
      sessionKey,
      entry: {
        ...buildEntry({
          channel: "telegram",
          to: "group:98765",
          accountId: "main",
        }),
        lastThreadId: 77,
      },
    });

    expect(extractDeliveryInfo(sessionKey)).toEqual({
      deliveryContext: {
        channel: "telegram",
        to: "group:98765",
        accountId: "main",
        threadId: 77,
      },
      threadId: "77",
    });
  });

  it("derives delivery info from typed rows created from last route metadata", () => {
    const { env } = useTempStateDir();
    const sessionKey = "agent:main:matrix:channel:!lowercased:example.org";
    upsertSessionEntry({
      agentId: "main",
      env,
      sessionKey,
      entry: {
        sessionId: "session-1",
        updatedAt: Date.now(),
        lastChannel: "matrix",
        lastTo: "room:!MixedCase:example.org",
      },
    });

    expect(extractDeliveryInfo(sessionKey)).toEqual({
      deliveryContext: {
        channel: "matrix",
        to: "room:!MixedCase:example.org",
        accountId: "default",
      },
      threadId: undefined,
    });
  });

  it("falls back to the base session when a thread entry only has partial route metadata", () => {
    const { env } = useTempStateDir();
    const baseKey = "agent:main:matrix:channel:!MixedCase:example.org";
    const threadKey = `${baseKey}:thread:$thread-event`;
    upsertSessionEntry({
      agentId: "main",
      env,
      sessionKey: threadKey,
      entry: {
        sessionId: "thread-session",
        updatedAt: Date.now(),
      },
    });
    upsertSessionEntry({
      agentId: "main",
      env,
      sessionKey: baseKey,
      entry: {
        sessionId: "base-session",
        updatedAt: Date.now(),
        lastChannel: "matrix",
        lastTo: "room:!MixedCase:example.org",
      },
    });

    expect(extractDeliveryInfo(threadKey)).toEqual({
      deliveryContext: {
        channel: "matrix",
        to: "room:!MixedCase:example.org",
        accountId: "default",
      },
      threadId: "$thread-event",
    });
  });
});
