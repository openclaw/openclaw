import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CONFIG_AUDIT_MAX_ENTRIES,
  CONFIG_AUDIT_SCOPE,
  listConfigAuditRecordsForTests,
} from "../config/io.audit.js";
import { resetPluginStateStoreForTests } from "../plugin-state/plugin-state-store.js";
import { listSystemAgentAuditEntriesForTests } from "../system-agent/audit.js";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { acquireGatewayLock } from "./gateway-lock.js";
import { createSqliteAuditRecordStore } from "./sqlite-audit-record-store.js";
import { detectLegacyAuditLogs, migrateLegacyAuditLogs } from "./state-migrations.audit-logs.js";

describe("legacy core audit log migration", () => {
  afterEach(() => {
    resetPluginStateStoreForTests();
  });

  it("imports config and system audit JSONL only through explicit doctor repair", async () => {
    await withTempDir({ prefix: "openclaw-audit-migration-" }, async (stateDir) => {
      const configPath = path.join(stateDir, "logs", "config-audit.jsonl");
      const systemPath = path.join(stateDir, "audit", "system-agent.jsonl");
      const crestodianPath = path.join(stateDir, "audit", "crestodian.jsonl");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.mkdir(path.dirname(systemPath), { recursive: true });
      const unredactedConfigRecord = {
        ts: "2026-07-01T00:00:00.000Z",
        source: "config-io",
        event: "config.write",
        argv: ["openclaw", "config", "set", "token", "secret-value"],
        execArgv: [],
      };
      const unredactedDigest = createHash("sha256")
        .update(JSON.stringify(unredactedConfigRecord))
        .digest("hex")
        .slice(0, 16);
      await fs.writeFile(configPath, `${JSON.stringify(unredactedConfigRecord)}\n`);
      await fs.writeFile(
        systemPath,
        `${JSON.stringify({
          timestamp: "2026-07-02T00:00:00.000Z",
          operation: "config.set",
          summary: "Set config",
        })}\n`,
      );
      await fs.writeFile(
        crestodianPath,
        `${JSON.stringify({
          timestamp: "2026-07-03T00:00:00.000Z",
          operation: "gateway.restart",
          summary: "Restarted gateway",
        })}\n`,
      );

      expect(detectLegacyAuditLogs({ stateDir }).hasLegacy).toBe(false);
      const detected = detectLegacyAuditLogs({
        stateDir,
        doctorOnlyStateMigrations: true,
      });
      expect(detected.sources).toHaveLength(3);

      const result = await migrateLegacyAuditLogs({ detected, stateDir });
      expect(result.warnings).toEqual([]);
      expect(result.changes).toHaveLength(6);

      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const configRecords = listConfigAuditRecordsForTests({ env, homedir: () => stateDir });
      expect(configRecords).toHaveLength(1);
      expect(JSON.stringify(configRecords)).not.toContain("secret-value");
      const configEntries = createSqliteAuditRecordStore({
        scope: CONFIG_AUDIT_SCOPE,
        maxEntries: CONFIG_AUDIT_MAX_ENTRIES,
        env,
      }).entries();
      expect(configEntries[0]?.key).not.toContain(unredactedDigest);
      const archivedConfig = await fs.readFile(`${configPath}.migrated`, "utf8");
      expect(archivedConfig).not.toContain("secret-value");
      expect(JSON.parse(archivedConfig.trim())).toMatchObject({
        argv: ["openclaw", "config", "set", "token", "***"],
      });
      expect(
        listSystemAgentAuditEntriesForTests({ env })
          .map((entry) => entry.value.operation)
          .toSorted(),
      ).toEqual(["config.set", "gateway.restart"]);
      await expect(fs.access(configPath)).rejects.toThrow();
      await expect(fs.access(systemPath)).rejects.toThrow();
      await expect(fs.access(crestodianPath)).rejects.toThrow();
    });
  });

  it("leaves malformed audit sources in place without partial imports", async () => {
    await withTempDir({ prefix: "openclaw-audit-migration-invalid-" }, async (stateDir) => {
      const sourcePath = path.join(stateDir, "audit", "system-agent.jsonl");
      await fs.mkdir(path.dirname(sourcePath), { recursive: true });
      await fs.writeFile(sourcePath, "{bad json\n");
      const detected = detectLegacyAuditLogs({
        stateDir,
        doctorOnlyStateMigrations: true,
      });

      const result = await migrateLegacyAuditLogs({ detected, stateDir });
      expect(result.warnings.join("\n")).toContain("Failed reading system-agent audit log");
      await expect(fs.access(sourcePath)).resolves.toBeUndefined();
      expect(
        listSystemAgentAuditEntriesForTests({
          env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
        }),
      ).toEqual([]);
    });
  });

  it("requires exclusive state ownership before claiming legacy audit files", async () => {
    await withTempDir({ prefix: "openclaw-audit-migration-lock-" }, async (stateDir) => {
      const sourcePath = path.join(stateDir, "audit", "system-agent.jsonl");
      await fs.mkdir(path.dirname(sourcePath), { recursive: true });
      await fs.writeFile(
        sourcePath,
        `${JSON.stringify({
          timestamp: "2026-07-03T00:00:00.000Z",
          operation: "gateway.restart",
          summary: "Restarted gateway",
        })}\n`,
      );
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const gatewayLock = await acquireGatewayLock({
        allowInTests: true,
        env,
        pollIntervalMs: 10,
        port: 18_791,
        timeoutMs: 100,
      });
      if (!gatewayLock) {
        throw new Error("expected test Gateway lock");
      }

      let result: Awaited<ReturnType<typeof migrateLegacyAuditLogs>>;
      try {
        result = await migrateLegacyAuditLogs({
          detected: detectLegacyAuditLogs({ stateDir, doctorOnlyStateMigrations: true }),
          stateDir,
        });
      } finally {
        await gatewayLock.release();
      }

      expect(result.warnings.join("\n")).toContain("exclusive state ownership is unavailable");
      await expect(fs.access(sourcePath)).resolves.toBeUndefined();
      expect(listSystemAgentAuditEntriesForTests({ env })).toEqual([]);
    });
  });
});
