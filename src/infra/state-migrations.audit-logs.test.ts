import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it as baseIt, vi } from "vitest";
import { CONFIG_AUDIT_MAX_ENTRIES, CONFIG_AUDIT_SCOPE } from "../config/io.audit.js";
import { resetPluginStateStoreForTests } from "../plugin-state/plugin-state-store.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { SYSTEM_AGENT_AUDIT_SCOPE } from "../system-agent/audit.js";
import * as fsSafe from "./fs-safe.js";
import { createSqliteAuditRecordStore } from "./sqlite-audit-record-store.js";
import { openLegacyAuditRawCheckpointStore } from "./state-migrations.audit-checkpoints.js";
import { readLegacyAuditSourceSnapshot } from "./state-migrations.audit-recovery.js";
import {
  AuditMigrationFixture,
  buildAuditScrubbedContent,
  configAuditRecord,
  failArchiveHardening,
  failAuditMove,
  failSecondScrubWrite,
  FIRST_AUDIT_SCRUB_BYTE,
  systemAuditEvent,
  withAuditMigrationFixture,
  writeAuditRestoreJournal,
} from "./state-migrations.audit.test-support.js";
import { withGatewayLockHeld } from "./state-migrations.gateway-lock.test-support.js";

const at = (day: string) => `2026-07-${day}T00:00:00.000Z`;
const jsonLine = (record: unknown) => `${JSON.stringify(record)}\n`;
const readText = (file: string) => fs.readFile(file, "utf8");
function event(summary: string, day = "03", operation = "gateway.restart") {
  return systemAuditEvent(summary, { timestamp: at(day), operation });
}

const it = baseIt.extend<{ audit: AuditMigrationFixture }>({
  audit: async ({ task: _task }, use) => withAuditMigrationFixture(use),
});
function expectIncludes(text: string | string[], ...parts: (string | RegExp)[]) {
  const value = Array.isArray(text) ? text.join("\n") : text;
  for (const part of parts) {
    if (typeof part === "string") {
      expect(value).toContain(part);
    } else {
      expect(value).toMatch(part);
    }
  }
}
function invalidUtf8Record(newline = "") {
  return Buffer.concat([
    Buffer.from(
      '{"timestamp":"2026-07-03T00:00:00.000Z","operation":"gateway.restart","summary":"',
    ),
    Buffer.from([0x80]),
    Buffer.from('"}' + newline),
  ]);
}
async function migrateClean(audit: AuditMigrationFixture, detected = audit.detect()) {
  const result = await audit.migrate(detected);
  expect(result.warnings).toEqual([]);
  return result;
}
async function seedArchive(audit: AuditMigrationFixture, records: unknown[]) {
  await audit.writeJsonLines(audit.system.source, records);
  await audit.migrate();
}
async function expectSystemArchive(audit: AuditMigrationFixture, summaries: string[]) {
  expect(audit.systemSummaries()).toEqual(summaries);
  const archived = await audit.readJsonLines<{ summary: string }>(audit.system.sanitized);
  expect(archived.map((entry) => entry.summary)).toEqual(summaries);
}
async function expectMissing(...paths: string[]) {
  for (const pathname of paths) {
    await expect(fs.access(pathname)).rejects.toMatchObject({ code: "ENOENT" });
  }
}
function auditStore(audit: AuditMigrationFixture, scope: string, maxEntries: number) {
  return createSqliteAuditRecordStore({ env: audit.env, scope, maxEntries });
}

it("preserves descriptor appends without the native helper", async ({ audit }) => {
  const { source, claim, raw, sanitized } = audit.config;
  await audit.writeJsonLines(source, [configAuditRecord("original")]);
  const predecessor = await fs.open(source, "a");
  const identity = await predecessor.stat();
  const moveSpy = failAuditMove(
    audit,
    source,
    new fsSafe.FsSafeError("helper-unavailable", "native fs-safe helper is unavailable"),
  );
  try {
    await migrateClean(audit);
    expect(await fs.stat(raw)).toMatchObject({ dev: identity.dev, ino: identity.ino, nlink: 1 });
    await expectMissing(source, claim);
    const later = configAuditRecord("late-descriptor-row", { ts: at("04") });
    await predecessor.appendFile(jsonLine(later));
    await predecessor.sync();
    await expect(readText(raw)).resolves.toContain("late-descriptor-row");
    await migrateClean(audit);
    expect(audit.configRecords()).toHaveLength(2);
    const rows = await audit.readJsonLines<{ ts: string }>(sanitized);
    expect(rows.map((row) => row.ts)).toEqual([at("01"), at("04")]);
    expect(audit.detect().hasLegacy).toBe(false);
    expect((await audit.migrate()).changes).toEqual([]);
    expect(audit.configRecords()).toHaveLength(2);
  } finally {
    moveSpy.mockRestore();
    await predecessor.close();
  }
});

it.for(["source", "archive", "journal"] as const)(
  "retains bytes after a %s move refusal",
  async (phase, { audit }) => {
    const { source, claim, raw, sanitized } = audit.config;
    const original = jsonLine(configAuditRecord("retained-during-move"));
    await audit.write(source, original);
    const identity = await fs.stat(source);
    await audit.writeJsonLines(audit.system.source, [event("Independent source")]);
    const rejectedSource =
      phase === "source" ? source : phase === "archive" ? claim : `${raw}.doctor-scrub-staging`;
    const moveSpy = failAuditMove(audit, rejectedSource);
    try {
      const result = await audit.migrate();
      expect(result.warningDisposition).toBe("recoverable");
      const warning = result.warnings.join("\n");
      expectIncludes(
        warning,
        rejectedSource,
        "OPENCLAW_STATE_DIR=",
        audit.stateDir,
        "openclaw doctor --fix",
      );
      await expect(
        readText(phase === "source" ? source : phase === "archive" ? claim : raw),
      ).resolves.toBe(original);
      expect(audit.systemSummaries()).toEqual(["Independent source"]);
      expect(audit.configRecords()).toHaveLength(phase === "source" ? 0 : 1);
      if (phase === "source") {
        expect(warning).toMatch(/filesystem|hard.link/iu);
        expect(await fs.stat(source)).toMatchObject({ dev: identity.dev, ino: identity.ino });
        await expectMissing(claim, raw, sanitized, audit.system.source);
      }
    } finally {
      moveSpy.mockRestore();
    }
    await migrateClean(audit);
    expect(audit.configRecords()).toHaveLength(1);
    expect(audit.systemSummaries()).toEqual(["Independent source"]);
    expect(audit.detect().hasLegacy).toBe(false);
    await expectMissing(source, claim);
    expect((await audit.migrate()).changes).toEqual([]);
    expect(audit.configRecords()).toHaveLength(1);
  },
);

it.for(["source/claim", "claim/raw", "source/raw", "journal"] as const)(
  "recovers an interrupted %s hard-link pair exactly once",
  async (pair, { audit }) => {
    const { source, claim, raw, sanitized, restore } = audit.system;
    const record = event("Interrupted hard-link move");
    const staging = `${raw}.doctor-scrub-staging`;
    if (pair === "source/claim") {
      await audit.writeJsonLines(source, [record]);
      await fs.link(source, claim);
    } else {
      await audit.writeJsonLines(raw, [record]);
      await audit.writeJsonLines(sanitized, [record]);
      if (pair === "journal") {
        await writeAuditRestoreJournal(raw, await fs.readFile(raw));
        await fs.link(restore, staging);
      } else {
        await fs.link(raw, pair === "claim/raw" ? claim : source);
      }
    }
    await migrateClean(audit);
    expect(audit.systemSummaries()).toEqual([record.summary]);
    expect(await fs.stat(raw)).toMatchObject({ nlink: 1 });
    await expectMissing(source, claim, restore, staging, `${source}.migrated.2.raw`);
    expect(audit.detect().hasLegacy).toBe(false);
    expect((await audit.migrate()).changes).toEqual([]);
    expect(audit.systemSummaries()).toEqual([record.summary]);
  },
);

it("completes quarantine links without replay or rename", async ({ audit }) => {
  const { source, raw, sanitized } = audit.config;
  await audit.writeJsonLines(source, [configAuditRecord("original")]);
  await migrateClean(audit);
  const retainedRecords = audit.configRecords();
  const sanitizedBytes = await fs.readFile(sanitized);
  const rewritten = jsonLine(configAuditRecord("rewritten"));
  await audit.write(raw, rewritten);
  const quarantine = `${raw}.quarantined-2026-10-03T00-00-00-000Z-00000000-0000-4000-8000-000000000142`;
  await fs.link(raw, quarantine);
  const recovered = await audit.migrate();
  expect(recovered.warningDisposition).toBe("recoverable");
  expect(recovered.warnings).toEqual([expect.stringContaining(quarantine)]);
  await expectMissing(raw);
  await expect(readText(quarantine)).resolves.toBe(rewritten);
  expect(await fs.stat(quarantine)).toMatchObject({ nlink: 1 });
  await expect(fs.readFile(sanitized)).resolves.toEqual(sanitizedBytes);
  expect(audit.configRecords()).toEqual(retainedRecords);
  await migrateClean(audit);
  expect(
    (await fs.readdir(path.dirname(raw))).filter((entry) => entry.includes(".quarantined-")),
  ).toEqual([path.basename(quarantine)]);
});

it("never overwrites a competing hard-link destination", async ({ audit }) => {
  const { source, claim } = audit.config;
  const original = jsonLine(configAuditRecord("source-owner"));
  const competing = jsonLine(configAuditRecord("destination-owner"));
  await audit.write(source, original);
  const moveSpy = failAuditMove(
    audit,
    source,
    new fsSafe.FsSafeError("helper-unavailable", "native fs-safe helper is unavailable"),
    () => writeFileSync(claim, competing, { flag: "wx" }),
  );
  try {
    const result = await audit.migrate();
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.changes).toEqual([]);
    await expect(readText(source)).resolves.toBe(original);
    await expect(readText(claim)).resolves.toBe(competing);
    expect(audit.configRecords()).toEqual([]);
  } finally {
    moveSpy.mockRestore();
  }
});

it.for(["unrecognized pair", "third link"])("rejects %s hard links", async (mode, { audit }) => {
  const { source, claim } = audit.system;
  const original = jsonLine(event("Unclaimed shared inode"));
  await audit.write(source, original);
  const unrelated = path.join(audit.stateDir, "unrelated-audit-link");
  await fs.link(source, unrelated);
  if (mode === "third link") {
    await fs.link(source, claim);
  }
  const result = await audit.migrate();
  expect(result.warnings.length).toBeGreaterThan(0);
  expect(result.changes).toEqual([]);
  await expect(readText(source)).resolves.toBe(original);
  await expect(readText(unrelated)).resolves.toBe(original);
  expect(audit.systemEntries()).toEqual([]);
  if (mode === "third link") {
    await expect(readText(claim)).resolves.toBe(original);
  }
});

it("imports and redacts audits only during Doctor repair", async ({ audit }) => {
  const { source: configPath, raw, sanitized } = audit.config;
  const { source: systemPath } = audit.system;
  const crestodianPath = path.join(audit.stateDir, "audit", "crestodian.jsonl");
  const record = configAuditRecord("must-redact");
  const digest = createHash("sha256").update(JSON.stringify(record)).digest("hex").slice(0, 16);
  await audit.writeJsonLines(configPath, [record]);
  await audit.writeJsonLines(systemPath, [event("Set config", "02", "config.set")]);
  await audit.writeJsonLines(crestodianPath, [event("Restarted gateway")]);
  expect(audit.detect(false).hasLegacy).toBe(false);
  const detected = audit.detect();
  expect(detected.sources).toHaveLength(3);
  const result = await migrateClean(audit, detected);
  expect(result.changes).toHaveLength(6);
  const configRecords = audit.configRecords();
  expect(configRecords).toHaveLength(1);
  expect(JSON.stringify(configRecords)).not.toContain("must-redact");
  const configEntries = auditStore(audit, CONFIG_AUDIT_SCOPE, CONFIG_AUDIT_MAX_ENTRIES).entries();
  expect(configEntries[0]?.key).not.toContain(digest);
  const sanitizedContent = await readText(sanitized);
  expect(sanitizedContent).not.toContain("must-redact");
  const rawContent = await readText(raw);
  expect(rawContent.trim()).toBe("");
  expect(Buffer.byteLength(rawContent)).toBe(Buffer.byteLength(jsonLine(record)));
  await expectMissing(audit.config.restore);
  if (process.platform !== "win32") {
    expect((await fs.stat(sanitized)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(raw)).mode & 0o777).toBe(0o600);
  }
  expect(JSON.parse(sanitizedContent.trim())).toMatchObject({
    argv: ["openclaw", "config", "set", "token", "***"],
  });
  expect(audit.systemOperations()).toEqual(["config.set", "gateway.restart"]);
  await expectMissing(configPath, systemPath, crestodianPath);
  expect(audit.detect().hasLegacy).toBe(false);
  const laterConfigRecord = configAuditRecord("later-redaction-marker", { ts: at("04") });
  await fs.appendFile(raw, jsonLine(laterConfigRecord));
  const rawRecovery = audit.detect();
  expect(rawRecovery.sources).toMatchObject([{ storage: "raw-archive" }]);
  const recovered = await migrateClean(audit, rawRecovery);
  expect(recovered.changes.join("\n")).toContain("Recovered 1 later config audit log row");
  expect(audit.configRecords()).toHaveLength(2);
  await expect(readText(sanitized)).resolves.not.toContain("later-redaction-marker");
  await expect(readText(raw)).resolves.not.toContain("later-redaction-marker");
  const recoveredArchiveRows = await audit.readJsonLines<{ ts: string }>(audit.config.sanitized);
  expect(recoveredArchiveRows.map((row) => row.ts)).toEqual([at("01"), at("04")]);
  expect(audit.detect().hasLegacy).toBe(false);
});

it("rehashes a checkpointed raw archive before treating it as clean", async ({ audit }) => {
  const { raw: rawPath, source: sourcePath } = audit.system;
  const original = event("original");
  const modified = { ...original, summary: "modified" };
  await audit.writeJsonLines(sourcePath, [original]);
  const stableMtime = new Date("2026-07-03T01:00:00.000Z");
  await fs.utimes(sourcePath, stableMtime, stableMtime);
  await audit.migrate();
  const checkpointedStat = await fs.stat(rawPath);
  const modifiedRaw = jsonLine(modified);
  expect(Buffer.byteLength(modifiedRaw)).toBe(checkpointedStat.size);
  await fs.writeFile(rawPath, modifiedRaw);
  const rewrittenStat = await fs.stat(rawPath);
  expect(rewrittenStat.size).toBe(checkpointedStat.size);
  const checkpointStore = openLegacyAuditRawCheckpointStore(audit.stateDir);
  const checkpoint = checkpointStore.entries()[0];
  if (!checkpoint) {
    throw new Error("expected a raw archive checkpoint");
  }
  // Keep the original hash despite matching the rewritten file's cheap identity.
  const { dev, ino, mtimeMs, size } = rewrittenStat;
  checkpointStore.upsert(
    checkpoint.key,
    { ...checkpoint.value, dev, ino, mtimeMs, size },
    checkpoint.createdAt,
  );
  const detected = audit.detect();
  expect(detected.sources).toMatchObject([{ sourcePath: rawPath, storage: "raw-archive" }]);
  const result = await audit.migrate(detected);
  expectIncludes(result.warnings, "changed other than by append");
  expect(audit.systemSummaries()).toEqual(["original"]);
});

it("restores the archive prefix after a failed scrub", async ({ audit }) => {
  const { raw: rawPath, source: sourcePath } = audit.config;
  const originalRecord = configAuditRecord("scrub-write-marker");
  const originalContent = jsonLine(originalRecord);
  await audit.write(sourcePath, originalContent);
  const writeSpy = await failSecondScrubWrite(audit);
  const failed = await audit.migrate().finally(() => writeSpy.mockRestore());
  expectIncludes(
    failed.warnings.join("\n"),
    "restored it for Doctor retry",
    "simulated scrub write failure",
  );
  await expect(readText(rawPath)).resolves.toBe(originalContent);
  expect(audit.detect().hasLegacy).toBe(true);
  await migrateClean(audit);
  await expect(readText(rawPath)).resolves.not.toContain("scrub-write-marker");
  expect(audit.detect().hasLegacy).toBe(false);
});

it("does not resurrect pruned history during append recovery", async ({ audit }) => {
  const { raw } = audit.system;
  const records = ["first", "second", "third"].map((summary, index) =>
    systemAuditEvent(summary, { timestamp: `2026-07-03T00:00:0${index}.000Z` }),
  );
  await seedArchive(audit, records);
  auditStore(audit, SYSTEM_AGENT_AUDIT_SCOPE, 3).upsert(
    "runtime",
    event("runtime", "04", "gateway.reload"),
  );
  await audit.appendJsonLines(raw, [event("appended", "05")]);
  const recovered = await migrateClean(audit);
  expect(recovered.changes.join("\n")).toContain("Recovered 1 later");
  expect(audit.systemSummaries()).toEqual(["second", "third", "appended", "runtime"]);
  const rawCheckpoints = createSqliteAuditRecordStore<{ recordCount: number }>({
    scope: "migration.legacy-audit-raw",
    maxEntries: 10_000,
    env: audit.env,
  }).entries();
  expect(rawCheckpoints).toMatchObject([{ value: { recordCount: 0 } }]);
});

it("keeps identical rows from separate raw archive generations", async ({ audit }) => {
  const { raw, source } = audit.system;
  const record = event("Repeated operation");
  const claimPath = path.join(
    path.dirname(source),
    `.${path.basename(source)}.doctor-importing.11`,
  );
  for (const file of [
    raw,
    `${source}.migrated.2.raw`,
    `${source}.migrated.10.raw`,
    claimPath,
    source,
  ]) {
    await audit.writeJsonLines(file, [record]);
  }
  const detected = audit.detect();
  expect(detected.sources.map((entry) => path.basename(entry.sourcePath))).toEqual([
    "system-agent.jsonl.migrated.raw",
    "system-agent.jsonl.migrated.2.raw",
    "system-agent.jsonl.migrated.10.raw",
    ".system-agent.jsonl.doctor-importing.11",
    "system-agent.jsonl",
  ]);
  await migrateClean(audit, detected);
  expect(audit.systemEntries()).toHaveLength(5);
  expect(audit.detect().hasLegacy).toBe(false);
});

it("does not replay restored archives after inode changes", async ({ audit: root }) => {
  const sourceAudit = new AuditMigrationFixture(path.join(root.stateDir, "source-state"));
  const restoredAudit = new AuditMigrationFixture(path.join(root.stateDir, "restored-state"));
  await sourceAudit.writeJsonLines(sourceAudit.system.source, [event("Restored operation")]);
  await sourceAudit.migrate();
  resetPluginStateStoreForTests();
  await fs.cp(sourceAudit.stateDir, restoredAudit.stateDir, { recursive: true });
  auditStore(restoredAudit, SYSTEM_AGENT_AUDIT_SCOPE, 1).upsert(
    "runtime-after-restore",
    event("Runtime after restore", "04", "gateway.reload"),
  );
  const restored = restoredAudit.detect();
  expect(restored.sources).toMatchObject([{ storage: "raw-archive" }]);
  const result = await restoredAudit.migrate(restored);
  expect(result.warnings).toEqual([]);
  expect(restoredAudit.systemSummaries()).toEqual(["Runtime after restore"]);
  expect(restoredAudit.detect().hasLegacy).toBe(false);
});

it.for(["claim-only", "interrupted", "active", "reserved"] as const)(
  "selects the %s archive generation",
  async (mode, { audit }) => {
    const { claim, raw, sanitized, source } = audit.system;
    const record = event("Interrupted operation");
    const firstGeneration = mode === "claim-only" || mode === "interrupted";
    if (mode === "claim-only") {
      await audit.writeJsonLines(source, [record]);
      await fs.rename(source, claim);
    } else if (mode === "interrupted") {
      await audit.writeJsonLines(claim, [record]);
      await audit.writeJsonLines(sanitized, [record]);
    } else {
      await seedArchive(audit, [record]);
      await fs.rm(raw);
      await audit.writeJsonLines(source, [record]);
      if (mode === "reserved") {
        await fs.rename(source, `${claim}.2`);
      }
    }
    const firstSanitized = mode === "active" ? await readText(sanitized) : undefined;
    const detected = audit.detect();
    if (mode === "claim-only") {
      expect(detected.sources).toMatchObject([{ sourcePath: claim, storage: "claim" }]);
    }
    if (mode === "reserved") {
      expect(detected.sources).toMatchObject([
        {
          sourcePath: `${claim}.2`,
          storage: "claim",
          sanitizedArchivePath: `${source}.migrated.2`,
          rawArchivePath: `${source}.migrated.2.raw`,
        },
      ]);
    }
    const result = await migrateClean(audit, detected);
    expect(audit.systemEntries()).toHaveLength(firstGeneration ? 1 : 2);
    await fs.access(firstGeneration ? raw : `${source}.migrated.2.raw`);
    if (firstGeneration) {
      await expectMissing(claim, `${source}.migrated.2.raw`);
    } else if (mode === "active") {
      expect(result.changes.join("\n")).toContain("1 new row");
      await expect(readText(sanitized)).resolves.toBe(firstSanitized);
    }
  },
);

it("blocks newer generations until the older source is repaired", async ({ audit }) => {
  const { raw, source } = audit.system;
  const malformed = `${JSON.stringify(event("valid prefix"))}\n{bad json\n`;
  await audit.write(raw, malformed);
  await audit.writeJsonLines(source, [event("newer generation")]);
  const blocked = await audit.migrate();
  expect(blocked.changes).toEqual([]);
  expectIncludes(blocked.warnings, "Failed reading system-agent audit log");
  await expect(readText(raw)).resolves.toBe(malformed);
  expect(await audit.readJsonLines(source)).toEqual([event("newer generation")]);
  expect(audit.systemEntries()).toEqual([]);
  await audit.writeJsonLines(raw, [event("repaired older generation")]);
  await migrateClean(audit);
  expect(audit.systemSummaries()).toEqual(["repaired older generation", "newer generation"]);
});

it("requires exclusive state ownership before claiming legacy audit files", async ({ audit }) => {
  const { source } = audit.system;
  await audit.writeJsonLines(source, [event("Restarted gateway")]);
  const result = await withGatewayLockHeld(audit.env, 18_791, () => audit.migrate());
  expectIncludes(result.warnings, "exclusive state ownership is unavailable");
  await fs.access(source);
  expect(audit.systemEntries()).toEqual([]);
});

it("leaves rows from an old config writer at the recreated source path", async ({ audit }) => {
  const { source } = audit.config;
  const records = Array.from({ length: 10_000 }, (_, index) =>
    configAuditRecord("value", {
      ts: new Date(Date.UTC(2026, 6, 1, 0, 0, index)).toISOString(),
      argv: ["openclaw", "config", "set", `key-${index}`, "value"],
    }),
  );
  await audit.writeJsonLines(source, records);
  const retainedRecord = configAuditRecord("value", {
    ts: at("02"),
    argv: ["openclaw", "config", "set", "later", "value"],
  });
  const recreateSource = vi.fn(() => audit.appendJsonLines(source, [retainedRecord]));
  const openRoot = fsSafe.root;
  vi.spyOn(fsSafe, "root").mockImplementation(async (rootPath, defaults) => {
    const root = await openRoot(rootPath, defaults);
    if (rootPath === audit.stateDir) {
      const move = root.move.bind(root);
      vi.spyOn(root, "move").mockImplementation(async (...args) => {
        const result = await move(...args);
        if (
          path.resolve(rootPath, args[0]) === source &&
          path.resolve(rootPath, args[1]) === audit.config.claim
        ) {
          await recreateSource();
        }
        return result;
      });
    }
    return root;
  });
  const first = await audit.migrate().finally(() => vi.restoreAllMocks());
  expect(recreateSource).toHaveBeenCalledOnce();
  expectIncludes(first.warnings, "An old writer recreated config audit log");
  await expect(readText(source)).resolves.toBe(jsonLine(retainedRecord));
  await migrateClean(audit);
  await expectMissing(source);
  expect(auditStore(audit, CONFIG_AUDIT_SCOPE, CONFIG_AUDIT_MAX_ENTRIES).entries()).toHaveLength(
    10_001,
  );
});

it.runIf(process.platform !== "win32")(
  "rejects audit sources beneath symlinked state parents",
  async ({ audit }) => {
    const externalAuditDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "openclaw-audit-migration-external-"),
    );
    try {
      const externalSource = path.join(externalAuditDir, "system-agent.jsonl");
      await audit.writeJsonLines(externalSource, [event("Outside state root")]);
      await fs.symlink(externalAuditDir, path.join(audit.stateDir, "audit"));
      const result = await audit.migrate();
      expect(result.changes).toEqual([]);
      expectIncludes(result.warnings, /alias|symlink|outside workspace/u);
      await expect(readText(externalSource)).resolves.toContain("Outside state root");
      await expectMissing(`${externalSource}.migrated`);
      expect(audit.systemEntries()).toEqual([]);
    } finally {
      await fs.rm(externalAuditDir, { recursive: true, force: true });
    }
  },
);

it("reads legacy audit sources larger than the ordinary read limit", async ({ audit }) => {
  const original = Buffer.alloc(16 * 1024 * 1024 + 1, " ");
  original.write("legacy audit archive\n");
  await audit.write(audit.system.raw, original);
  const snapshot = await readLegacyAuditSourceSnapshot(
    await fsSafe.root(audit.stateDir),
    "audit/system-agent.jsonl.migrated.raw",
  );
  expect(snapshot.rawBytes.equals(original)).toBe(true);
  expect(snapshot.size).toBe(original.length);
});

it("retains malformed UTF-8 without importing replacement characters", async ({ audit }) => {
  const { source: sourcePath, claim, raw, sanitized } = audit.system;
  const original = invalidUtf8Record();
  await audit.write(sourcePath, original);
  await audit.writeJsonLines(audit.config.source, [configAuditRecord("independent")]);
  const result = await audit.migrate();
  expect(result.warnings.join("\n")).toContain("must be valid UTF-8");
  expect(result.warningDisposition).toBe("recoverable");
  expect(await fs.readFile(sourcePath)).toEqual(original);
  await expectMissing(claim, raw, sanitized);
  expect(audit.systemSummaries()).toEqual([]);
  expect(audit.configRecords()).toHaveLength(1);
});

it("upgrades a legacy nonzero raw checkpoint to the blank append pad", async ({ audit }) => {
  const { raw: rawPath, source: sourcePath } = audit.system;
  await audit.writeJsonLines(sourcePath, [event("original")]);
  await audit.migrate();
  const legacyRaw = Buffer.from(jsonLine(event("é")));
  await fs.writeFile(rawPath, legacyRaw);
  const { dev, ino, mtimeMs, size } = await fs.stat(rawPath);
  const checkpointStore = openLegacyAuditRawCheckpointStore(audit.stateDir);
  const checkpoint = checkpointStore.entries()[0]!;
  checkpointStore.upsert(checkpoint.key, {
    ...checkpoint.value,
    dev,
    ino,
    mtimeMs,
    size,
    contentHash: createHash("sha256").update(legacyRaw.toString("utf8")).digest("hex"),
    recordCount: 1,
  });
  const detected = audit.detect();
  expect(detected.hasLegacy).toBe(true);
  await migrateClean(audit, detected);
  expect(openLegacyAuditRawCheckpointStore(audit.stateDir).entries()[0]?.value.recordCount).toBe(0);
});

it.for(["stale", "later", "redacted", "scrubbing", "restoring"] as const)(
  "recovers %s restore journals",
  async (mode, { audit }) => {
    const { raw, restore } = audit.system;
    const token = ["token", "redaction-marker"].join("=");
    let replacement = "";
    const summary = mode === "restoring" ? "restore after restart" : "original archive";
    if (mode === "stale" || mode === "later") {
      const original = mode === "stale" ? event(token, "03", "config.set") : event("original");
      const bytes = Buffer.from(jsonLine(original));
      await seedArchive(audit, [original]);
      if (mode === "stale") {
        await writeAuditRestoreJournal(raw, bytes);
      }
      await audit.appendJsonLines(raw, [event("later", "04")]);
      if (mode === "later") {
        const interrupted = await fs.readFile(raw);
        await writeAuditRestoreJournal(raw, interrupted, {
          restoredBytes: 0,
          scrubbedBytes: interrupted.length,
        });
        await fs.writeFile(raw, buildAuditScrubbedContent(interrupted.length));
      }
    } else if (mode === "redacted") {
      const original = jsonLine(event("secret archive value"));
      replacement = original.replace("secret archive value", " ".repeat(20));
      await audit.seedRawArchive(audit.system, replacement);
      await writeAuditRestoreJournal(raw, Buffer.from(original, "utf8"));
    } else {
      const bytes = Buffer.from(jsonLine(event(summary)));
      const restoredBytes = mode === "restoring" ? Math.floor(bytes.length / 2) : 0;
      const pending =
        mode === "restoring" ? buildAuditScrubbedContent(bytes.length) : Buffer.from(bytes);
      if (mode === "restoring") {
        bytes.subarray(0, restoredBytes).copy(pending);
      } else {
        pending[0] = FIRST_AUDIT_SCRUB_BYTE;
      }
      await audit.seedRawArchive(audit.system, pending);
      await writeAuditRestoreJournal(raw, bytes, {
        restoredBytes,
        scrubbedBytes: mode === "restoring" ? bytes.length : 1,
      });
    }
    const detected = audit.detect();
    if (mode === "stale") {
      expect(detected.hasLegacy).toBe(true);
    }
    const result = await audit.migrate(detected);
    if (mode === "redacted") {
      expectIncludes(result.warnings, "no longer matches its restore journal target");
      await expect(readText(raw)).resolves.toBe(replacement);
      await fs.access(restore);
    } else {
      expect(result.warnings).toEqual([]);
      await expectMissing(restore);
      if (mode === "stale") {
        expect(result.changes.join("\n")).toContain("Recovered 1 later");
        await expect(readText(raw)).resolves.not.toContain(token);
      } else if (mode === "later") {
        expect(audit.systemSummaries()).toEqual(["original", "later"]);
      } else {
        expect((await readText(raw)).trim()).toBe("");
        expect(audit.systemSummaries()).toEqual([summary]);
      }
    }
  },
);

it.for(["raw", "sanitized"] as const)(
  "recovers after %s archive hardening fails",
  async (phase, { audit }) => {
    const recovering = phase === "sanitized";
    const { raw, sanitized, source } = recovering ? audit.system : audit.config;
    await audit.writeJsonLines(source, [
      recovering ? event("before archive") : configAuditRecord("must-redact"),
    ]);
    if (recovering) {
      await audit.migrate();
      await audit.appendJsonLines(raw, [event("later row")]);
    }
    const chmodSpy = failArchiveHardening(
      audit,
      recovering ? sanitized : raw,
      "simulated chmod failure",
    );
    const failed = await audit.migrate().finally(() => chmodSpy.mockRestore());
    expect(failed.changes).toEqual([]);
    expectIncludes(
      failed.warnings,
      recovering
        ? "Failed securing sanitized system-agent audit log"
        : "Failed securing raw archived config audit log",
    );
    if (recovering) {
      expect(audit.detect().sources).toMatchObject([{ storage: "raw-archive" }]);
    } else {
      await expect(readText(source)).resolves.toContain("must-redact");
      await expectMissing(sanitized, raw);
    }
    await migrateClean(audit);
    if (recovering) {
      await expectSystemArchive(audit, ["before archive", "later row"]);
      expect(audit.detect().sources).toEqual([]);
    } else {
      await expectMissing(source);
      await fs.access(raw);
    }
  },
);

it("completes verified partial sanitized tails", async ({ audit }) => {
  const { raw, sanitized } = audit.system;
  await seedArchive(audit, [event("before archive", "01")]);
  const firstLater = event("first later row", "02");
  const secondLater = event("second later row");
  await audit.appendJsonLines(raw, [firstLater, secondLater]);
  // Stop after one complete candidate row beyond the durable checkpoint prefix.
  await audit.appendJsonLines(sanitized, [firstLater]);
  await migrateClean(audit);
  await expectSystemArchive(audit, ["before archive", "first later row", "second later row"]);
});

it("keeps identical appends and refuses ambiguous whitespace", async ({ audit }) => {
  const { raw, sanitized } = audit.system;
  const record = event("Repeated operation");
  await audit.write(audit.system.source, `${jsonLine(record)}\n${jsonLine(record)}`);
  await audit.migrate();
  await audit.appendJsonLines(raw, [record]);
  await migrateClean(audit);
  expect(audit.systemSummaries()).toEqual(Array(3).fill("Repeated operation"));
  const sanitizedRows = (await readText(sanitized)).trim().split("\n");
  expect(sanitizedRows).toHaveLength(3);
  runOpenClawStateWriteTransaction(
    (database) => {
      database.db
        .prepare("DELETE FROM diagnostic_events WHERE scope = ?")
        .run("migration.legacy-audit-raw");
    },
    { env: audit.env },
  );
  await audit.appendJsonLines(raw, [record]);
  const ambiguous = await audit.migrate();
  expect(ambiguous.changes).toEqual([]);
  expect(ambiguous.warnings).toEqual([
    expect.stringContaining("checkpointless raw archive begins with ambiguous whitespace"),
  ]);
  expect(audit.systemEntries()).toHaveLength(3);
  expect((await readText(sanitized)).trim().split("\n")).toHaveLength(3);
});
