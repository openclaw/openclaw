import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import { replaceSessionEntrySync } from "../../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { resolveCronDeliveryPreview } from "../../../cron/delivery-preview.js";
import {
  loadCronQuarantinedJobs,
  loadCronStore,
  saveCronQuarantinedJobs,
  saveCronStore,
} from "../../../cron/store.js";
import { cronStoreKey } from "../../../cron/store/key.js";
import type { CronJob } from "../../../cron/types.js";
import { buildUpdateRehearsalPathEnv } from "../../../infra/update-rehearsal-paths.js";
import { buildUpdateDoctorEnv } from "../../../infra/update-runner-doctor.js";
import { closeOpenClawAgentDatabasesAsync } from "../../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../../../state/openclaw-state-db.js";
import { withEnvAsync } from "../../../test-utils/env.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
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

let tempRoot: string | undefined;

afterEach(async () => {
  if (tempRoot) {
    await closeOpenClawAgentDatabasesAsync(tempRoot);
  }
  await closeOpenClawStateDatabaseAsync();
  if (tempRoot) {
    await fs.rm(tempRoot, { recursive: true, force: true });
    tempRoot = undefined;
  }
  vi.unstubAllEnvs();
  noteMock.mockClear();
});

it.each<{
  name: string;
  agents: NonNullable<OpenClawConfig["agents"]>;
  agentId?: string;
  expectedOwner: { kind: "runtime-default" | "explicit"; agentId: string };
}>([
  {
    name: "sole configured agent",
    agents: { entries: { ops: {} } },
    expectedOwner: { kind: "runtime-default", agentId: "ops" },
  },
  {
    name: "configured system agent under explicit ownership",
    agents: {
      ownership: "explicit",
      defaults: { systemAgent: { agentId: "ops" } },
      entries: { main: {}, ops: {} },
    },
    expectedOwner: { kind: "runtime-default", agentId: "ops" },
  },
  {
    name: "explicit job owner before the configured system agent",
    agents: {
      ownership: "explicit",
      defaults: { systemAgent: { agentId: "ops" } },
      entries: { main: {}, ops: {} },
    },
    agentId: "main",
    expectedOwner: { kind: "explicit", agentId: "main" },
  },
])(
  "projects the $name without changing the stored owner",
  async ({ agents, agentId, expectedOwner }) => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-owner-projection-"));
    const storePath = path.join(tempRoot, "cron", "jobs.json");
    await saveCronStore(storePath, {
      version: 1,
      jobs: [
        {
          id: "dynamic-default",
          agentId,
          name: "Dynamic default",
          enabled: true,
          createdAtMs: 1,
          updatedAtMs: 1,
          schedule: { kind: "every", everyMs: 60_000 },
          sessionTarget: "isolated",
          wakeMode: "now",
          payload: { kind: "agentTurn", message: "run" },
          state: {},
        },
      ],
    });

    const cfg = {
      cron: { store: storePath },
      agents,
    } as OpenClawConfig;
    const state = await loadLegacyCronRepairState({ cfg, storePath, readOnly: true });

    expect(state?.rawJobs[0]?.agentId).toBe(agentId);
    expect(state?.projectedOwnersByJobId.get("dynamic-default")).toEqual(expectedOwner);
  },
);

function job(id: string): CronJob {
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

const updateDoctorEnv = {
  ...buildUpdateDoctorEnv({
    allowGatewayServiceRepair: false,
    allowGatewayActivation: false,
    serviceRepairPolicy: "external",
    deferConfiguredPluginInstallRepair: true,
  }),
  OPENCLAW_COMPATIBILITY_HOST_VERSION: undefined,
};

it("leaves canonical one-shot jobs untouched without a SQLite repair backup", async () => {
  await withOpenClawTestState({ label: "cron-canonical-at-repair" }, async (fixture) => {
    const storePath = fixture.statePath("cron", "jobs.json");
    const canonical: CronJob = {
      ...job("canonical-at"),
      schedule: { kind: "at", at: "2026-04-01T10:00:00.000Z" },
      sessionTarget: "main",
      payload: { kind: "systemEvent", text: "tick" },
    };
    await saveCronStore(storePath, { version: 1, jobs: [canonical] });
    const { cfg, state } = await loadRepairStateForStore(storePath);

    expect(await applyLegacyCronStoreRepair({ cfg, state })).toEqual({
      changes: [],
      warnings: [],
    });
    expect((await loadCronStore(storePath)).jobs).toEqual([canonical]);
    expect(
      (await fs.readdir(fixture.statePath("state"))).filter((name) =>
        name.includes(".doctor-cron-"),
      ),
    ).toEqual([]);
  });
});

it("rehearses quarantine import without consuming the live source before activation", async () => {
  await withOpenClawTestState({ label: "cron-rehearsal-quarantine" }, async (state) => {
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
          await expect(fs.stat(`${quarantinePath}.migrated`)).rejects.toMatchObject({
            code: "ENOENT",
          });
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
      await expect(fs.stat(quarantinePath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await fs.readFile(`${quarantinePath}.migrated`, "utf8")).toBe(source);
    });
  });
});

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
        await expect(fs.stat(`${linked}.migrated`)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(fs.stat(`${source}.migrated`)).rejects.toMatchObject({ code: "ENOENT" });
      },
    );
  });
});

it("preserves current-session delivery through SQLite repair and reload", async () => {
  tempRoot = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-current-repair-")),
  );
  vi.stubEnv("OPENCLAW_STATE_DIR", tempRoot);
  const storePath = path.join(tempRoot, "cron", "jobs.json");
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
  const store = { version: 1 as const, jobs: [current] };
  await saveCronStore(storePath, store);
  const { cfg, state } = await loadRepairStateForStore(storePath);

  const repaired = await applyLegacyCronStoreRepair({ cfg, state });
  const reloaded = (await loadCronStore(storePath)).jobs[0]!;

  expect(repaired.warnings).toEqual([]);
  expect(repaired.changes).not.toEqual([]);
  // Adding the missing anchor forces a real write even when the target is canonical.
  expect(reloaded).toMatchObject({
    ...current,
    schedule: { ...current.schedule, anchorMs: current.createdAtMs },
  });
  await expect(resolveCronDeliveryPreview({ cfg, job: reloaded })).resolves.toEqual({
    label: "announce -> current session",
    detail: "commits to this conversation (no external channel route)",
  });
});

it("refuses to rewrite a row a writer outside this branch's code committed after the snapshot", async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-repair-mixed-version-"));
  const storePath = path.join(tempRoot, "cron", "jobs.json");
  await saveCronStore(storePath, {
    version: 1,
    jobs: [{ ...job("job-a"), notify: true } as CronJob],
  });
  const { cfg, state } = await loadRepairStateForStore(storePath);
  openOpenClawStateDatabase()
    .db.prepare(
      `INSERT INTO cron_jobs (store_key, job_id, name, enabled, payload_kind, job_json, state_json, sort_order, updated_at)
       VALUES (?, ?, ?, 1, 'agentTurn', ?, '{}', 1, 1)`,
    )
    .run(cronStoreKey(storePath), "job-c", "job-c", JSON.stringify(job("job-c")));

  const result = await applyLegacyCronStoreRepair({ cfg, state });

  expect(result.warnings).toEqual([expect.stringContaining("changed while doctor was waiting")]);
  expect((await loadCronStore(storePath)).jobs.map((entry) => entry.id)).toEqual([
    "job-a",
    "job-c",
  ]);
});

it("retains the legacy quarantine file when a native batch is rejected", async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-quarantine-refusal-"));
  vi.stubEnv("OPENCLAW_STATE_DIR", tempRoot);
  const storePath = path.join(tempRoot, "cron", "jobs.json");
  const quarantinePath = storePath.replace(/\.json$/, "-quarantine.json");
  await saveCronStore(storePath, { version: 1, jobs: [] });
  const entries = [
    { quarantinedAtMs: 123, sourceIndex: 0, reason: "invalid-schedule", job: { id: "first-row" } },
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
    expect(result.warnings).toEqual([expect.stringContaining("quarantine registration rejected")]);
    expect(await loadCronQuarantinedJobs(storePath)).toEqual([]);
    expect(await fs.readFile(quarantinePath, "utf8")).toBe(source);
    await expect(fs.stat(`${quarantinePath}.migrated`)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    database.exec("DROP TRIGGER reject_cron_quarantine");
  }

  const repaired = await applyLegacyCronStoreRepair(await loadRepairStateForStore(storePath));
  expect(repaired.warnings).toEqual([]);
  expect(await loadCronQuarantinedJobs(storePath)).toEqual(entries);
  await expect(fs.stat(quarantinePath)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(fs.stat(`${quarantinePath}.migrated`)).resolves.toBeDefined();
});

it("does not reactivate quarantined automations during startup repair", async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-cron-startup-quarantine-"));
  const storePath = path.join(tempRoot, "cron", "jobs.json");
  vi.stubEnv("OPENCLAW_STATE_DIR", tempRoot);
  await saveCronStore(storePath, { version: 1, jobs: [] });
  await saveCronQuarantinedJobs({
    storePath,
    nowMs: 123,
    entries: [
      {
        sourceIndex: 0,
        reason: "invalid-schedule",
        job: {
          id: "variant-cron",
          name: "Variant cron",
          enabled: true,
          createdAtMs: 1,
          updatedAtMs: 1,
          schedule: { kind: " CRON ", expr: "0 9 * * *" },
          sessionTarget: "main",
          wakeMode: "now",
          payload: { kind: "systemEvent", text: "tick" },
          state: {},
        },
      },
    ],
  });
  const cfg = { cron: { store: storePath } } as OpenClawConfig;

  const result = await repairLegacyCronStoreWithoutPrompt({ cfg });

  expect(result).toEqual({ changes: [], warnings: [] });
  expect((await loadCronStore(storePath)).jobs).toEqual([]);
  expect(await loadCronQuarantinedJobs(storePath)).toHaveLength(1);
});

it.each([
  { mode: "not-a-route", legacyHints: false },
  { mode: 42, legacyHints: true },
])(
  "preserves unknown delivery mode $mode alongside legacy hints=$legacyHints",
  async ({ mode, legacyHints }) => {
    await withOpenClawTestState({ label: "cron-unsupported-delivery" }, async (state) => {
      const storePath = state.statePath("cron", "jobs.json");
      await saveCronStore(storePath, {
        version: 1,
        jobs: [
          {
            ...job("sqlite-job"),
            enabled: false,
            agentId: "ops",
            schedule: { kind: "every", everyMs: 60_000, anchorMs: 1 },
            payload: { kind: "agentTurn", message: "synthetic unknown delivery", toolsAllow: [] },
            delivery: { mode: "none" },
          },
          {
            ...job("repairable-sibling"),
            enabled: false,
            agentId: "ops",
            schedule: { kind: "every", everyMs: 60_000, anchorMs: 1 },
            payload: { kind: "agentTurn", message: "repair supported sibling", toolsAllow: [] },
            delivery: { mode: "announce", channel: "telegram", to: "synthetic-target" },
          },
        ],
      });
      const db = openOpenClawStateDatabase().db;
      db.prepare(
        "UPDATE cron_jobs SET job_json = json_set(job_json, '$.delivery.mode', json(?), '$.isolation', json(?)) WHERE store_key = ? AND job_id = 'sqlite-job'",
      ).run(JSON.stringify(mode), JSON.stringify({ legacy: "retain me" }), cronStoreKey(storePath));
      db.prepare(
        "UPDATE cron_jobs SET job_json = json_remove(job_json, '$.delivery.mode') WHERE store_key = ? AND job_id = 'repairable-sibling'",
      ).run(cronStoreKey(storePath));
      if (legacyHints) {
        db.prepare(
          "UPDATE cron_jobs SET job_json = json_set(job_json, '$.notify', json('true'), '$.payload.deliver', json('true'), '$.payload.channel', 'telegram') WHERE store_key = ? AND job_id = 'sqlite-job'",
        ).run(cronStoreKey(storePath));
      }
      const readRows = () =>
        db
          .prepare("SELECT * FROM cron_jobs WHERE store_key = ? AND job_id = 'sqlite-job'")
          .all(cronStoreKey(storePath));
      const before = readRows();
      const cfg = {
        cron: { store: storePath, webhook: "https://example.invalid/cron-finished" },
      } as OpenClawConfig;
      expect(await collectLegacyCronStoreHealthFindings({ cfg })).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            requirement: "cron-delivery-mode-valid",
            message: expect.stringContaining("unsupported delivery mode"),
          }),
        ]),
      );
      const prompter = { confirm: vi.fn().mockResolvedValue(true) };
      await maybeRepairLegacyCronStore({ cfg, options: {}, prompter });
      expect(noteMock).toHaveBeenCalledWith(
        expect.stringContaining("Unsupported cron delivery modes were left unchanged"),
        "Cron",
      );
      expect(readRows()).toEqual(before);
      expect(prompter.confirm).toHaveBeenCalledOnce();
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
      expect(noteMock).not.toHaveBeenCalledWith(
        expect.stringContaining("Failed writing migrated cron store"),
        "Doctor warnings",
      );
    });
  },
);

it.each(["jobs.json", "jobs-state.json", "runs/old-job.jsonl"])(
  "refuses retired %s before mutating supported quarantine or SQLite rows",
  async (relative) => {
    await withOpenClawTestState({ label: "cron-retired-files" }, async (state) => {
      const storePath = state.statePath("cron", "jobs.json");
      await saveCronStore(storePath, {
        version: 1,
        jobs: [{ ...job("retained"), enabled: false }],
      });
      const before = (await loadCronStore(storePath)).jobs;
      const sourcePath = state.statePath("cron", relative);
      await fs.mkdir(path.dirname(sourcePath), { recursive: true });
      const source =
        relative === "jobs.json"
          ? JSON.stringify({ version: 1, jobs: [{ ...job("retired"), enabled: false }] })
          : relative === "jobs-state.json"
            ? JSON.stringify({
                version: 1,
                jobs: { retained: { updatedAtMs: 1, state: { lastStatus: "ok" } } },
              })
            : `${JSON.stringify({ ts: 1, jobId: "retained", action: "finished", status: "ok" })}\n`;
      await fs.writeFile(sourcePath, source);
      const quarantinePath = await state.writeJson("cron/jobs-quarantine.json", {
        version: 1,
        jobs: [{ reason: "invalid-schedule", job: { id: "quarantined" } }],
      });
      const quarantineBytes = await fs.readFile(quarantinePath, "utf8");
      const cfg = { cron: { store: storePath } } as OpenClawConfig;
      await expect(repairLegacyCronStoreWithoutPrompt({ cfg })).rejects.toThrow(
        /Upgrade through OpenClaw 2026\.9\.7/,
      );
      expect(await fs.readFile(sourcePath, "utf8")).toBe(source);
      expect(await fs.readFile(quarantinePath, "utf8")).toBe(quarantineBytes);
      expect((await loadCronStore(storePath)).jobs).toEqual(before);
      expect(await loadCronQuarantinedJobs(storePath)).toEqual([]);
    });
  },
);

it("refuses a retired source created during confirmation before consuming quarantine", async () => {
  await withOpenClawTestState({ label: "cron-retired-confirmation" }, async (state) => {
    const storePath = state.statePath("cron", "jobs.json");
    const quarantinePath = await state.writeJson("cron/jobs-quarantine.json", {
      version: 1,
      jobs: [{ reason: "invalid-schedule", job: { id: "quarantined" } }],
    });
    const original = await fs.readFile(quarantinePath, "utf8");
    await expect(
      maybeRepairLegacyCronStore({
        cfg: { cron: { store: storePath } } as OpenClawConfig,
        options: {},
        prompter: {
          confirm: async () => {
            await fs.writeFile(storePath, "new retired source");
            return true;
          },
        },
      }),
    ).rejects.toThrow(/Upgrade through OpenClaw 2026\.9\.7/);
    expect(await fs.readFile(quarantinePath, "utf8")).toBe(original);
    expect(await fs.readFile(storePath, "utf8")).toBe("new retired source");
    expect(await loadCronQuarantinedJobs(storePath)).toEqual([]);
  });
});

it("preserves a broken retired cron source link and refuses repair", async () => {
  await withOpenClawTestState({ label: "cron-retired-symlink" }, async (state) => {
    const storePath = state.statePath("cron", "jobs.json");
    const missingTarget = state.path("missing-operator-cron.json");
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.symlink(missingTarget, storePath, "file");

    await expect(loadLegacyCronRepairState({ cfg: {}, storePath })).rejects.toThrow(
      /Upgrade through OpenClaw 2026\.9\.7/,
    );

    expect((await fs.lstat(storePath)).isSymbolicLink()).toBe(true);
    expect(await fs.readlink(storePath)).toBe(missingTarget);
    await expect(fs.stat(`${storePath}.migrated`)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
