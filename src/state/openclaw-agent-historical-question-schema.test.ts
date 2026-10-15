import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { AGENT_V14_BOARD_SCHEMA_SQL } from "./openclaw-agent-board-schema.js";
import { getOpenClawAgentMigrationSchema } from "./openclaw-agent-db-schema-helpers.js";
import { AGENT_PROGRESS_CARD_SCHEMA_SQL } from "./openclaw-agent-progress-card-schema.js";
import {
  AGENT_V14_ADDITIVE_SCHEMA_SQL,
  AGENT_V14_CORE_SCHEMA_SQL,
  AGENT_V14_SESSION_SHARING_SCHEMA_SQL,
} from "./openclaw-agent-session-sharing-schema.js";

describe("historical agent question schema boundaries", () => {
  it.each([
    AGENT_V14_CORE_SCHEMA_SQL,
    AGENT_V14_SESSION_SHARING_SCHEMA_SQL,
    AGENT_V14_ADDITIVE_SCHEMA_SQL,
    AGENT_V14_BOARD_SCHEMA_SQL,
    AGENT_PROGRESS_CARD_SCHEMA_SQL,
  ])("does not admit durable custody through a historical schema group", (schema) => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(schema);
      expect(
        db.prepare("SELECT name FROM sqlite_schema WHERE name = 'session_questions'").get(),
      ).toBeUndefined();
    } finally {
      db.close();
    }
  });
  it.each([24, 25, 26, 27, 28])(
    "retains the distinct FIFO and question contracts at schema %s",
    (version) => {
      using db = new DatabaseSync(":memory:");
      db.exec(getOpenClawAgentMigrationSchema(version));
      const question = db
        .prepare("SELECT name FROM sqlite_schema WHERE name = 'session_questions'")
        .get();
      expect(Boolean(question)).toBe(version >= 28);
      const columns = db.prepare("PRAGMA table_info(context_engine_turn_outbox)").all();
      expect(columns.some((column) => column.name === "enqueue_sequence")).toBe(version >= 27);
    },
  );
});
