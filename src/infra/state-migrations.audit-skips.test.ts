import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { EMPTY_LEGACY_SESSION_SURFACES } from "../plugins/legacy-session-surfaces.types.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { openLegacyAuditRawCheckpointStore } from "./state-migrations.audit-checkpoints.js";
import {
  AuditMigrationFixture,
  buildAuditScrubbedContent,
  configAuditRecord,
  failAuditMove,
  systemAuditEvent,
  writeAuditRestoreJournal,
} from "./state-migrations.audit.test-support.js";
import { autoMigrateLegacyState } from "./state-migrations.doctor.js";
import { throwIfDoctorStateMigrationRefused } from "./state-migrations.messages.js";

afterEach(() => vi.restoreAllMocks());

async function withDoctorAudit(
  run: (
    state: OpenClawTestState,
    audit: AuditMigrationFixture,
    migrate: () => ReturnType<typeof autoMigrateLegacyState>,
  ) => Promise<void>,
) {
  await withOpenClawTestState({ label: "audit-skip" }, async (state) => {
    const cfg = { plugins: { enabled: false } };
    await state.writeConfig(cfg);
    await run(state, new AuditMigrationFixture(state.stateDir), () =>
      autoMigrateLegacyState({
        cfg,
        doctorOnlyStateMigrations: true,
        env: state.env,
        homedir: () => state.home,
        legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
      }),
    );
  });
}

const seedApprovals = (state: OpenClawTestState) =>
  state.writeJson("exec-approvals.json", {
    version: 1,
    defaults: { security: "allowlist", ask: "on-miss" },
    agents: {},
  });
const receipt = (result: Awaited<ReturnType<typeof autoMigrateLegacyState>>, id: string) =>
  result.stepReceipts.find((entry) => entry.id === id);
async function expectContinued(
  result: Awaited<ReturnType<typeof autoMigrateLegacyState>>,
  file: string,
) {
  expect(() => throwIfDoctorStateMigrationRefused(result.stepReceipts)).not.toThrow();
  expect(receipt(result, "exec-approvals")).toMatchObject({ outcome: "completed" });
  await expect(fs.access(file)).rejects.toMatchObject({ code: "ENOENT" });
}

it.each([
  ["checkpointless whitespace", "checkpointless raw archive begins with ambiguous whitespace"],
  ["checkpoint capacity", "durable raw-archive checkpoint capacity is exhausted"],
  ["hard links unavailable", "filesystem rejects native no-replace rename and hard links"],
])("continues later repairs after %s and preserves recovery inputs", (shape, warning) =>
  withDoctorAudit(async (state, audit, migrate) => {
    const { source, raw, sanitized } = audit.config;
    const record = configAuditRecord("***");
    let preservedPath = raw;
    if (shape === "checkpointless whitespace") {
      await audit.seedRawArchive(audit.config, buildAuditScrubbedContent(512));
      await audit.writeJsonLines(
        sanitized,
        Array.from({ length: 45 }, () => record),
      );
    } else if (shape === "checkpoint capacity") {
      await audit.writeJsonLines(source, [record]);
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
      await audit.writeJsonLines(source, [record]);
      preservedPath = source;
    } else {
      await audit.writeJsonLines(source, [record]);
      preservedPath = source;
      failAuditMove(audit, source);
    }
    const sourceBytes = await fs.readFile(preservedPath);
    const sanitizedBytes =
      shape === "hard links unavailable" ? undefined : await fs.readFile(sanitized);
    const execPath = await seedApprovals(state);

    const result = await migrate();

    expect(receipt(result, "audit-logs")).toMatchObject({
      outcome: "skipped",
      changes: [],
      warnings: [expect.stringContaining(warning)],
    });
    const warnings = result.warnings.join("\n");
    expect(warnings).toContain(warning);
    if (shape === "hard links unavailable") {
      expect(warnings).toContain(source);
      expect(warnings).toContain("OPENCLAW_STATE_DIR=");
      expect(warnings).toContain(state.stateDir);
      expect(warnings).toContain("openclaw doctor --fix");
    } else {
      expect(warnings).toContain("https://docs.openclaw.ai/cli/update/repair-and-recovery");
    }
    await expectContinued(result, execPath);
    expect(
      openOpenClawStateDatabase({ env: state.env })
        .db.prepare(
          "SELECT default_security FROM exec_approvals_config WHERE config_key = 'current'",
        )
        .get()?.default_security,
    ).toBe("allowlist");
    const repeated = await migrate();
    expect(receipt(repeated, "audit-logs")?.outcome).toBe("skipped");
    expect(repeated.warnings.join("\n")).toContain(warning);
    expect(() => throwIfDoctorStateMigrationRefused(repeated.stepReceipts)).not.toThrow();
    await expect(fs.readFile(preservedPath)).resolves.toEqual(sourceBytes);
    if (sanitizedBytes) {
      await expect(fs.readFile(sanitized)).resolves.toEqual(sanitizedBytes);
    } else {
      await expect(fs.access(sanitized)).rejects.toMatchObject({ code: "ENOENT" });
    }
  }),
);

it.each([
  "rewritten",
  "malformed rewrite",
  "empty",
  "checkpointless empty",
  "append-only",
  "missing",
])("preserves migrated history and continues Doctor after a %s raw archive", (shape) =>
  withDoctorAudit(async (state, audit, migrate) => {
    const { source, raw: rawPath, sanitized: sanitizedPath } = audit.config;
    const directory = path.dirname(rawPath);
    const records = [0, 1, 2].map((index) =>
      configAuditRecord("***", { ts: `2026-07-01T00:00:0${index}.000Z` }),
    );
    if (shape === "checkpointless empty") {
      await audit.writeJsonLines(sanitizedPath, records);
      await audit.write(rawPath, "");
    } else {
      await audit.writeJsonLines(source, records);
      expect((await audit.migrate()).warnings).toEqual([]);
    }
    const sanitized = await fs.readFile(sanitizedPath);
    const retained = audit.configRecords();
    const backup = `${rawPath}.bak`;
    await audit.write(backup, " \t\n");
    await audit.write(`${source}.bak`, sanitized);
    if (shape === "rewritten") {
      await audit.writeJsonLines(rawPath, records.slice(1));
    } else if (shape === "malformed rewrite") {
      await audit.write(rawPath, "{bad json\n");
    } else if (shape === "empty") {
      await audit.write(rawPath, "");
    } else if (shape === "append-only") {
      await audit.appendJsonLines(rawPath, [records[0]]);
    } else if (shape === "missing") {
      await fs.rm(rawPath);
    }
    const raw = shape === "missing" ? undefined : await fs.readFile(rawPath);
    const execPath = await seedApprovals(state);

    const result = await migrate();

    await expectContinued(result, execPath);
    const quarantines = (await fs.readdir(directory)).filter((name) =>
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
      const quarantined = path.join(directory, quarantines[0]!);
      expect(result.warnings).toEqual([expect.stringContaining(quarantined)]);
      expect(result.warnings[0]).toContain("expected append-only growth");
      await expect(fs.readFile(quarantined)).resolves.toEqual(raw);
      await expect(fs.access(rawPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(audit.configRecords()).toEqual(retained);
      await expect(fs.readFile(sanitizedPath)).resolves.toEqual(sanitized);
    }
    await expect(fs.readFile(backup, "utf8")).resolves.toBe(" \t\n");
    await expect(fs.readFile(`${source}.bak`)).resolves.toEqual(sanitized);
    expect((await migrate()).warnings).toEqual([]);
  }),
);

it("keeps an unsafe interrupted recovery refusing alongside an independent skip", () =>
  withDoctorAudit(async (_state, audit, migrate) => {
    await audit.seedRawArchive(audit.config, buildAuditScrubbedContent(512));
    const original = `${JSON.stringify(systemAuditEvent("original archive"))}\n`;
    const changed = original.replace("original archive", " ".repeat(16));
    await audit.seedRawArchive(audit.system, changed);
    await writeAuditRestoreJournal(audit.system.raw, Buffer.from(original));

    const result = await migrate();

    expect(result.warnings.join("\n")).toContain("ambiguous whitespace");
    expect(result.warnings.join("\n")).toContain("no longer matches its restore journal target");
    expect(receipt(result, "audit-logs")?.outcome).toBe("refused");
    expect(() => throwIfDoctorStateMigrationRefused(result.stepReceipts)).toThrow("Doctor stopped");
    await expect(fs.readFile(audit.system.raw, "utf8")).resolves.toBe(changed);
    await fs.access(audit.system.restore);
  }));
