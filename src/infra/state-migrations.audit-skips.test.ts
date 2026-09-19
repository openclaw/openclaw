import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { EMPTY_LEGACY_SESSION_SURFACES } from "../plugins/legacy-session-surfaces.types.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { openLegacyAuditRawCheckpointStore } from "./state-migrations.audit-checkpoints.js";
import {
  AuditMigrationFixture,
  buildAuditScrubbedContent,
  configAuditRecord,
  systemAuditEvent,
  writeAuditRestoreJournal,
} from "./state-migrations.audit.test-support.js";
import { autoMigrateLegacyState } from "./state-migrations.doctor.js";
import { throwIfDoctorStateMigrationRefused } from "./state-migrations.messages.js";

describe("Doctor legacy audit skips", () => {
  it.each([
    ["checkpointless whitespace", "checkpointless raw archive begins with ambiguous whitespace"],
    ["checkpoint capacity", "durable raw-archive checkpoint capacity is exhausted"],
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
      } else {
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
      }
      const sourceBytes = await fs.readFile(preservedPath);
      const sanitizedBytes = await fs.readFile(audit.config.sanitized);
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
      expect(result.warnings.join("\n")).toContain(
        "https://docs.openclaw.ai/cli/update/repair-and-recovery",
      );
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
      await expect(fs.readFile(audit.config.sanitized)).resolves.toEqual(sanitizedBytes);
    });
  });

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
      await expect(fs.access(audit.system.restore)).resolves.toBeUndefined();
    });
  });
});
