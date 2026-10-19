import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import { replaceSessionEntrySync } from "../../../config/sessions/session-accessor.js";
import { resolveCronDeliveryPreview } from "../../../cron/delivery-preview.js";
import { makeCronJob } from "../../../cron/delivery.test-helpers.js";
import * as stores from "../../../cron/store.js";
import { cronStoreKey } from "../../../cron/store/key.js";
import type { CronJob } from "../../../cron/types.js";
import { buildUpdateRehearsalPathEnv } from "../../../infra/update-rehearsal-paths.js";
import { buildUpdateDoctorEnv } from "../../../infra/update-runner-doctor.js";
import * as stateDb from "../../../state/openclaw-state-db.js";
import { withEnvAsync } from "../../../test-utils/env.js";
import * as testState from "../../../test-utils/openclaw-test-state.js";
import { collectLegacyCronStoreHealthFindings, maybeRepairLegacyCronStore } from "./index.js";
import * as repairs from "./legacy-repair.js";
import { archiveLegacyCronFile } from "./quarantine-archive.js";

const noteMock = vi.hoisted(() => vi.fn<(message: string, title?: string) => void>());
vi.mock("../../../../packages/terminal-core/src/note.js", () => ({ note: noteMock }));
afterEach(() => noteMock.mockClear());

function job(id: string, overrides: Partial<CronJob> = {}): CronJob {
  return makeCronJob({
    id,
    name: id,
    createdAtMs: 1,
    updatedAtMs: 1,
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "run" },
    ...overrides,
  });
}

function cronFixture(fixture: testState.OpenClawTestState, folder: string) {
  const storePath = fixture.statePath(folder, "jobs.json");
  const cfg = { cron: { store: storePath } };
  const inspect = async () => {
    const state = await repairs.loadLegacyCronRepairState({ cfg, storePath });
    return { cfg, state: expectDefined(state, "repair state") };
  };
  return {
    fixture,
    storePath,
    cfg,
    inspect,
    key: cronStoreKey(storePath),
    quarantine: fixture.statePath(folder, "jobs-quarantine.json"),
    save: (...jobs: CronJob[]) => stores.saveCronStore(storePath, { version: 1, jobs }),
    jobs: async () => (await stores.loadCronStore(storePath)).jobs,
    repair: async () => repairs.applyLegacyCronStoreRepair(await inspect()),
    startup: () => repairs.repairLegacyCronStoreWithoutPrompt({ cfg }),
  };
}
const withStore = (run: (s: ReturnType<typeof cronFixture>) => Promise<void>, folder = "cron") =>
  testState.withOpenClawTestState({ label: "doctor-cron-repair" }, (fixture) =>
    run(cronFixture(fixture, folder)),
  );
const expectMissing = (file: string) =>
  expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
const quarantineEntry = (id: string, fields: Record<string, unknown> = {}) => ({
  sourceIndex: 0,
  reason: "invalid-schedule",
  job: { id },
  ...fields,
});
const updateDoctorEnv = {
  ...buildUpdateDoctorEnv({
    allowGatewayServiceRepair: false,
    allowGatewayActivation: false,
    serviceRepairPolicy: "external",
    deferConfiguredPluginInstallRepair: true,
  }),
  OPENCLAW_COMPATIBILITY_HOST_VERSION: undefined,
};

it("leaves canonical one-shot jobs untouched without a SQLite repair backup", () =>
  withStore(async (s) => {
    const canonical = job("canonical-at", {
      schedule: { kind: "at", at: "2026-04-01T10:00:00.000Z" },
      sessionTarget: "main",
      payload: { kind: "systemEvent", text: "tick" },
    });
    await s.save(canonical);
    expect(await s.repair()).toEqual({ changes: [], warnings: [] });
    expect(await s.jobs()).toEqual([canonical]);
    const files = await fs.readdir(s.fixture.statePath("state"));
    expect(files.filter((name) => name.includes(".doctor-cron-"))).toEqual([]);
  }));

it("rehearses quarantine import without consuming the live source before activation", () =>
  withStore(async (s) => {
    const entry = quarantineEntry("recoverable", { quarantinedAtMs: 1 });
    const source = JSON.stringify({ version: 1, jobs: [entry] });
    await fs.mkdir(path.dirname(s.quarantine), { recursive: true });
    await fs.writeFile(s.quarantine, source);
    const rehearsalRoot = s.fixture.path("rehearsal");
    await fs.mkdir(rehearsalRoot);
    await withEnvAsync(
      { ...buildUpdateRehearsalPathEnv(rehearsalRoot), ...updateDoctorEnv },
      async () => {
        try {
          expect((await s.startup()).warnings).toEqual([
            expect.stringContaining("Update rehearsal retained"),
          ]);
          expect(await fs.readFile(s.quarantine, "utf8")).toBe(source);
          await expectMissing(s.quarantine + ".migrated");
          expect(await stores.loadCronQuarantinedJobs(s.storePath)).toEqual([entry]);
        } finally {
          await stateDb.closeOpenClawStateDatabaseAsync();
        }
      },
    );
    await withEnvAsync(updateDoctorEnv, async () => {
      expect((await s.startup()).warnings).toEqual([]);
      expect(await stores.loadCronQuarantinedJobs(s.storePath)).toEqual([entry]);
      await expectMissing(s.quarantine);
      expect(await fs.readFile(s.quarantine + ".migrated", "utf8")).toBe(source);
    });
  }, "custom-cron"));

it("retains an uncopied quarantine reached through a rehearsal symlink", () =>
  withStore(async (s) => {
    const rehearsalRoot = s.fixture.path("rehearsal");
    const source = s.fixture.path("operator", "jobs-quarantine.json");
    const linked = path.join(rehearsalRoot, "cron", "jobs-quarantine.json");
    await fs.mkdir(path.dirname(source), { recursive: true });
    await fs.mkdir(path.dirname(linked), { recursive: true });
    await fs.writeFile(source, "retained operator bytes\n");
    await fs.symlink(source, linked, "file");
    await withEnvAsync(
      { ...buildUpdateRehearsalPathEnv(rehearsalRoot), ...updateDoctorEnv },
      async () => {
        const archived = await archiveLegacyCronFile(linked);
        expect(archived).toMatchObject({ ok: false, deferred: true });
        expect((await fs.lstat(linked)).isSymbolicLink()).toBe(true);
        expect(await fs.readFile(linked, "utf8")).toBe("retained operator bytes\n");
        await expectMissing(linked + ".migrated");
        await expectMissing(source + ".migrated");
      },
    );
  }));

it("preserves current-session delivery through SQLite repair and reload", () =>
  withStore(async (s) => {
    const current = job("current-source", {
      agentId: "main",
      enabled: false,
      sessionTarget: "current",
      sessionKey: "agent:main:dashboard:source",
      delivery: { mode: "announce" },
      state: { consecutiveErrors: 2 },
    });
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: current.sessionKey! },
      { sessionId: "current-source", updatedAt: 1 },
    );
    await s.save(current);
    const repaired = await s.repair();
    const reloaded = (await s.jobs())[0]!;
    expect(repaired.warnings).toEqual([]);
    expect(repaired.changes).not.toEqual([]);
    // The missing anchor forces a write even when the target is canonical.
    expect(reloaded).toMatchObject({
      ...current,
      schedule: { ...current.schedule, anchorMs: current.createdAtMs },
    });
    await expect(resolveCronDeliveryPreview({ cfg: s.cfg, job: reloaded })).resolves.toEqual({
      label: "announce -> current session",
      detail: "commits to this conversation (no external channel route)",
    });
  }));

it("refuses to rewrite a row a writer outside this branch's code committed after the snapshot", () =>
  withStore(async (s) => {
    await s.save({ ...job("job-a"), notify: true } as CronJob);
    const snapshot = await s.inspect();
    stateDb
      .openOpenClawStateDatabase()
      .db.prepare(
        "INSERT INTO cron_jobs (store_key, job_id, name, enabled, payload_kind, job_json, state_json, sort_order, updated_at) VALUES (?, ?, ?, 1, 'agentTurn', ?, '{}', 1, 1)",
      )
      .run(s.key, "job-c", "job-c", JSON.stringify(job("job-c")));
    expect((await repairs.applyLegacyCronStoreRepair(snapshot)).warnings).toEqual([
      expect.stringContaining("changed while doctor was waiting"),
    ]);
    expect((await s.jobs()).map((entry) => entry.id)).toEqual(["job-a", "job-c"]);
  }));

it("retains the legacy quarantine file when a native batch is rejected", () =>
  withStore(async (s) => {
    await s.save();
    const entries = [
      quarantineEntry("first-row", { quarantinedAtMs: 123 }),
      quarantineEntry("blocked-row", { quarantinedAtMs: 456, sourceIndex: 1 }),
    ];
    const source = JSON.stringify({ version: 1, jobs: entries });
    await fs.mkdir(path.dirname(s.quarantine), { recursive: true });
    await fs.writeFile(s.quarantine, source);
    const database = stateDb.openOpenClawStateDatabase().db;
    database.exec(
      "\n    CREATE TRIGGER reject_cron_quarantine BEFORE INSERT ON diagnostic_events\n    WHEN json_extract(NEW.payload_json, '$.job.id') = 'blocked-row'\n    BEGIN SELECT RAISE(ABORT, 'quarantine registration rejected'); END\n  ",
    );
    try {
      expect((await s.repair()).warnings).toEqual([
        expect.stringContaining("quarantine registration rejected"),
      ]);
      expect(await stores.loadCronQuarantinedJobs(s.storePath)).toEqual([]);
      expect(await fs.readFile(s.quarantine, "utf8")).toBe(source);
      await expectMissing(s.quarantine + ".migrated");
    } finally {
      database.exec("DROP TRIGGER reject_cron_quarantine");
    }
    expect((await s.repair()).warnings).toEqual([]);
    expect(await stores.loadCronQuarantinedJobs(s.storePath)).toEqual(entries);
    await expectMissing(s.quarantine);
    await expect(fs.stat(s.quarantine + ".migrated")).resolves.toBeDefined();
  }));

it("does not reactivate quarantined automations during startup repair", () =>
  withStore(async (s) => {
    await s.save();
    await stores.saveCronQuarantinedJobs({
      storePath: s.storePath,
      nowMs: 123,
      entries: [
        quarantineEntry("variant-cron", {
          job: {
            ...job("variant-cron"),
            name: "Variant cron",
            schedule: { kind: " CRON ", expr: "0 9 * * *" },
            sessionTarget: "main",
            payload: { kind: "systemEvent", text: "tick" },
          },
        }),
      ],
    });
    expect(await s.startup()).toEqual({ changes: [], warnings: [] });
    expect(await s.jobs()).toEqual([]);
    expect(await stores.loadCronQuarantinedJobs(s.storePath)).toHaveLength(1);
  }));

it("preserves unknown delivery mode 42 alongside legacy hints", () =>
  withStore(async (s) => {
    const unsupportedJob = (id: string, message: string, delivery: CronJob["delivery"]) =>
      job(id, {
        enabled: false,
        agentId: "ops",
        schedule: { kind: "every", everyMs: 60_000, anchorMs: 1 },
        payload: { kind: "agentTurn", message, toolsAllow: [] },
        delivery,
      });
    const delivery = { mode: "announce" as const, channel: "telegram", to: "synthetic-target" };
    await s.save(
      unsupportedJob("sqlite-job", "synthetic unknown delivery", { mode: "none" }),
      unsupportedJob("repairable-sibling", "repair supported sibling", delivery),
    );
    const db = stateDb.openOpenClawStateDatabase().db;
    db.prepare(
      "UPDATE cron_jobs SET job_json = json_set(job_json, '$.delivery.mode', json(?), '$.isolation', json(?)) WHERE store_key = ? AND job_id = 'sqlite-job'",
    ).run(JSON.stringify(42), JSON.stringify({ legacy: "retain me" }), s.key);
    db.prepare(
      "UPDATE cron_jobs SET job_json = json_remove(job_json, '$.delivery.mode') WHERE store_key = ? AND job_id = 'repairable-sibling'",
    ).run(s.key);
    db.prepare(
      "UPDATE cron_jobs SET job_json = json_set(job_json, '$.notify', json('true'), '$.payload.deliver', json('true'), '$.payload.channel', 'telegram') WHERE store_key = ? AND job_id = 'sqlite-job'",
    ).run(s.key);
    const query = (id: string) =>
      db.prepare("SELECT * FROM cron_jobs WHERE store_key = ? AND job_id = ?").get(s.key, id);
    const before = query("sqlite-job");
    const cfg = { cron: { store: s.storePath, webhook: "https://example.invalid/cron-finished" } };
    expect(await collectLegacyCronStoreHealthFindings({ cfg })).toContainEqual(
      expect.objectContaining({
        requirement: "cron-delivery-mode-valid",
        message: expect.stringContaining("unsupported delivery mode"),
      }),
    );
    const prompter = { confirm: vi.fn().mockResolvedValue(true) };
    await maybeRepairLegacyCronStore({ cfg, options: {}, prompter });
    expect(noteMock).toHaveBeenCalledWith(
      expect.stringContaining("Unsupported cron delivery modes were left unchanged"),
      "Cron",
    );
    expect(query("sqlite-job")).toEqual(before);
    expect(prompter.confirm).toHaveBeenCalledOnce();
    const sibling = query("repairable-sibling");
    expect(JSON.parse(String(sibling?.job_json)).delivery).toEqual(delivery);
    expect(noteMock).not.toHaveBeenCalledWith(
      expect.stringContaining("Failed writing migrated cron store"),
      "Doctor warnings",
    );
  }));

it("leaves a newly appeared JSON source for the next Doctor migration", () =>
  withStore(async (s) => {
    await s.fixture.writeJson("cron/jobs-quarantine.json", {
      version: 1,
      jobs: [{ reason: "invalid-schedule", job: { id: "quarantined" } }],
    });
    await maybeRepairLegacyCronStore({
      cfg: s.cfg,
      options: {},
      prompter: {
        confirm: async () => {
          await fs.writeFile(s.storePath, "new retired source");
          return true;
        },
      },
    });
    expect(await fs.readFile(s.storePath, "utf8")).toBe("new retired source");
    expect(await stores.loadCronQuarantinedJobs(s.storePath)).toHaveLength(1);
    await expectMissing(s.quarantine);
  }));

it("preserves a broken retired cron source link and refuses repair", () =>
  withStore(async (s) => {
    const missingTarget = s.fixture.path("missing-operator-cron.json");
    await fs.mkdir(path.dirname(s.storePath), { recursive: true });
    await fs.symlink(missingTarget, s.storePath, "file");
    await expect(s.startup()).rejects.toThrow(/symlink/i);
    expect((await fs.lstat(s.storePath)).isSymbolicLink()).toBe(true);
    expect(await fs.readlink(s.storePath)).toBe(missingTarget);
    await expectMissing(s.storePath + ".migrated");
  }));
