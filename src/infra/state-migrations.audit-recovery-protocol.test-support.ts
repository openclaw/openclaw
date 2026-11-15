import assert from "node:assert/strict";
import { root } from "@openclaw/fs-safe/root";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import {
  readLegacyAuditSourceSnapshot,
  restoreInterruptedAuditRecoveryArchive,
  scrubLegacyAuditRecoveryArchive,
} from "./state-migrations.audit-recovery.js";

const directories: unknown = JSON.parse(process.argv[2] ?? "null");
assert.ok(Array.isArray(directories));
const results = [];
try {
  for (const scenario of directories) {
    assert.ok(typeof scenario.directory === "string");
    const migrationRoot = await root(scenario.directory);
    const relativePath = "config-audit.jsonl.migrated.raw";
    if (scenario.observedIno !== undefined) {
      assert.ok(typeof scenario.observedIno === "string");
      // Model native full-width IDs while retaining real file reads, writes, and recovery.
      const observedIno = BigInt(scenario.observedIno);
      const read = migrationRoot.read.bind(migrationRoot);
      migrationRoot.read = async (...args) => {
        const result = await read(...args);
        return args[0] === relativePath
          ? { ...result, exactIdentity: { ...result.exactIdentity, ino: observedIno } }
          : result;
      };
      const openWritable = migrationRoot.openWritable.bind(migrationRoot);
      migrationRoot.openWritable = async (...args) => {
        const result = await openWritable(...args);
        if (args[0] === relativePath) {
          result.exactIdentity = { ...result.exactIdentity, ino: observedIno };
        }
        return result;
      };
    }
    const warnings: string[] = [];
    const restored = await restoreInterruptedAuditRecoveryArchive({
      root: migrationRoot,
      relativePath,
      label: "config audit log",
      warnings,
    });
    if (restored && scenario.upgrade === true) {
      const snapshot = await readLegacyAuditSourceSnapshot(migrationRoot, relativePath);
      const scrubbed = await scrubLegacyAuditRecoveryArchive({
        root: migrationRoot,
        relativePath,
        expectedSnapshot: snapshot,
        label: "config audit log",
        warnings,
      });
      assert.ok(scrubbed);
      const journal = await migrationRoot.read(`${relativePath}.doctor-scrub-restore`);
      results.push({
        restored,
        warnings,
        restoredRaw: snapshot.raw,
        nextJournal: JSON.parse(journal.buffer.toString("utf8")),
      });
    } else {
      results.push({ restored, warnings });
    }
  }
} finally {
  await closeOpenClawStateDatabaseAsync();
}
process.stdout.write(JSON.stringify(results));
