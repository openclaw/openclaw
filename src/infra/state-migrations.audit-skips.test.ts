import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EMPTY_LEGACY_SESSION_SURFACES } from "../plugins/legacy-session-surfaces.types.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { openLegacyAuditRawCheckpointStore } from "./state-migrations.audit-checkpoints.js";
import {
  AuditMigrationFixture,
  buildAuditScrubbedContent,
  configAuditRecord,
  failArchiveHardening,
  failAuditMove,
  systemAuditEvent,
  withAuditMigrationFixture,
  writeAuditRestoreJournal,
} from "./state-migrations.audit.test-support.js";
import { autoMigrateLegacyState } from "./state-migrations.doctor.js";
import { throwIfDoctorStateMigrationRefused } from "./state-migrations.messages.js";

afterEach(() => vi.restoreAllMocks());

/** Imports one record, then leaves its raw archive without the sanitized companion in the given shape. */
async function seedMissingCompanion(
  audit: AuditMigrationFixture,
  shape: "empty" | "imported" | "moved file",
) {
  const record = configAuditRecord("***");
  await audit.writeJsonLines(audit.config.source, [record]);
  if (shape === "moved file") {
    // Whole-second timestamps survive a utimes round trip exactly.
    await fs.utimes(audit.config.source, 1_700_000_000, 1_700_000_000);
  }
  expect((await audit.migrate()).warnings).toEqual([]);
  if (shape === "imported") {
    await audit.appendJsonLines(audit.config.raw, [record]);
    const failure = failArchiveHardening(audit, audit.config.sanitized, "interrupted import");
    expect((await audit.migrate()).warnings.join("\n")).toContain("interrupted import");
    failure.mockRestore();
  } else if (shape === "moved file") {
    // Same bytes, size and mtime under a new file identity, as after a volume remount or
    // copy. The copy is written beside the original so it cannot reuse its inode.
    const before = await fs.stat(audit.config.raw);
    const bytes = await fs.readFile(audit.config.raw);
    const copy = `${audit.config.raw}.copy`;
    await fs.copyFile(audit.config.raw, copy);
    await fs.utimes(copy, before.atimeMs / 1000, before.mtimeMs / 1000);
    await fs.rename(copy, audit.config.raw);
    const after = await fs.stat(audit.config.raw);
    expect(after.ino).not.toBe(before.ino);
    expect([after.size, after.mtimeMs]).toEqual([before.size, before.mtimeMs]);
    await expect(fs.readFile(audit.config.raw)).resolves.toEqual(bytes);
  } else {
    // Revisit unchanged content after a backup restore changes file metadata.
    await fs.utimes(audit.config.raw, 1, 1);
  }
  await fs.rm(audit.config.sanitized);
}

describe("Doctor legacy audit skips", () => {
  it.each([
    ["checkpointless whitespace", "checkpointless raw archive begins with ambiguous whitespace"],
    ["checkpoint capacity", "durable raw-archive checkpoint capacity is exhausted"],
    ["hard links unavailable", "filesystem rejects native no-replace rename and hard links"],
    // One Doctor row proves the skip lets later repairs run; the three shapes are proven below
    // against the audit-logs step itself.
    ["missing companion, imported", "sanitized companion is missing"],
  ])("continues later repairs after %s and preserves recovery inputs", async (shape, warning) => {
    await withOpenClawTestState({ label: "audit-skip" }, async (state) => {
      const cfg = { plugins: { enabled: false } };
      await state.writeConfig(cfg);
      const audit = new AuditMigrationFixture(state.stateDir);
      const record = configAuditRecord("***");
      let preservedPath = audit.config.raw;
      if (shape === "checkpointless whitespace") {
        await audit.seedRawArchive(audit.config, buildAuditScrubbedContent(512));
        await audit.writeJsonLines(
          audit.config.sanitized,
          Array.from({ length: 45 }, () => record),
        );
      } else if (shape === "checkpoint capacity") {
        await audit.writeJsonLines(audit.config.source, [record]);
        expect((await audit.migrate()).warnings).toEqual([]);
        const store = openLegacyAuditRawCheckpointStore(state.stateDir);
        const checkpoint = store.entries()[0]!;
        store.registerLegacyMany(
          Array.from({ length: 9_999 }, (_, index) => ({
            ...checkpoint,
            key: `retained-generation-${index}`,
            value: { ...checkpoint.value, generationKey: `retained-generation-${index}` },
          })),
        );
        await audit.writeJsonLines(audit.config.source, [record]);
        preservedPath = audit.config.source;
      } else if (shape === "missing companion, imported") {
        await seedMissingCompanion(audit, "imported");
      } else {
        await audit.writeJsonLines(audit.config.source, [record]);
        preservedPath = audit.config.source;
        failAuditMove(audit, audit.config.source);
      }
      const sourceBytes = await fs.readFile(preservedPath);
      const sanitizedBytes =
        shape === "hard links unavailable" || shape.startsWith("missing companion")
          ? undefined
          : await fs.readFile(audit.config.sanitized);
      const execPath = await state.writeJson("exec-approvals.json", {
        version: 1,
        defaults: { security: "allowlist", ask: "on-miss" },
        agents: {},
      });
      const migrate = () =>
        autoMigrateLegacyState({
          cfg,
          doctorOnlyStateMigrations: true,
          env: state.env,
          homedir: () => state.home,
          legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
        });

      const result = await migrate();

      expect(result.stepReceipts.find((receipt) => receipt.id === "audit-logs")).toMatchObject({
        outcome: "skipped",
        changes: [],
        warnings: [expect.stringContaining(warning)],
      });
      expect(() => throwIfDoctorStateMigrationRefused(result.stepReceipts)).not.toThrow();
      expect(result.warnings.join("\n")).toContain(warning);
      if (shape === "hard links unavailable") {
        expect(result.warnings.join("\n")).toContain(audit.config.source);
        expect(result.warnings.join("\n")).toContain("OPENCLAW_STATE_DIR=");
        expect(result.warnings.join("\n")).toContain(state.stateDir);
        expect(result.warnings.join("\n")).toContain("openclaw doctor --fix");
      } else {
        expect(result.warnings.join("\n")).toContain(
          "https://docs.openclaw.ai/cli/update/repair-and-recovery",
        );
      }
      expect(result.stepReceipts.find((receipt) => receipt.id === "exec-approvals")).toMatchObject({
        outcome: "completed",
      });
      await expect(fs.access(execPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(
        openOpenClawStateDatabase({ env: state.env })
          .db.prepare(
            "SELECT default_security FROM exec_approvals_config WHERE config_key = 'current'",
          )
          .get()?.default_security,
      ).toBe("allowlist");
      const repeated = await migrate();
      expect(repeated.stepReceipts.find((receipt) => receipt.id === "audit-logs")?.outcome).toBe(
        "skipped",
      );
      expect(repeated.warnings.join("\n")).toContain(warning);
      expect(() => throwIfDoctorStateMigrationRefused(repeated.stepReceipts)).not.toThrow();
      await expect(fs.readFile(preservedPath)).resolves.toEqual(sourceBytes);
      if (sanitizedBytes) {
        await expect(fs.readFile(audit.config.sanitized)).resolves.toEqual(sanitizedBytes);
      } else {
        await expect(fs.access(audit.config.sanitized)).rejects.toMatchObject({ code: "ENOENT" });
      }
    });
  });

  it.each(["empty", "imported", "moved file"] as const)(
    "keeps a %s raw archive whose sanitized companion is missing and imports nothing",
    async (shape) => {
      await withAuditMigrationFixture(async (audit) => {
        await seedMissingCompanion(audit, shape);
        const rawBytes = await fs.readFile(audit.config.raw);
        const checkpoints = openLegacyAuditRawCheckpointStore(audit.stateDir).entries();
        const imported = audit.configRecords();

        const first = await audit.migrate();
        const repeated = await audit.migrate();

        for (const result of [first, repeated]) {
          expect(result).toMatchObject({
            outcome: "skipped",
            warningDisposition: "recoverable",
            changes: [],
            warnings: [expect.stringContaining("sanitized companion is missing")],
          });
          expect(result.warnings[0]).toContain("no records remain to import");
          expect(result.warnings[0]).toContain(
            "https://docs.openclaw.ai/cli/update/repair-and-recovery",
          );
        }
        await expect(fs.readFile(audit.config.raw)).resolves.toEqual(rawBytes);
        expect(openLegacyAuditRawCheckpointStore(audit.stateDir).entries()).toEqual(checkpoints);
        expect(audit.configRecords()).toEqual(imported);
        await expect(fs.access(audit.config.sanitized)).rejects.toMatchObject({ code: "ENOENT" });
      });
    },
  );

  it.each([
    "rewritten",
    "malformed rewrite",
    "empty",
    "checkpointless empty",
    "append-only",
    "missing",
  ])("preserves migrated history and continues Doctor after a %s raw archive", async (shape) => {
    await withOpenClawTestState({ label: "audit-quarantine" }, async (state) => {
      const cfg = { plugins: { enabled: false } };
      await state.writeConfig(cfg);
      const audit = new AuditMigrationFixture(state.stateDir);
      const records = [0, 1, 2].map((index) =>
        configAuditRecord("***", { ts: `2026-07-01T00:00:0${index}.000Z` }),
      );
      if (shape === "checkpointless empty") {
        await audit.writeJsonLines(audit.config.sanitized, records);
        await audit.write(audit.config.raw, "");
      } else {
        await audit.writeJsonLines(audit.config.source, records);
        expect((await audit.migrate()).warnings).toEqual([]);
      }
      const sanitized = await fs.readFile(audit.config.sanitized);
      const retained = audit.configRecords();
      const backup = `${audit.config.raw}.bak`;
      await audit.write(backup, " \t\n");
      await audit.write(`${audit.config.source}.bak`, sanitized);
      if (shape === "rewritten") {
        await audit.writeJsonLines(audit.config.raw, records.slice(1));
      } else if (shape === "malformed rewrite") {
        await audit.write(audit.config.raw, "{bad json\n");
      } else if (shape === "empty") {
        await audit.write(audit.config.raw, "");
      } else if (shape === "append-only") {
        await audit.appendJsonLines(audit.config.raw, [records[0]]);
      } else if (shape === "missing") {
        await fs.rm(audit.config.raw);
      }
      const raw = shape === "missing" ? undefined : await fs.readFile(audit.config.raw);
      const execPath = await state.writeJson("exec-approvals.json", {
        version: 1,
        defaults: { security: "allowlist", ask: "on-miss" },
        agents: {},
      });
      const migrate = () =>
        autoMigrateLegacyState({
          cfg,
          doctorOnlyStateMigrations: true,
          env: state.env,
          homedir: () => state.home,
          legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
        });

      const result = await migrate();

      expect(() => throwIfDoctorStateMigrationRefused(result.stepReceipts)).not.toThrow();
      expect(result.stepReceipts.find((receipt) => receipt.id === "exec-approvals")?.outcome).toBe(
        "completed",
      );
      await expect(fs.access(execPath)).rejects.toMatchObject({ code: "ENOENT" });
      const quarantines = (await fs.readdir(path.dirname(audit.config.raw))).filter((name) =>
        name.includes(".quarantined-"),
      );
      if (shape === "append-only" || shape === "missing") {
        expect(result.warnings).toEqual([]);
        expect(quarantines).toEqual([]);
        expect(audit.configRecords()).toHaveLength(
          retained.length + (shape === "append-only" ? 1 : 0),
        );
      } else {
        expect(quarantines).toHaveLength(1);
        const quarantined = path.join(path.dirname(audit.config.raw), quarantines[0]!);
        expect(result.warnings).toEqual([expect.stringContaining(quarantined)]);
        expect(result.warnings[0]).toContain("expected append-only growth");
        await expect(fs.readFile(quarantined)).resolves.toEqual(raw);
        await expect(fs.access(audit.config.raw)).rejects.toMatchObject({ code: "ENOENT" });
        expect(audit.configRecords()).toEqual(retained);
        await expect(fs.readFile(audit.config.sanitized)).resolves.toEqual(sanitized);
      }
      await expect(fs.readFile(backup, "utf8")).resolves.toBe(" \t\n");
      await expect(fs.readFile(`${audit.config.source}.bak`)).resolves.toEqual(sanitized);
      expect((await migrate()).warnings).toEqual([]);
    });
  });

  it("keeps an unsafe interrupted recovery refusing alongside an independent skip", async () => {
    await withOpenClawTestState({ label: "audit-skip-refusal" }, async (state) => {
      const cfg = { plugins: { enabled: false } };
      await state.writeConfig(cfg);
      const audit = new AuditMigrationFixture(state.stateDir);
      await audit.seedRawArchive(audit.config, buildAuditScrubbedContent(512));
      const original = `${JSON.stringify(systemAuditEvent("original archive"))}\n`;
      const changed = original.replace("original archive", " ".repeat(16));
      await audit.seedRawArchive(audit.system, changed);
      await writeAuditRestoreJournal(audit.system.raw, Buffer.from(original));

      const result = await autoMigrateLegacyState({
        cfg,
        doctorOnlyStateMigrations: true,
        env: state.env,
        homedir: () => state.home,
        legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
      });

      expect(result.warnings.join("\n")).toContain("ambiguous whitespace");
      expect(result.warnings.join("\n")).toContain("no longer matches its restore journal target");
      expect(result.stepReceipts.find((receipt) => receipt.id === "audit-logs")?.outcome).toBe(
        "refused",
      );
      expect(() => throwIfDoctorStateMigrationRefused(result.stepReceipts)).toThrow(
        "Doctor stopped",
      );
      await expect(fs.readFile(audit.system.raw, "utf8")).resolves.toBe(changed);
      await fs.access(audit.system.restore);
    });
  });

  it("refuses without importing when the companion is missing and raw records remain unimported", async () => {
    await withOpenClawTestState({ label: "audit-companion-refusal" }, async (state) => {
      const cfg = { plugins: { enabled: false } };
      await state.writeConfig(cfg);
      const audit = new AuditMigrationFixture(state.stateDir);
      await audit.writeJsonLines(audit.config.source, [configAuditRecord("***")]);
      expect((await audit.migrate()).warnings).toEqual([]);
      await audit.appendJsonLines(audit.config.raw, [
        configAuditRecord("***", { ts: "2026-07-01T00:00:09.000Z" }),
      ]);
      await fs.rm(audit.config.sanitized);
      const rawBytes = await fs.readFile(audit.config.raw);
      const checkpoints = openLegacyAuditRawCheckpointStore(state.stateDir).entries();
      const imported = audit.configRecords();
      expect(imported).toHaveLength(1);
      const execPath = await state.writeJson("exec-approvals.json", {
        version: 1,
        defaults: { security: "allowlist", ask: "on-miss" },
        agents: {},
      });
      const execBytes = await fs.readFile(execPath);

      const result = await autoMigrateLegacyState({
        cfg,
        doctorOnlyStateMigrations: true,
        env: state.env,
        homedir: () => state.home,
        legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
      });

      expect(result.stepReceipts.find((receipt) => receipt.id === "audit-logs")).toMatchObject({
        outcome: "refused",
        warnings: [expect.stringContaining("the raw archive contains unimported records")],
      });
      expect(result.warnings.join("\n")).toContain("from a verified backup");
      expect(() => throwIfDoctorStateMigrationRefused(result.stepReceipts)).toThrow(
        "Doctor stopped",
      );
      expect(result.stepReceipts.find((receipt) => receipt.id === "exec-approvals")).toMatchObject({
        outcome: "refused",
        changes: [],
        refusal: {
          code: "blocked-by-prior-refusal",
          message: expect.stringContaining('prior step "audit-logs"'),
        },
      });
      await expect(fs.readFile(execPath)).resolves.toEqual(execBytes);
      expect(audit.configRecords()).toEqual(imported);
      await expect(fs.readFile(audit.config.raw)).resolves.toEqual(rawBytes);
      expect(openLegacyAuditRawCheckpointStore(state.stateDir).entries()).toEqual(checkpoints);
      await expect(fs.access(audit.config.sanitized)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });
});
