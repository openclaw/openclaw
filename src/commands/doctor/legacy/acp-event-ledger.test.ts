import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createSqliteAcpEventLedger } from "../../../acp/event-ledger.js";
import { closeOpenClawStateDatabaseForTest } from "../../../state/openclaw-state-db.js";
import { withTempDir } from "../../../test-helpers/temp-dir.js";
import {
  importLegacyAcpEventLedgerFileToSqlite,
  legacyAcpEventLedgerFileExists,
  resolveLegacyAcpEventLedgerPath,
} from "./acp-event-ledger.js";

async function writeLegacyAcpEventLedgerFile(filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(
    filePath,
    JSON.stringify({
      version: 1,
      sessions: {
        "session-1": {
          sessionId: "session-1",
          sessionKey: "agent:main:work",
          cwd: "/work",
          complete: true,
          createdAt: 1000,
          updatedAt: 1000,
          nextSeq: 2,
          events: [
            {
              seq: 1,
              at: 1000,
              sessionId: "session-1",
              sessionKey: "agent:main:work",
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: "Imported" },
              },
            },
          ],
        },
      },
    }),
    "utf8",
  );
}

describe("legacy ACP event ledger migration", () => {
  it("imports legacy file-backed ledger state into SQLite", async () => {
    await withTempDir({ prefix: "openclaw-acp-ledger-" }, async (dir) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: dir };
      const filePath = resolveLegacyAcpEventLedgerPath(env);
      await writeLegacyAcpEventLedgerFile(filePath);

      expect(legacyAcpEventLedgerFileExists(env)).toBe(true);
      await expect(importLegacyAcpEventLedgerFileToSqlite(env)).resolves.toEqual({
        imported: true,
        sessions: 1,
        events: 1,
      });

      const ledger = createSqliteAcpEventLedger({ env });
      await expect(
        ledger.readReplay({ sessionId: "session-1", sessionKey: "agent:main:work" }),
      ).resolves.toMatchObject({
        complete: true,
        events: [
          {
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "Imported" },
            },
          },
        ],
      });
      await expect(fs.stat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(legacyAcpEventLedgerFileExists(env)).toBe(false);
    });
    closeOpenClawStateDatabaseForTest();
  });

  it("skips when no legacy ledger file exists", async () => {
    await withTempDir({ prefix: "openclaw-acp-ledger-" }, async (dir) => {
      const env = { ...process.env, OPENCLAW_STATE_DIR: dir };

      expect(legacyAcpEventLedgerFileExists(env)).toBe(false);
      await expect(importLegacyAcpEventLedgerFileToSqlite(env)).resolves.toEqual({
        imported: false,
        sessions: 0,
        events: 0,
      });
    });
    closeOpenClawStateDatabaseForTest();
  });
});
