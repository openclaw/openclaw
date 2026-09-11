import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  AGENT_RUN_TERMINAL_RECEIPT_MAX_JSON_BYTES,
  AGENT_RUN_TERMINAL_RECEIPT_MAX_ROWS,
  AGENT_RUN_TERMINAL_RECEIPT_TTL_MS,
  deleteAgentRunTerminalReceipt,
  readAgentRunTerminalReceipt,
  writeAgentRunTerminalReceipt,
} from "./agent-run-terminal-receipts.js";
import { ensureAgentRunTerminalReceiptSchema } from "./openclaw-state-db-schema-additive.js";
import {
  closeOpenClawStateDatabaseForTest,
  runOpenClawStateWriteTransaction,
} from "./openclaw-state-db.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    cleanup();
  });
});

function testEnv(): NodeJS.ProcessEnv {
  const root = tempDirs.make("openclaw-agent-run-terminal-");
  const env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") };
  runOpenClawStateWriteTransaction(() => undefined, { env });
  return env;
}

const owner = { agentId: "agent-a", sessionKey: "agent:a:main", sessionId: "session-a" };
const terminalJson = JSON.stringify({ status: "ok", startedAt: 10, endedAt: 20 });

describe("durable agent run terminal receipts", () => {
  it("keeps the first terminal write authoritative and enforces ownership on reads", () => {
    const env = testEnv();
    expect(
      writeAgentRunTerminalReceipt({ runId: "run-1", owner, terminalJson, now: 100, env }),
    ).toBe(true);
    expect(
      writeAgentRunTerminalReceipt({
        runId: "run-1",
        owner,
        terminalJson: JSON.stringify({ status: "error", endedAt: 30 }),
        now: 101,
        env,
      }),
    ).toBe(false);

    expect(readAgentRunTerminalReceipt({ runId: "run-1", owner, now: 102, env })).toMatchObject({
      runId: "run-1",
      owner,
      terminalJson,
    });
    expect(
      readAgentRunTerminalReceipt({
        runId: "run-1",
        owner: { ...owner, agentId: "agent-b" },
        now: 102,
        env,
      }),
    ).toBeUndefined();
  });

  it("uses seven-day retention and prunes expired rows on read", () => {
    const env = testEnv();
    writeAgentRunTerminalReceipt({ runId: "run-expired", owner, terminalJson, now: 100, env });
    expect(
      readAgentRunTerminalReceipt({
        runId: "run-expired",
        owner,
        now: 100 + AGENT_RUN_TERMINAL_RECEIPT_TTL_MS - 1,
        env,
      }),
    ).toBeDefined();
    expect(
      readAgentRunTerminalReceipt({
        runId: "run-expired",
        owner,
        now: 100 + AGENT_RUN_TERMINAL_RECEIPT_TTL_MS,
        env,
      }),
    ).toBeUndefined();
    expect(deleteAgentRunTerminalReceipt({ runId: "run-expired", env })).toBe(false);
  });

  it("caps terminal JSON by UTF-8 bytes", () => {
    const env = testEnv();
    const oversized = JSON.stringify({ status: "error", error: "😀".repeat(20_000) });
    expect(Buffer.byteLength(oversized, "utf8")).toBeGreaterThan(
      AGENT_RUN_TERMINAL_RECEIPT_MAX_JSON_BYTES,
    );
    expect(() =>
      writeAgentRunTerminalReceipt({ runId: "run-oversized", owner, terminalJson: oversized, env }),
    ).toThrow(/65536 UTF-8 bytes/u);
  });

  it("prunes corrupt JSON as a cache miss", () => {
    const env = testEnv();
    runOpenClawStateWriteTransaction(
      (database) => {
        ensureAgentRunTerminalReceiptSchema(database.db);
        database.db
          .prepare(
            `INSERT INTO agent_run_terminal_receipts
             (run_id, agent_id, session_key, session_id, terminal_json, created_at_ms, expires_at_ms)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run("run-corrupt", owner.agentId, owner.sessionKey, owner.sessionId, "{bad", 100, 1_000);
      },
      { env },
    );

    expect(readAgentRunTerminalReceipt({ runId: "run-corrupt", now: 200, env })).toBeUndefined();
    expect(deleteAgentRunTerminalReceipt({ runId: "run-corrupt", env })).toBe(false);
  });

  it("prunes overflow to the 5,000 newest receipts", () => {
    const env = testEnv();
    runOpenClawStateWriteTransaction(
      (database) => {
        ensureAgentRunTerminalReceiptSchema(database.db);
        const insert = database.db.prepare(
          `INSERT INTO agent_run_terminal_receipts
           (run_id, agent_id, session_key, session_id, terminal_json, created_at_ms, expires_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        );
        for (let index = 0; index < AGENT_RUN_TERMINAL_RECEIPT_MAX_ROWS; index += 1) {
          insert.run(
            `run-${index}`,
            owner.agentId,
            owner.sessionKey,
            owner.sessionId,
            terminalJson,
            index + 1,
            1_000_000,
          );
        }
      },
      { env },
    );
    writeAgentRunTerminalReceipt({
      runId: "run-newest",
      owner,
      terminalJson,
      now: AGENT_RUN_TERMINAL_RECEIPT_MAX_ROWS + 1,
      ttlMs: 1_000_000,
      env,
    });

    expect(readAgentRunTerminalReceipt({ runId: "run-0", now: 6_000, env })).toBeUndefined();
    expect(readAgentRunTerminalReceipt({ runId: "run-newest", now: 6_000, env })).toBeDefined();
  });
});
