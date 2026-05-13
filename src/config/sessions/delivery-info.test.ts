import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { extractDeliveryInfo } from "./delivery-info.js";
import { upsertSessionEntry } from "./store.js";
import type { SessionEntry } from "./types.js";

type DeliveryInfoTestDatabase = Pick<OpenClawAgentKyselyDatabase, "session_entries">;

const ORIGINAL_STATE_DIR = process.env.OPENCLAW_STATE_DIR;

function setStateDir(): NodeJS.ProcessEnv {
  const stateDir = `${process.env.TMPDIR ?? "/tmp"}/openclaw-delivery-info-${randomUUID()}`;
  process.env.OPENCLAW_STATE_DIR = stateDir;
  return {
    ...process.env,
    OPENCLAW_STATE_DIR: stateDir,
  };
}

function buildEntry(deliveryContext: SessionEntry["deliveryContext"]): SessionEntry {
  return {
    sessionId: "session-1",
    updatedAt: Date.now(),
    deliveryContext,
  };
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

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  if (ORIGINAL_STATE_DIR === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = ORIGINAL_STATE_DIR;
  }
});

describe("extractDeliveryInfo", () => {
  it("returns delivery context from the per-agent SQLite session row", () => {
    const env = setStateDir();
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

  it("uses typed conversation rows when compatibility JSON lacks routing fields", () => {
    const env = setStateDir();
    const sessionKey = "agent:main:webchat:dm:user-123";
    upsertSessionEntry({
      agentId: "main",
      env,
      sessionKey,
      entry: buildEntry({
        channel: "webchat",
        to: "webchat:user-123",
        accountId: "default",
        threadId: "66",
      }),
    });
    corruptStoredEntryJson({ agentId: "main", env, sessionKey });

    expect(extractDeliveryInfo(sessionKey)).toEqual({
      deliveryContext: {
        channel: "webchat",
        to: "webchat:user-123",
        accountId: "default",
        threadId: "66",
      },
      threadId: "66",
    });
  });

  it("returns empty delivery info when the session row is missing", () => {
    setStateDir();

    expect(extractDeliveryInfo("agent:main:webchat:dm:missing")).toEqual({
      deliveryContext: undefined,
      threadId: undefined,
    });
  });
});
