import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import { replaceSessionEntrySync } from "../../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { resolveCronDeliveryPreview } from "../../../cron/delivery-preview.js";
import * as cronStore from "../../../cron/store.js";
import {
  loadCronQuarantinedJobs,
  loadCronStore,
  saveCronQuarantinedJobs,
  saveCronStore,
} from "../../../cron/store.js";
import { cronStoreKey } from "../../../cron/store/key.js";
import { makeCronStreamSandboxTarget } from "../../../cron/stream-sandbox.test-support.js";
import type { CronJob } from "../../../cron/types.js";
import { buildUpdateRehearsalPathEnv } from "../../../infra/update-rehearsal-paths.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../../../state/openclaw-state-db.js";
import { withEnvAsync } from "../../../test-utils/env.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../../test-utils/openclaw-test-state.js";
import { externalDoctorEnv } from "../../doctor-update.test-support.js";
import { collectLegacyCronStoreHealthFindings, maybeRepairLegacyCronStore } from "./index.js";
import {
  applyLegacyCronStoreRepair,
  loadLegacyCronRepairState,
  repairLegacyCronStoreWithoutPrompt,
} from "./legacy-repair.js";
import { archiveLegacyCronFile } from "./quarantine-archive.js";

const noteMock = vi.hoisted(() => vi.fn<(message: string, title?: string) => void>());

vi.mock("../../../../packages/terminal-core/src/note.js", () => ({
  note: noteMock,
}));

const withState = (run: (state: OpenClawTestState) => Promise<void>) => () =>
  withOpenClawTestState({ label: "cron-repair" }, run);
afterEach(() => {
  vi.unstubAllEnvs();
  noteMock.mockClear();
});

function job(id: string, overrides: Partial<CronJob> = {}): CronJob {
  return {
    id,
    name: id,
    enabled: true,
    createdAtMs: 1,
    updatedAtMs: 1,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "agentTurn", message: "run" },
    state: {},
    ...overrides,
  };
}

async function loadRepairStateForStore(storePath: string) {
  const cfg = { cron: { store: storePath } } as OpenClawConfig;
  const state = expectDefined(
    await loadLegacyCronRepairState({ cfg, storePath }),
    `repair state for ${storePath}`,
  );
  return { cfg, state };
}
const saveJobs = (storePath: string, ...jobs: CronJob[]) =>
  saveCronStore(storePath, { version: 1, jobs });
const readJobs = async (storePath: string) => (await loadCronStore(storePath)).jobs;
const expectMissing = (file: string) =>
  expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
const repair = (storePath: string) =>
  repairLegacyCronStoreWithoutPrompt({ cfg: { cron: { store: storePath } } as OpenClawConfig });

const updateDoctorEnv = {
  ...externalDoctorEnv(),
  OPENCLAW_COMPATIBILITY_HOST_VERSION: undefined,
};

it(
  "leaves canonical one-shot jobs untouched without a SQLite repair backup",
  withState(async (fixture) => {
    const storePath = fixture.statePath("cron", "jobs.json");
    const canonical: CronJob = {
      ...job("canonical-at"),
      schedule: { kind: "at", at: "2026-04-01T10:00:00.000Z" },
      sessionTarget: "main",
      payload: { kind: "systemEvent", text: "tick" },
    };
    await saveJobs(storePath, canonical);
    const { cfg, state } = await loadRepairStateForStore(storePath);

    expect(await applyLegacyCronStoreRepair({ cfg, state })).toEqual({ changes: [], warnings: [] });
    expect(await readJobs(storePath)).toEqual([canonical]);
    expect(
      (await fs.readdir(fixture.statePath("state"))).filter((name) =>
        name.includes(".doctor-cron-"),
      ),
    ).toEqual([]);
  }),
);

it(
  "rehearses quarantine import without consuming the live source before activation",
  withState(async (state) => {
    const storePath = state.statePath("custom-cron", "jobs.json");
    const quarantinePath = state.statePath("custom-cron", "jobs-quarantine.json");
    const cfg = { cron: { store: storePath } } as OpenClawConfig;
    const entry = {
      sourceIndex: 0,
      reason: "invalid-schedule",
      job: { id: "recoverable" },
      quarantinedAtMs: 1,
    };
    const source = JSON.stringify({ version: 1, jobs: [entry] });
    await fs.mkdir(path.dirname(quarantinePath), { recursive: true });
    await fs.writeFile(quarantinePath, source);
    const rehearsalRoot = state.path("rehearsal");
    await fs.mkdir(rehearsalRoot);
    await withEnvAsync(
      { ...buildUpdateRehearsalPathEnv(rehearsalRoot), ...updateDoctorEnv },
      async () => {
        try {
          const repaired = await repairLegacyCronStoreWithoutPrompt({ cfg });
          expect(await fs.readFile(quarantinePath, "utf8")).toBe(source);
          await expectMissing(`${quarantinePath}.migrated`);
          expect(repaired.warnings).toEqual([expect.stringContaining("Update rehearsal retained")]);
          expect(await loadCronQuarantinedJobs(storePath)).toEqual([entry]);
        } finally {
          await closeOpenClawStateDatabaseAsync();
        }
      },
    );
    await withEnvAsync(updateDoctorEnv, async () => {
      expect((await repairLegacyCronStoreWithoutPrompt({ cfg })).warnings).toEqual([]);
      expect(await loadCronQuarantinedJobs(storePath)).toEqual([entry]);
      await expectMissing(quarantinePath);
      expect(await fs.readFile(`${quarantinePath}.migrated`, "utf8")).toBe(source);
    });
  }),
);

it("retains an uncopied quarantine reached through a rehearsal symlink", async () => {
  const relative = "jobs-quarantine.json";
  await withOpenClawTestState({ label: "cron-rehearsal-companion" }, async (state) => {
    const rehearsalRoot = state.path("rehearsal");
    const source = state.path("operator", relative);
    const linked = path.join(rehearsalRoot, "cron", relative);
    await fs.mkdir(path.dirname(source), { recursive: true });
    await fs.mkdir(path.join(rehearsalRoot, "cron"), { recursive: true });
    await fs.writeFile(source, "retained operator bytes\n");
    await fs.symlink(source, linked, "file");
    await withEnvAsync(
      { ...buildUpdateRehearsalPathEnv(rehearsalRoot), ...updateDoctorEnv },
      async () => {
        await expect(archiveLegacyCronFile(linked)).resolves.toMatchObject({
          ok: false,
          deferred: true,
        });
        expect((await fs.lstat(linked)).isSymbolicLink()).toBe(true);
        expect(await fs.readFile(linked, "utf8")).toBe("retained operator bytes\n");
        await expectMissing(`${linked}.migrated`);
        await expectMissing(`${source}.migrated`);
      },
    );
  });
});

it(
  "preserves current-session delivery through SQLite repair and reload",
  withState(async (fixture) => {
    const storePath = fixture.statePath("cron", "jobs.json");
    const current: CronJob = {
      ...job("current-source"),
      agentId: "main",
      enabled: false,
      sessionTarget: "current",
      sessionKey: "agent:main:dashboard:source",
      delivery: { mode: "announce" },
      state: { consecutiveErrors: 2 },
    };
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: current.sessionKey! },
      { sessionId: "current-source", updatedAt: 1 },
    );
    const sandbox = {
      ...job("sandbox-source"),
      schedule: { kind: "stream" as const, command: ["watch-source"] },
      streamSandbox: makeCronStreamSandboxTarget(),
    };
    await saveJobs(storePath, current, sandbox);
    const { cfg, state } = await loadRepairStateForStore(storePath);

    const repaired = await applyLegacyCronStoreRepair({ cfg, state });
    const [reloaded, reloadedSandbox] = await readJobs(storePath);

    expect(repaired.warnings).toEqual([]);
    expect(repaired.changes).not.toEqual([]);
    // Adding the missing anchor forces a real write even when the target is canonical.
    expect(reloaded).toMatchObject({
      ...current,
      schedule: { ...current.schedule, anchorMs: current.createdAtMs },
    });
    await expect(resolveCronDeliveryPreview({ cfg, job: reloaded! })).resolves.toEqual({
      label: "announce -> current session",
      detail: "commits to this conversation (no external channel route)",
    });
    expect(reloadedSandbox).toMatchObject(sandbox);
  }),
);

it(
  "refuses to rewrite a row a writer outside this branch's code committed after the snapshot",
  withState(async (fixture) => {
    const storePath = fixture.statePath("cron", "jobs.json");
    await saveJobs(storePath, { ...job("job-a"), notify: true } as CronJob);
    const { cfg, state } = await loadRepairStateForStore(storePath);
    openOpenClawStateDatabase()
      .db.prepare(
        `INSERT INTO cron_jobs (store_key, job_id, name, enabled, payload_kind, job_json, state_json, sort_order, updated_at)
       VALUES (?, ?, ?, 1, 'agentTurn', ?, '{}', 1, 1)`,
      )
      .run(cronStoreKey(storePath), "job-c", "job-c", JSON.stringify(job("job-c")));

    const result = await applyLegacyCronStoreRepair({ cfg, state });

    expect(result.warnings).toEqual([expect.stringContaining("changed while doctor was waiting")]);
    expect((await readJobs(storePath)).map((entry) => entry.id)).toEqual(["job-a", "job-c"]);
  }),
);

it(
  "retains the legacy quarantine file when a native batch is rejected",
  withState(async (fixture) => {
    const storePath = fixture.statePath("cron", "jobs.json");
    const quarantinePath = storePath.replace(/\.json$/, "-quarantine.json");
    await saveJobs(storePath);
    const entries = [
      {
        quarantinedAtMs: 123,
        sourceIndex: 0,
        reason: "invalid-schedule",
        job: { id: "first-row" },
      },
      {
        quarantinedAtMs: 456,
        sourceIndex: 1,
        reason: "invalid-schedule",
        job: { id: "blocked-row" },
      },
    ];
    const source = JSON.stringify({ version: 1, jobs: entries });
    await fs.mkdir(path.dirname(quarantinePath), { recursive: true });
    await fs.writeFile(quarantinePath, source);
    const database = openOpenClawStateDatabase().db;
    database.exec(`
    CREATE TRIGGER reject_cron_quarantine BEFORE INSERT ON diagnostic_events
    WHEN json_extract(NEW.payload_json, '$.job.id') = 'blocked-row'
    BEGIN SELECT RAISE(ABORT, 'quarantine registration rejected'); END
  `);
    try {
      const result = await applyLegacyCronStoreRepair(await loadRepairStateForStore(storePath));
      expect(result.warnings).toEqual([
        expect.stringContaining("quarantine registration rejected"),
      ]);
      expect(await loadCronQuarantinedJobs(storePath)).toEqual([]);
      expect(await fs.readFile(quarantinePath, "utf8")).toBe(source);
      await expectMissing(`${quarantinePath}.migrated`);
    } finally {
      database.exec("DROP TRIGGER reject_cron_quarantine");
    }

    const repaired = await applyLegacyCronStoreRepair(await loadRepairStateForStore(storePath));
    expect(repaired.warnings).toEqual([]);
    expect(await loadCronQuarantinedJobs(storePath)).toEqual(entries);
    await expectMissing(quarantinePath);
    await expect(fs.stat(`${quarantinePath}.migrated`)).resolves.toBeDefined();
  }),
);

it(
  "does not reactivate quarantined automations during startup repair",
  withState(async (fixture) => {
    const storePath = fixture.statePath("cron", "jobs.json");
    await saveJobs(storePath);
    await saveCronQuarantinedJobs({
      storePath,
      nowMs: 123,
      entries: [
        {
          sourceIndex: 0,
          reason: "invalid-schedule",
          job: {
            ...job("variant-cron"),
            name: "Variant cron",
            schedule: { kind: " CRON ", expr: "0 9 * * *" },
            sessionTarget: "main",
            payload: { kind: "systemEvent", text: "tick" },
          },
        },
      ],
    });
    const result = await repair(storePath);

    expect(result).toEqual({ changes: [], warnings: [] });
    expect(await readJobs(storePath)).toEqual([]);
    expect(await loadCronQuarantinedJobs(storePath)).toHaveLength(1);
  }),
);

it(
  "preserves unknown delivery mode 42 alongside legacy hints",
  withState(async (state) => {
    const storePath = state.statePath("cron", "jobs.json");
    const deliveryJob = (id: string, message: string, delivery: CronJob["delivery"]): CronJob => ({
      ...job(id),
      enabled: false,
      agentId: "ops",
      schedule: { kind: "every", everyMs: 60_000, anchorMs: 1 },
      payload: { kind: "agentTurn", message, toolsAllow: [] },
      delivery,
    });
    await saveJobs(
      storePath,
      deliveryJob("sqlite-job", "synthetic unknown delivery", { mode: "none" }),
      deliveryJob("repairable-sibling", "repair supported sibling", {
        mode: "announce",
        channel: "telegram",
        to: "synthetic-target",
      }),
    );
    const db = openOpenClawStateDatabase().db;
    db.prepare(
      "UPDATE cron_jobs SET job_json = json_set(job_json, '$.delivery.mode', json(?), '$.isolation', json(?)) WHERE store_key = ? AND job_id = 'sqlite-job'",
    ).run(JSON.stringify(42), JSON.stringify({ legacy: "retain me" }), cronStoreKey(storePath));
    db.prepare(
      "UPDATE cron_jobs SET job_json = json_remove(job_json, '$.delivery.mode') WHERE store_key = ? AND job_id = 'repairable-sibling'",
    ).run(cronStoreKey(storePath));
    db.prepare(
      "UPDATE cron_jobs SET job_json = json_set(job_json, '$.notify', json('true'), '$.payload.deliver', json('true'), '$.payload.channel', 'telegram') WHERE store_key = ? AND job_id = 'sqlite-job'",
    ).run(cronStoreKey(storePath));
    const readRows = () =>
      db
        .prepare("SELECT * FROM cron_jobs WHERE store_key = ? AND job_id = 'sqlite-job'")
        .all(cronStoreKey(storePath));
    const before = readRows();
    const cfg = {
      cron: { store: storePath, webhook: "https://example.invalid/cron-finished" },
    } as OpenClawConfig;
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
    expect(readRows()).toEqual(before);
    const sibling = db
      .prepare(
        "SELECT job_json FROM cron_jobs WHERE store_key = ? AND job_id = 'repairable-sibling'",
      )
      .get(cronStoreKey(storePath));
    expect(JSON.parse(String(sibling?.job_json)).delivery).toEqual({
      mode: "announce",
      channel: "telegram",
      to: "synthetic-target",
    });
  }),
);

it(
  "leaves a newly appeared JSON source for the next Doctor migration",
  withState(async (state) => {
    const storePath = state.statePath("cron", "jobs.json");
    const quarantinePath = await state.writeJson("cron/jobs-quarantine.json", {
      version: 1,
      jobs: [{ reason: "invalid-schedule", job: { id: "quarantined" } }],
    });
    await maybeRepairLegacyCronStore({
      cfg: { cron: { store: storePath } } as OpenClawConfig,
      options: {},
      prompter: {
        confirm: async () => {
          await fs.writeFile(storePath, "new retired source");
          return true;
        },
      },
    });
    expect(await fs.readFile(storePath, "utf8")).toBe("new retired source");
    expect(await loadCronQuarantinedJobs(storePath)).toHaveLength(1);
    await expectMissing(quarantinePath);
  }),
);

it(
  "preserves a broken retired cron source link and refuses repair",
  withState(async (state) => {
    const storePath = state.statePath("cron", "jobs.json");
    const missingTarget = state.path("missing-operator-cron.json");
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.symlink(missingTarget, storePath, "file");

    await expect(repair(storePath)).rejects.toThrow(/symlink/i);

    expect(await fs.readlink(storePath)).toBe(missingTarget);
    await expectMissing(`${storePath}.migrated`);
  }),
);

const legacyJob = (overrides: Partial<CronJob> = {}) =>
  job("legacy", {
    name: "Legacy",
    sessionTarget: "main",
    payload: { kind: "systemEvent", text: "keep me" },
    ...overrides,
  });

it(
  "imports pre-July cron jobs and runtime state, preserves current jobs, and archives all history",
  withState(async (fixture) => {
    const storePath = fixture.statePath("cron", "jobs.json");
    const current = legacyJob({
      id: "current",
      name: "Current definition",
      enabled: false,
      agentId: "main",
      updatedAtMs: 8,
      schedule: { kind: "every", everyMs: 60_000, anchorMs: 1 },
      payload: { kind: "systemEvent", text: "current" },
      state: { lastRunAtMs: 7 },
    });
    await saveCronStore(storePath, { version: 1, jobs: [current] });
    const retained = (await readJobs(storePath))[0];
    const legacy = {
      ...current,
      id: "legacy",
      name: "Legacy definition",
      enabled: true,
      state: {},
    };
    const originals = new Map([
      [
        storePath,
        JSON.stringify({
          version: 1,
          jobs: [
            { ...current, name: "Stale copy" },
            legacy,
            { ...legacy, id: undefined, name: "Idless" },
          ],
        }),
      ],
      [
        fixture.statePath("cron", "jobs-state.json"),
        JSON.stringify({
          version: 1,
          jobs: { legacy: { updatedAtMs: 12, state: { lastRunAtMs: 11, lastStatus: "ok" } } },
        }),
      ],
      [
        fixture.statePath("cron", "runs", "legacy.jsonl"),
        '{"ts":11,"jobId":"legacy","action":"finished","status":"ok"}\n',
      ],
      [fixture.statePath("cron", "runs", "other.jsonl"), "unparseable historical line\n"],
    ]);
    for (const [filePath, bytes] of originals) {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, bytes);
    }
    const result = await repair(storePath);
    const jobs = await readJobs(storePath);
    expect(jobs).toHaveLength(3);
    expect(jobs.find((entry) => entry.id === "current")).toEqual(retained);
    expect(jobs.find((entry) => entry.id === "legacy")).toMatchObject({
      name: "Legacy definition",
      state: { lastRunAtMs: 11, lastStatus: "ok" },
      updatedAtMs: 12,
    });
    expect(jobs.find((entry) => entry.name === "Idless")?.id).toMatch(/^cron-migrated-2-/);
    for (const [filePath, bytes] of originals) {
      expect(await fs.readFile(`${filePath}.migrated`, "utf8")).toBe(bytes);
      await expectMissing(filePath);
      expect(result.warnings.join("\n")).toContain(`${filePath}.migrated`);
    }
    expect(result.warnings.join("\n")).toContain("Historical runs remain readable");
    expect(await repair(storePath)).toEqual({ changes: [], warnings: [] });
    expect(await readJobs(storePath)).toEqual(jobs);
    await fs.writeFile(storePath, originals.get(storePath)!);
    await repair(storePath);
    expect(await readJobs(storePath)).toEqual(jobs);
  }),
);

it.each(["jobs UTF-8", "runtime UTF-8", "jobs JSON"] as const)(
  "archives malformed %s with actionable recovery instead of importing corrupt data",
  (source) =>
    withState(async (fixture) => {
      const legacy = legacyJob({
        name: source === "jobs UTF-8" ? "CORRUPT" : "valid name",
      });
      const storePath = await fixture.writeJson("cron/jobs.json", { version: 1, jobs: [legacy] });
      const runtimePath = await fixture.writeJson("cron/jobs-state.json", {
        version: 1,
        jobs: { legacy: { state: { lastError: "CORRUPT" } } },
      });
      const corruptPath = source === "runtime UTF-8" ? runtimePath : storePath;
      const bytes =
        source === "jobs JSON"
          ? Buffer.from("{truncated legacy definition")
          : Buffer.from(
              (await fs.readFile(corruptPath, "utf8")).replace("CORRUPT", "\x80"),
              "latin1",
            );
      await fs.writeFile(corruptPath, bytes);

      const result = await repair(storePath);

      expect(await fs.readFile(`${corruptPath}.migrated`)).toEqual(bytes);
      await expectMissing(corruptPath);
      const jobs = await readJobs(storePath);
      if (source !== "runtime UTF-8") {
        expect(jobs).toEqual([]);
        if (source === "jobs UTF-8") {
          expect(result.warnings.join("\n")).toContain("must be valid UTF-8");
        }
        expect(result.warnings.join("\n")).toContain(
          `Recover job definitions from ${storePath}.migrated`,
        );
        expect(result.warnings.join("\n")).toContain("openclaw automations add");
      } else {
        expect(jobs).toHaveLength(1);
        expect(jobs[0]?.state.lastError).toBeUndefined();
        expect(result.warnings.join("\n")).toContain("Unrecognized legacy cron runtime state");
      }
    })(),
);

it.each(["load", "commit"])(
  "retains cron sources after a SQLite %s failure and archives only after retry",
  (phase) =>
    withState(async (fixture) => {
      const storePath = await fixture.writeJson("cron/jobs.json", {
        version: 1,
        jobs: [legacyJob()],
      });
      const runtimePath = await fixture.writeJson("cron/jobs-state.json", {
        version: 1,
        jobs: { legacy: { updatedAtMs: 12, state: { lastRunAtMs: 11 } } },
      });
      const originals = await Promise.all(
        [storePath, runtimePath].map(async (file) => [file, await fs.readFile(file)] as const),
      );
      const db = openOpenClawStateDatabase().db;
      const rejection =
        "CREATE TRIGGER reject_legacy_cron BEFORE INSERT ON cron_jobs BEGIN SELECT RAISE(ABORT, 'synthetic cron import failure'); END";
      const save = cronStore.saveCronJobsStore;
      const fault =
        phase === "commit"
          ? vi
              .spyOn(cronStore, "saveCronJobsStore")
              .mockImplementationOnce((target, store, options) =>
                save(target, store, {
                  ...options,
                  transactionHooks: {
                    ...options?.transactionHooks,
                    beforeWrite: (connection, schema) => {
                      options?.transactionHooks?.beforeWrite?.(connection, schema);
                      connection.exec(rejection);
                    },
                  },
                }),
              )
          : undefined;
      if (phase === "load") {
        db.exec(rejection);
      }
      try {
        await expect(repair(storePath)).rejects.toThrow(
          phase === "load"
            ? "unexpected trigger reject_legacy_cron"
            : "synthetic cron import failure",
        );
        for (const [file, bytes] of originals) {
          expect(await fs.readFile(file)).toEqual(bytes);
        }
      } finally {
        fault?.mockRestore();
        if (phase === "load") {
          db.exec("DROP TRIGGER reject_legacy_cron");
        }
      }
      expect(await readJobs(storePath)).toEqual([]);
      await repair(storePath);
      expect(await readJobs(storePath)).toMatchObject([
        { id: "legacy", state: { lastRunAtMs: 11 } },
      ]);
      for (const [file, bytes] of originals) {
        await expectMissing(file);
        expect(await fs.readFile(`${file}.migrated`)).toEqual(bytes);
      }
    })(),
);
