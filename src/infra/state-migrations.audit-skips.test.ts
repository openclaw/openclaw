import fs from "node:fs/promises";
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
    ["rewritten archive", "changed other than by append"],
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
        if (shape === "rewritten archive") {
          await audit.writeJsonLines(audit.config.raw, [configAuditRecord("changed")]);
        } else {
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
