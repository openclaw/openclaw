import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resetPluginStateStoreForTests } from "../plugin-state/plugin-state-store.js";
import { listSystemAgentAuditEntriesForTests } from "../system-agent/audit.test-support.js";
import { withTempDir } from "../test-helpers/temp-dir.js";
import { openLegacyAuditRawCheckpointStore } from "./state-migrations.audit-checkpoints.js";
import { detectLegacyAuditLogs, migrateLegacyAuditLogs } from "./state-migrations.audit-logs.js";

const TEST_AUDIT_SCRUB_PATTERN = Buffer.from(
  Array.from({ length: 32 }, (_, index) => (index % 2 === 0 ? 0x20 : 0x09)),
);

function buildTestAuditScrubbedContent(length: number): Buffer {
  const content = Buffer.allocUnsafe(length);
  for (let offset = 0; offset < length; offset += TEST_AUDIT_SCRUB_PATTERN.length) {
    TEST_AUDIT_SCRUB_PATTERN.copy(
      content,
      offset,
      0,
      Math.min(TEST_AUDIT_SCRUB_PATTERN.length, length - offset),
    );
  }
  return content;
}

async function buildTestAuditRestoreJournal(
  rawPath: string,
  sourceRaw: Buffer,
  progress: { restoredBytes: number; scrubbedBytes: number } = {
    restoredBytes: 0,
    scrubbedBytes: 0,
  },
): Promise<string> {
  const stat = await fs.stat(rawPath);
  const journal = `${JSON.stringify({
    schemaVersion: 6,
    rawBase64: sourceRaw.toString("base64"),
    scrubPatternBase64: TEST_AUDIT_SCRUB_PATTERN.toString("base64"),
    target: { dev: stat.dev, ino: stat.ino, size: sourceRaw.length },
  })}\n`;
  await fs.writeFile(
    `${rawPath}.doctor-scrub-progress`,
    `${JSON.stringify({
      schemaVersion: 1,
      journalHash: createHash("sha256").update(journal).digest("hex"),
      direction: progress.restoredBytes > 0 ? "restoring" : "scrubbing",
      committedBytes: progress.restoredBytes > 0 ? progress.restoredBytes : progress.scrubbedBytes,
      pendingEnd: progress.restoredBytes > 0 ? progress.restoredBytes : progress.scrubbedBytes,
      extentBytes: progress.restoredBytes > 0 ? progress.scrubbedBytes : sourceRaw.length,
    })}\n`,
  );
  return journal;
}

describe("legacy audit recovery byte handling", () => {
  afterEach(() => {
    resetPluginStateStoreForTests();
  });

  it("blanks a zero-slack source within the fixed-size recovery inode", async () => {
    await withTempDir({ prefix: "openclaw-audit-migration-short-secret-" }, async (stateDir) => {
      const sourcePath = path.join(stateDir, "logs", "config-audit.jsonl");
      const record = {
        ts: "2026-07-01T00:00:00.000Z",
        source: "config-io",
        event: "config.write",
        argv: ["openclaw", "config", "set", "token", "x"],
        execArgv: [],
      };
      const original = `${JSON.stringify(record)}\n`;
      await fs.mkdir(path.dirname(sourcePath), { recursive: true });
      await fs.writeFile(sourcePath, original);

      const result = await migrateLegacyAuditLogs({
        detected: detectLegacyAuditLogs({ stateDir, doctorOnlyStateMigrations: true }),
        stateDir,
      });

      expect(result.warnings).toEqual([]);
      const sanitized = await fs.readFile(`${sourcePath}.migrated`, "utf8");
      const recovery = await fs.readFile(`${sourcePath}.migrated.raw`, "utf8");
      expect(Buffer.byteLength(recovery)).toBe(Buffer.byteLength(original));
      expect(JSON.parse(sanitized.trim())).toMatchObject({
        argv: ["openclaw", "config", "set", "token", "***"],
      });
      expect(recovery.trim()).toBe("");
      await expect(
        fs.access(`${sourcePath}.migrated.raw.doctor-scrub-restore`),
      ).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("uses original byte offsets when decoded audit text contains replacement characters", async () => {
    await withTempDir({ prefix: "openclaw-audit-migration-invalid-utf8-" }, async (stateDir) => {
      const sourcePath = path.join(stateDir, "audit", "system-agent.jsonl");
      const rawPath = `${sourcePath}.migrated.raw`;
      const original = Buffer.concat([
        Buffer.from(
          '{"timestamp":"2026-07-03T00:00:00.000Z","operation":"gateway.restart","summary":"',
        ),
        Buffer.from([0x80]),
        Buffer.from('"}'),
      ]);
      await fs.mkdir(path.dirname(sourcePath), { recursive: true });
      await fs.writeFile(sourcePath, original);

      const migrated = await migrateLegacyAuditLogs({
        detected: detectLegacyAuditLogs({ stateDir, doctorOnlyStateMigrations: true }),
        stateDir,
      });

      expect(migrated.warnings).toEqual([]);
      const blanked = await fs.readFile(rawPath);
      expect(blanked).toHaveLength(original.length);
      expect(blanked.every((byte) => byte === 0x20 || byte === 0x09)).toBe(true);

      await fs.appendFile(
        rawPath,
        `${JSON.stringify({
          timestamp: "2026-07-04T00:00:00.000Z",
          operation: "gateway.restart",
          summary: "later",
        })}\n`,
      );
      const recovered = await migrateLegacyAuditLogs({
        detected: detectLegacyAuditLogs({ stateDir, doctorOnlyStateMigrations: true }),
        stateDir,
      });

      expect(recovered.warnings).toEqual([]);
      expect(
        listSystemAgentAuditEntriesForTests({
          env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
        }).map((entry) => entry.value.summary),
      ).toEqual(["�", "later"]);
    });
  });

  it("upgrades a legacy nonzero raw checkpoint to the blank append pad", async () => {
    await withTempDir(
      { prefix: "openclaw-audit-migration-checkpoint-upgrade-" },
      async (stateDir) => {
        const sourcePath = path.join(stateDir, "audit", "system-agent.jsonl");
        await fs.mkdir(path.dirname(sourcePath), { recursive: true });
        await fs.writeFile(
          sourcePath,
          `${JSON.stringify({
            timestamp: "2026-07-03T00:00:00.000Z",
            operation: "gateway.restart",
            summary: "original",
          })}\n`,
        );
        await migrateLegacyAuditLogs({
          detected: detectLegacyAuditLogs({ stateDir, doctorOnlyStateMigrations: true }),
          stateDir,
        });
        const rawPath = `${sourcePath}.migrated.raw`;
        const legacyRaw = Buffer.concat([
          Buffer.from(
            '{"timestamp":"2026-07-03T00:00:00.000Z","operation":"gateway.restart","summary":"',
          ),
          Buffer.from([0x80]),
          Buffer.from('"}\n'),
        ]);
        await fs.writeFile(rawPath, legacyRaw);
        const legacyStat = await fs.stat(rawPath);
        const checkpointStore = openLegacyAuditRawCheckpointStore(stateDir);
        const checkpoint = checkpointStore.entries()[0]!;
        checkpointStore.upsert(checkpoint.key, {
          ...checkpoint.value,
          dev: legacyStat.dev,
          ino: legacyStat.ino,
          mtimeMs: legacyStat.mtimeMs,
          size: legacyStat.size,
          contentHash: createHash("sha256").update(legacyRaw.toString("utf8")).digest("hex"),
          recordCount: 1,
        });

        const detected = detectLegacyAuditLogs({ stateDir, doctorOnlyStateMigrations: true });
        expect(detected.hasLegacy).toBe(true);
        const result = await migrateLegacyAuditLogs({ detected, stateDir });

        expect(result.warnings).toEqual([]);
        expect(openLegacyAuditRawCheckpointStore(stateDir).entries()[0]?.value.recordCount).toBe(0);
      },
    );
  });

  it("does not confuse an older prefix checkpoint with a later scrub generation", async () => {
    await withTempDir(
      { prefix: "openclaw-audit-migration-scrub-generation-" },
      async (stateDir) => {
        const sourcePath = path.join(stateDir, "audit", "system-agent.jsonl");
        const rawPath = `${sourcePath}.migrated.raw`;
        const restorePath = `${rawPath}.doctor-scrub-restore`;
        await fs.mkdir(path.dirname(sourcePath), { recursive: true });
        await fs.writeFile(
          sourcePath,
          `${JSON.stringify({
            timestamp: "2026-07-03T00:00:00.000Z",
            operation: "gateway.restart",
            summary: "original",
          })}\n`,
        );
        await migrateLegacyAuditLogs({
          detected: detectLegacyAuditLogs({ stateDir, doctorOnlyStateMigrations: true }),
          stateDir,
        });
        await fs.appendFile(
          rawPath,
          `${JSON.stringify({
            timestamp: "2026-07-04T00:00:00.000Z",
            operation: "gateway.restart",
            summary: "later",
          })}\n`,
        );
        const interruptedRaw = await fs.readFile(rawPath);
        await fs.writeFile(
          restorePath,
          await buildTestAuditRestoreJournal(rawPath, interruptedRaw, {
            restoredBytes: 0,
            scrubbedBytes: interruptedRaw.length,
          }),
        );
        await fs.writeFile(rawPath, buildTestAuditScrubbedContent(interruptedRaw.length));

        const result = await migrateLegacyAuditLogs({
          detected: detectLegacyAuditLogs({ stateDir, doctorOnlyStateMigrations: true }),
          stateDir,
        });

        expect(result.warnings).toEqual([]);
        expect(
          listSystemAgentAuditEntriesForTests({
            env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
          }).map((entry) => entry.value.summary),
        ).toEqual(["original", "later"]);
        await expect(fs.access(restorePath)).rejects.toMatchObject({ code: "ENOENT" });
      },
    );
  });

  it("does not replay a scrub journal over an equal-width space redaction", async () => {
    await withTempDir({ prefix: "openclaw-audit-migration-scrub-redacted-" }, async (stateDir) => {
      const sourcePath = path.join(stateDir, "audit", "system-agent.jsonl");
      const rawPath = `${sourcePath}.migrated.raw`;
      const restorePath = `${rawPath}.doctor-scrub-restore`;
      const originalContent = `${JSON.stringify({
        timestamp: "2026-07-03T00:00:00.000Z",
        operation: "gateway.restart",
        summary: "secret archive value",
      })}\n`;
      const replacementContent = originalContent.replace("secret archive value", " ".repeat(20));
      await fs.mkdir(path.dirname(sourcePath), { recursive: true });
      await fs.writeFile(`${sourcePath}.migrated`, "{}\n");
      await fs.writeFile(rawPath, replacementContent);
      await fs.writeFile(
        restorePath,
        await buildTestAuditRestoreJournal(rawPath, Buffer.from(originalContent, "utf8")),
      );

      const result = await migrateLegacyAuditLogs({
        detected: detectLegacyAuditLogs({ stateDir, doctorOnlyStateMigrations: true }),
        stateDir,
      });

      expect(result.warnings.join("\n")).toContain("no longer matches its restore journal target");
      await expect(fs.readFile(rawPath, "utf8")).resolves.toBe(replacementContent);
      await expect(fs.access(restorePath)).resolves.toBeUndefined();
    });
  });

  it("resumes a one-byte scrub interruption using exact journal progress", async () => {
    await withTempDir({ prefix: "openclaw-audit-migration-scrub-one-byte-" }, async (stateDir) => {
      const sourcePath = path.join(stateDir, "audit", "system-agent.jsonl");
      const rawPath = `${sourcePath}.migrated.raw`;
      const restorePath = `${rawPath}.doctor-scrub-restore`;
      const originalContent = `${JSON.stringify({
        timestamp: "2026-07-03T00:00:00.000Z",
        operation: "gateway.restart",
        summary: "original archive",
      })}\n`;
      const replacementBytes = Buffer.from(originalContent);
      replacementBytes[0] = TEST_AUDIT_SCRUB_PATTERN[0]!;
      await fs.mkdir(path.dirname(sourcePath), { recursive: true });
      await fs.writeFile(`${sourcePath}.migrated`, "{}\n");
      await fs.writeFile(rawPath, replacementBytes);
      await fs.writeFile(
        restorePath,
        await buildTestAuditRestoreJournal(rawPath, Buffer.from(originalContent), {
          restoredBytes: 0,
          scrubbedBytes: 1,
        }),
      );

      const result = await migrateLegacyAuditLogs({
        detected: detectLegacyAuditLogs({ stateDir, doctorOnlyStateMigrations: true }),
        stateDir,
      });

      expect(result.warnings).toEqual([]);
      expect((await fs.readFile(rawPath, "utf8")).trim()).toBe("");
      await expect(fs.access(restorePath)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("resumes restoration after an interrupted rollback write", async () => {
    await withTempDir({ prefix: "openclaw-audit-migration-restore-restart-" }, async (stateDir) => {
      const sourcePath = path.join(stateDir, "audit", "system-agent.jsonl");
      const rawPath = `${sourcePath}.migrated.raw`;
      const restorePath = `${rawPath}.doctor-scrub-restore`;
      const originalContent = `${JSON.stringify({
        timestamp: "2026-07-03T00:00:00.000Z",
        operation: "gateway.restart",
        summary: "restore after restart",
      })}\n`;
      const originalBytes = Buffer.from(originalContent, "utf8");
      const interruptedRestore = buildTestAuditScrubbedContent(originalBytes.length);
      originalBytes.subarray(0, Math.floor(originalBytes.length / 2)).copy(interruptedRestore);
      await fs.mkdir(path.dirname(sourcePath), { recursive: true });
      await fs.writeFile(`${sourcePath}.migrated`, "{}\n");
      await fs.writeFile(rawPath, interruptedRestore);
      await fs.writeFile(
        restorePath,
        await buildTestAuditRestoreJournal(rawPath, originalBytes, {
          restoredBytes: Math.floor(originalBytes.length / 2),
          scrubbedBytes: originalBytes.length,
        }),
      );

      const result = await migrateLegacyAuditLogs({
        detected: detectLegacyAuditLogs({ stateDir, doctorOnlyStateMigrations: true }),
        stateDir,
      });

      expect(result.warnings).toEqual([]);
      expect(
        listSystemAgentAuditEntriesForTests({
          env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
        }).map((entry) => entry.value.summary),
      ).toEqual(["restore after restart"]);
      await expect(fs.access(restorePath)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });
});
