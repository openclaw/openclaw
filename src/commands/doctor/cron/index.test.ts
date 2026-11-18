import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../../test/helpers/sqlite-statement-execution-counter.js";
import type { OpenClawConfig } from "../../../config/config.js";
import {
  loadCronJobsStoreWithConfigJobs,
  loadCronQuarantinedJobs,
  loadCronStore,
  saveCronQuarantinedJobs,
  saveCronStore,
} from "../../../cron/store.js";
import { resolveCronStoreKeyInDatabase } from "../../../cron/store/paths.js";
import * as quarantine from "../../../cron/store/quarantine.js";
import * as staging from "../../../infra/sqlite-snapshot-staging.js";
import { createNonExitingRuntime } from "../../../runtime.js";
import { createOpenClawDatabaseMaintenanceScope } from "../../../state/openclaw-state-db-async-lifecycle.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../../state/openclaw-state-db.paths.js";
import { admitOpenClawMaintenanceLiveAuthorityReads } from "../../../state/openclaw-state-maintenance-context.js";
import { prepareDoctorMigrationBackups } from "../../doctor-heartbeat-migration-backup.js";
import { createDoctorPrompter } from "../../doctor-prompter.js";
import { readCronStoreSelectionForDoctor } from "./default-store-selection.js";
import { collectLegacyCronStoreHealthFindings, maybeRepairLegacyCronStore } from "./index.js";
import { inspectCronJobsForDoctor } from "./store-repair.js";

type StoredJob = Record<string, unknown>;
const WEBHOOK = "https://example.invalid/cron-finished";

const noteMock = vi.hoisted(() => vi.fn<(message: string, title?: string) => void>());

vi.mock("../../../../packages/terminal-core/src/note.js", () => ({
  note: noteMock,
}));

let tempRoot: string | null = null;
let storePath: string;

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-doctor-cron-"));
  storePath = path.join(tempRoot, "cron", "jobs.json");
});

afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  vi.unstubAllEnvs();
  noteMock.mockClear();
  if (tempRoot) {
    await fs.rm(tempRoot, { recursive: true, force: true });
    tempRoot = null;
  }
});

function makePrompter(confirmResult = true) {
  return { confirm: vi.fn().mockResolvedValue(confirmResult) };
}

function createCronConfig(webhook = WEBHOOK): OpenClawConfig {
  return { cron: { store: storePath, webhook } } as unknown as OpenClawConfig;
}

function repairCronStore(
  prompter: Parameters<typeof maybeRepairLegacyCronStore>[0]["prompter"] = makePrompter(true),
  cfg = createCronConfig(),
) {
  return maybeRepairLegacyCronStore({ cfg, options: {}, prompter });
}

function createLegacyCronJob(overrides: StoredJob = {}) {
  return {
    id: "legacy-job",
    name: "Legacy job",
    notify: true,
    createdAtMs: Date.parse("2026-02-01T00:00:00.000Z"),
    updatedAtMs: Date.parse("2026-02-02T00:00:00.000Z"),
    schedule: { kind: "cron", expr: "0 7 * * *", tz: "UTC" },
    payload: { kind: "systemEvent", text: "Morning brief" },
    state: {},
    ...overrides,
  };
}

function createCurrentCronJob(overrides: StoredJob = {}) {
  return {
    id: "sqlite-job",
    name: "SQLite job",
    enabled: true,
    createdAtMs: Date.parse("2026-02-03T00:00:00.000Z"),
    updatedAtMs: Date.parse("2026-02-03T00:00:00.000Z"),
    schedule: { kind: "cron", expr: "0 8 * * *", tz: "UTC" },
    sessionTarget: "isolated",
    wakeMode: "now",
    payload: { kind: "systemEvent", text: "SQLite brief" },
    state: {},
    ...overrides,
  };
}

async function writeCronStore(jobs: StoredJob[]) {
  const entries = jobs.map((job, index) => {
    const rawId = job.id ?? job.jobId;
    const id =
      typeof rawId === "string" || typeof rawId === "number" ? String(rawId) : `raw-${index}`;
    return { job, id };
  });
  await writeCurrentCronStore(entries.map(({ id }) => createCurrentCronJob({ id })));
  const db = openOpenClawStateDatabase().db;
  for (const { job, id } of entries) {
    db.prepare(
      "UPDATE cron_jobs SET job_json = ?, state_json = ? WHERE store_key = ? AND job_id = ?",
    ).run(
      JSON.stringify(job),
      JSON.stringify(job.state ?? {}),
      resolveCronStoreKeyInDatabase(db, storePath),
      id,
    );
  }
}

async function writeCurrentCronStore(jobs: StoredJob[]) {
  await saveCronStore(storePath, { version: 1, jobs: jobs as never });
}

async function readPersistedJobs(): Promise<StoredJob[]> {
  return (await loadCronStore(storePath)).jobs as unknown as StoredJob[];
}

function requirePersistedJob(jobs: StoredJob[], index: number) {
  const job = jobs[index];
  if (!job) {
    throw new Error(`expected persisted cron job ${index}`);
  }
  return job;
}

function expectNoteContaining(message: string, title = "Cron"): void {
  expect(noteMock).toHaveBeenCalledWith(expect.stringContaining(message), title);
}

function expectNoNoteContaining(message: string, title = "Cron"): void {
  expect(noteMock).not.toHaveBeenCalledWith(expect.stringContaining(message), title);
}

describe("collectLegacyCronStoreHealthFindings", () => {
  it("reports alias-only Gateway exec jobs with recreation guidance", async () => {
    await writeCurrentCronStore([
      createCurrentCronJob({
        id: "legacy-gateway-exec",
        name: "Legacy gateway shell",
        scheduledToolPolicy: { version: 1, mode: "trusted" },
        payload: { kind: "agentTurn", message: "run", toolsAllow: ["gateway_exec"] },
      }),
    ]);

    const findings = await collectLegacyCronStoreHealthFindings({
      cfg: createCronConfig(),
    });

    expect(findings).toContainEqual(
      expect.objectContaining({
        requirement: "legacy-gateway-exec-recreation",
        message: expect.stringContaining("retired `gateway_exec` alias"),
        fixHint: expect.stringContaining("fresh authenticated creator turn"),
      }),
    );
    expect((await readPersistedJobs())[0]?.payload).toMatchObject({ toolsAllow: ["gateway_exec"] });
  });

  it("includes disabled authority debt in the remediation inventory", async () => {
    await writeCurrentCronStore(
      [true, false].map((enabled) =>
        createCurrentCronJob({
          id: `authority-${enabled}`,
          enabled,
          owner: { agentId: "main", sessionKey: "agent:main:discord:group:ops" },
          payload: { kind: "agentTurn", message: "run", toolsAllow: ["write"] },
        }),
      ),
    );
    const findings = await collectLegacyCronStoreHealthFindings({
      cfg: createCronConfig(),
    });
    expect(
      findings.find(
        ({ requirement }) => requirement === "cron-scheduled-authority-reauthorization",
      ),
    ).toMatchObject({
      message: "2 tool-bearing automations require explicit scheduled authority reauthorization.",
      fixHint: expect.stringContaining("openclaw automations list --all"),
    });
  });
});

it.each(["structured", "interactive"])(
  "reports the original quarantine observation failure in %s Doctor output",
  async (mode) => {
    vi.stubEnv("OPENCLAW_STATE_DIR", path.dirname(path.dirname(storePath)));
    await writeCurrentCronStore([]);
    const observation = vi
      .spyOn(quarantine, "loadCronQuarantinedJobs")
      .mockRejectedValueOnce(new Error("quarantine observation unavailable"));
    try {
      if (mode === "structured") {
        expect(await collectLegacyCronStoreHealthFindings({ cfg: createCronConfig() })).toEqual([
          expect.objectContaining({
            requirement: "cron-store-readable",
            fixHint: expect.stringContaining("quarantine observation unavailable"),
          }),
        ]);
      } else {
        await repairCronStore();
        expectNoteContaining("Unable to read cron job store");
        expectNoteContaining("quarantine observation unavailable");
      }
    } finally {
      observation.mockRestore();
    }
  },
);

describe("maybeRepairLegacyCronStore", () => {
  it("preserves prompt-window runtime state and authority while repairing config", async () => {
    const runAtMs = Date.parse("2026-09-01T12:00:00.000Z");
    const staleAuthority = {
      version: 1,
      runtimeId: "codex",
      namespace: "codex.apps",
      payload: { apps: [{ id: "calendar" }] },
    };
    const freshAuthority = { ...staleAuthority, payload: { apps: [{ id: "mail" }] } };
    await writeCurrentCronStore([
      createCurrentCronJob({
        id: "runtime-job",
        notify: true,
        owner: { agentId: "main", sessionKey: "agent:main:discord:group:ops", accountId: "work" },
        payload: {
          kind: "agentTurn",
          message: "scheduled continuation",
          toolsAllow: ["read", "cron"],
        },
        scheduledToolPolicy: {
          version: 1,
          mode: "account",
          ownerSessionKey: "agent:main:discord:group:ops",
          ownerAccountId: "work",
        },
        toolsAllowProvenance: { version: 1, source: "final-executable-surface" },
        runtimeAuthority: staleAuthority,
        state: { runningAtMs: runAtMs - 1 },
      }),
    ]);
    const state = {
      queuedAtMs: runAtMs,
      runningAtMs: runAtMs,
      lastRunAtMs: runAtMs,
      lastRunStatus: "ok",
      consecutiveErrors: 0,
    };
    const prompter = {
      confirm: vi.fn(async () => {
        const current = requirePersistedJob(await readPersistedJobs(), 0);
        await writeCurrentCronStore([
          { ...current, updatedAtMs: runAtMs, state, runtimeAuthority: freshAuthority },
        ]);
        return true;
      }),
    };
    await repairCronStore(prompter);
    const repaired = requirePersistedJob(await readPersistedJobs(), 0);
    expect(repaired.notify).toBeUndefined();
    expect(repaired).toMatchObject({ state, updatedAtMs: runAtMs });
    expect(repaired.runtimeAuthority).toEqual(freshAuthority);
    expect(prompter.confirm).toHaveBeenCalledTimes(1);
    expectNoNoteContaining("Legacy cron job storage detected");
    expectNoteContaining("Cron store issues detected");
    expectNoNoteContaining("jobs.json");
  });

  it("backs up and converts both legacy script forms without changing state or tool caps", async () => {
    const toolsAllow = ["inventory__read"];
    const state = { triggerState: { status: "healthy" }, nextRunAtMs: Date.parse("2027-01-01") };
    await writeCronStore([
      createCurrentCronJob({
        id: "watcher",
        name: "Workspace watcher",
        payload: { kind: "agentTurn", message: "Summarize the status", toolsAllow },
        trigger: {
          script: "return { fire: true, message: 'Degraded', state: trigger.state };",
          once: true,
        },
        state,
      }),
      createCurrentCronJob({
        id: "post",
        name: "Workspace post",
        payload: {
          kind: "script",
          script: "return { notify: 'Degraded', state: trigger.state, nextCheck: '5m' };",
          timeoutSeconds: 400,
          toolBudget: 60,
          toolsAllow,
        },
        pacing: { max: "10m" },
        state,
      }),
      createCurrentCronJob({
        id: "conversation-wake",
        name: "Conversation wake",
        payload: { kind: "script", script: "return { wake: 'next-heartbeat' };", toolsAllow },
        state,
      }),
    ]);
    const cfg = createCronConfig();
    const findings = await collectLegacyCronStoreHealthFindings({ cfg });
    expect(findings.map(({ message }) => message).join("\n")).toContain("Workspace watcher");
    expect(await readPersistedJobs()).toEqual([]);
    await repairCronStore();
    const readJobs = async () =>
      new Map((await loadCronStore(storePath)).jobs.map((job) => [job.id, job]));
    const jobs = await readJobs();
    expect(jobs.get("watcher")).toMatchObject({
      enabled: true,
      state,
      payload: { kind: "agentTurn", message: "Summarize the status", toolsAllow },
      check: {
        script: expect.stringContaining("check.state"),
        once: true,
        timeoutSeconds: 30,
        toolBudget: 5,
      },
    });
    expect(jobs.get("post")).toMatchObject({
      enabled: true,
      state,
      pacing: { max: "10m" },
      payload: { kind: "none", toolsAllow },
      check: {
        script: "return { post: 'Degraded', state: check.state, nextCheck: '5m' };",
        timeoutSeconds: 400,
        toolBudget: 60,
      },
    });
    expect(jobs.get("conversation-wake")).toMatchObject({ enabled: false, state });
    expectNoteContaining("Saved pre-repair cron backup", "Doctor changes");
    expectNoteContaining("Converted automation Workspace watcher", "Doctor changes");
    expectNoteContaining("Conversation wake");
    expectNoNoteContaining("return { wake:");
    const second = makePrompter(true);
    await repairCronStore(second);
    expect(second.confirm).not.toHaveBeenCalled();
    expect(await readJobs()).toEqual(jobs);
  });

  it("recovers a valid quarantined schedule only after Doctor confirmation", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", path.dirname(path.dirname(storePath)));
    await writeCurrentCronStore([]);
    await saveCronQuarantinedJobs({
      storePath,
      nowMs: Date.parse("2026-08-30T18:50:02.000Z"),
      entries: [
        {
          sourceIndex: 0,
          reason: "invalid-schedule",
          job: createCurrentCronJob({
            id: "variant-cron",
            schedule: { kind: " CRON ", expr: "0 9 * * *", tz: "UTC" },
          }),
          state: { nextRunAtMs: 123 },
          updatedAtMs: 456,
        },
      ],
    });
    const cfg = createCronConfig();
    expect(await collectLegacyCronStoreHealthFindings({ cfg })).toEqual([
      expect.objectContaining({
        path: resolveOpenClawStateSqlitePath(),
        requirement: "quarantined-cron-rows",
      }),
    ]);
    const decline = makePrompter(false);

    await maybeRepairLegacyCronStore({ cfg, options: {}, prompter: decline });
    expectNoteContaining("Quarantined cron job rows found");
    expect((await loadCronStore(storePath)).jobs).toEqual([]);
    expect(await loadCronQuarantinedJobs(storePath)).toHaveLength(1);
    expect(decline.confirm).toHaveBeenCalledOnce();

    const confirm = makePrompter(true);
    await maybeRepairLegacyCronStore({ cfg, options: { repair: true }, prompter: confirm });

    const persisted = (await loadCronStore(storePath)).jobs;
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      id: "variant-cron",
      enabled: true,
      schedule: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
      state: { nextRunAtMs: 123 },
    });
    expect(await loadCronQuarantinedJobs(storePath)).toEqual([]);
    expectNoteContaining("Recovered 1 quarantined automation", "Doctor changes");
  });

  it("deduplicates migrated quarantine records when sidecar archival must be retried", async () => {
    vi.stubEnv("OPENCLAW_STATE_DIR", path.dirname(path.dirname(storePath)));
    const quarantinePath = storePath.replace(/\.json$/, "-quarantine.json");
    await fs.mkdir(path.dirname(quarantinePath), { recursive: true });
    const historicalJob = {
      quarantinedAtMs: 123,
      sourceIndex: 0,
      reason: "invalid-schedule",
      job: { id: "retry-bad-cron" },
      raw: { observed: true },
      state: { nextRunAtMs: 456 },
      updatedAtMs: 789,
      scheduleIdentity: "historical-schedule",
    };
    const historicalJobs = [
      historicalJob,
      { quarantinedAtMs: 124, sourceIndex: 1, reason: "missing-schedule", raw: null },
      { quarantinedAtMs: 125, sourceIndex: 2, reason: "invalid-schedule", job: { id: "job-only" } },
    ];
    const historicalBytes = JSON.stringify({ version: 1, jobs: historicalJobs });
    await fs.writeFile(quarantinePath, historicalBytes);
    expect(await collectLegacyCronStoreHealthFindings({ cfg: createCronConfig() })).toEqual([
      expect.objectContaining({ path: quarantinePath, requirement: "legacy-cron-quarantine" }),
    ]);
    await expect(fs.stat(resolveOpenClawStateSqlitePath())).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.readFile(quarantinePath, "utf-8")).resolves.toBe(historicalBytes);
    await writeCurrentCronStore([]);
    const rename = vi
      .spyOn(fs, "rename")
      .mockRejectedValueOnce(Object.assign(new Error("archive unavailable"), { code: "EACCES" }));
    const observation = observeHostDataSql();
    try {
      await repairCronStore();
    } finally {
      observation.restore();
    }

    expect(observation.queries.filter((sql) => sql.includes("diagnostic_events"))).toEqual([]);
    expect(await loadCronQuarantinedJobs(storePath)).toEqual(historicalJobs);
    await expect(fs.stat(quarantinePath)).resolves.toBeDefined();
    expectNoteContaining("could not archive the legacy cron file", "Doctor warnings");
    rename.mockRestore();

    await repairCronStore();

    expect(await loadCronQuarantinedJobs(storePath)).toEqual(historicalJobs);
    await expect(fs.stat(`${quarantinePath}.migrated`)).resolves.toBeDefined();
  });

  it("surfaces cron payload model overrides without rewriting current jobs", async () => {
    await writeCurrentCronStore([
      createCurrentCronJob({
        id: "api-pinned",
        payload: { kind: "agentTurn", message: "Brief", model: "openai/gpt-5.4", thinking: "high" },
      }),
      createCurrentCronJob({
        id: "alias-pinned",
        payload: { kind: "agentTurn", message: "Brief", model: "gpt" },
      }),
      createCurrentCronJob({
        id: "inherits-default",
        payload: { kind: "agentTurn", message: "Brief" },
      }),
      createCurrentCronJob({
        id: "disabled-pinned",
        enabled: false,
        payload: { kind: "agentTurn", message: "Dormant job", model: "ollama/qwen3" },
      }),
    ]);
    const prompter = makePrompter(true);
    const cfg = createCronConfig();
    cfg.agents = { defaults: { model: { primary: "test:opus", fallbacks: [] } } };
    await maybeRepairLegacyCronStore({ cfg, options: {}, prompter });

    expect(prompter.confirm).not.toHaveBeenCalled();
    expectNoteContaining("2 jobs set `payload.model`");
    expectNoteContaining("Provider namespaces: bare/alias=1, openai=1");
    expectNoteContaining("2 jobs use a different model than `agents.defaults.model`");
    expectNoteContaining("alias-pinned -> gpt");
    expectNoNoteContaining("ollama");
    expectNoNoteContaining("jobs.json");
    expect(requirePersistedJob(await readPersistedJobs(), 0).payload).toMatchObject({
      model: "openai/gpt-5.4",
      thinking: "high",
    });
  });
  const RUNNING_AT_MS = Date.parse("2026-05-01T00:00:00.000Z");

  it("warns about disabled jobs still marked in-flight without hiding the inventory", async () => {
    await writeCurrentCronStore([
      createCurrentCronJob({
        id: "running-job",
        enabled: false,
        state: { runningAtMs: RUNNING_AT_MS },
      }),
      createCurrentCronJob({ id: "running-enabled", state: { runningAtMs: RUNNING_AT_MS + 1000 } }),
    ]);
    const prompter = makePrompter(true);

    await repairCronStore(prompter);

    expectNoteContaining("2 automations are still marked in-flight");
    expectNoNoteContaining("shows it as `running`");
    expectNoteContaining("marks such runs interrupted the next time it starts");
    expectNoteContaining("openclaw automations list --all");
    expectNoteContaining("openclaw automations show <id>");

    expect(prompter.confirm).not.toHaveBeenCalled();
    const state = (await loadCronStore(storePath)).jobs[0]?.state;
    expect(state?.runningAtMs).toBe(RUNNING_AT_MS);
    expect(state?.lastRunStatus).toBeUndefined();
  });

  it("pluralizes and only counts enabled jobs at or above the threshold", async () => {
    await writeCurrentCronStore([
      createCurrentCronJob({
        id: "failing-a",
        state: { lastRunStatus: "error", consecutiveErrors: 3 },
      }),
      createCurrentCronJob({
        id: "failing-b",
        state: { lastRunStatus: "error", consecutiveErrors: 12 },
      }),
      createCurrentCronJob({
        id: "recovering",
        state: { lastRunStatus: "error", consecutiveErrors: 2 },
      }),
      createCurrentCronJob({
        id: "disabled-exhausted",
        enabled: false,
        state: { lastRunStatus: "error", consecutiveErrors: 9 },
      }),
    ]);
    const prompter = makePrompter(true);
    await repairCronStore(prompter);
    expectNoteContaining("2 automations have failed 3+ runs in a row");
    expect(prompter.confirm).not.toHaveBeenCalled();
    expect(requirePersistedJob(await readPersistedJobs(), 0).state).toMatchObject({
      consecutiveErrors: 3,
    });
  });

  it("lists auto-disabled jobs with their recorded reasons and recovery commands", async () => {
    await writeCurrentCronStore([
      createCurrentCronJob({
        id: "run-failure-job",
        name: "Run failure job",
        enabled: false,
        state: {
          consecutiveErrors: 10,
          autoDisabled: { reason: "consecutive-failures", atMs: 1, consecutiveErrors: 10 },
        },
      }),
      createCurrentCronJob({
        id: "schedule-error-job",
        name: "Schedule error job",
        enabled: false,
        state: {
          scheduleErrorCount: 3,
          autoDisabled: { reason: "schedule-errors", atMs: 2, consecutiveErrors: 3 },
        },
      }),
      createCurrentCronJob({
        id: "disabled-one-shot",
        enabled: false,
        state: { lastRunStatus: "error", consecutiveErrors: 9 },
      }),
    ]);
    await repairCronStore();
    expectNoteContaining("2 automations are auto-disabled");
    expectNoteContaining("Run failure job (run-failure-job)");
    expectNoteContaining("recorded reason `consecutive-failures` after 10");
    expectNoteContaining("openclaw automations enable run-failure-job");
    expectNoteContaining("Schedule error job (schedule-error-job)");
    expectNoteContaining("recorded reason `schedule-errors` after 3");
    expectNoteContaining("openclaw automations enable schedule-error-job");
    expectNoNoteContaining("disabled-one-shot");
  });

  it("advises on isolated shell-prompt jobs without a non-actionable --fix repair note (#94655)", async () => {
    const shellPromptJobs = ["*", "bash", "process"].map((tool, index) =>
      createCurrentCronJob({
        id: `shell-prompt-job-${index + 1}`,
        name: `Shell prompt job ${index + 1}`,
        schedule: { kind: "cron", expr: "*/30 * * * *", tz: "UTC" },
        payload: {
          kind: "agentTurn",
          message:
            "Run python3 scripts/check_mail.py and send a compact summary if anything changed.",
          toolsAllow: [tool],
        },
        delivery: { mode: "announce" },
      }),
    );
    await writeCurrentCronStore(shellPromptJobs);
    const prompter = makePrompter(true);
    await repairCronStore(prompter);

    expectNoteContaining("3 isolated automations drive shell/process tools");
    for (const job of shellPromptJobs) {
      expectNoteContaining(job.name, "Cron");
    }
    expectNoteContaining("informational only");
    expectNoNoteContaining("Cron store issues detected");
    expectNoNoteContaining("openclaw doctor --fix");
    expectNoNoteContaining("jobs.json");
    expect(prompter.confirm).not.toHaveBeenCalled();
    expect(await readPersistedJobs()).toEqual(shellPromptJobs);
  });

  it("keeps restricted command prompts actionable without a --fix repair note", async () => {
    const job = createCurrentCronJob({
      payload: {
        kind: "agentTurn",
        message:
          "Command to run:\n- command: python3 scripts/check_mail.py\n- workdir: /tmp/workspace",
        toolsAllow: ["read", "message"],
      },
      delivery: { mode: "announce" },
    });
    await writeCurrentCronStore([job]);
    const prompter = makePrompter(true);
    await repairCronStore(prompter);
    expectNoteContaining("lacks shell/process tool access");
    expectNoteContaining("Recreate it as a command automation");
    expectNoNoteContaining("informational only");
    expectNoNoteContaining("keep running as-is");
    expectNoNoteContaining("Cron store issues detected");
    expectNoNoteContaining("openclaw doctor --fix");
    expect(prompter.confirm).not.toHaveBeenCalled();
    expect(requirePersistedJob(await readPersistedJobs(), 0).payload).toEqual(job.payload);
  });

  it("quarantines malformed SQLite identifiers without dropping their definitions", async () => {
    await writeCronStore([
      createLegacyCronJob({
        id: 42,
        jobId: undefined,
        notify: false,
      }),
      createLegacyCronJob({
        id: undefined,
        jobId: undefined,
        name: "Missing id",
        notify: false,
      }),
    ]);

    await repairCronStore();

    expect(await readPersistedJobs()).toEqual([]);
    expect(await loadCronQuarantinedJobs(storePath)).toMatchObject([
      { reason: "missing-id", job: { id: 42 } },
      { reason: "missing-id", job: { name: "Missing id" } },
    ]);
  });

  it("migrates notify fallback while preserving announce delivery", async () => {
    await writeCronStore([
      createCurrentCronJob({
        id: "notify-and-announce",
        notify: true,
        payload: { kind: "agentTurn", message: "Status" },
        delivery: { to: "telegram:123" },
      }),
      ...["none", "webhook"].map((mode) =>
        createCurrentCronJob({
          id: `notify-${mode}`,
          notify: true,
          sessionTarget: "main",
          delivery: { mode, to: mode === "none" ? "123456789" : "ftp://example.invalid/cron" },
        }),
      ),
    ]);
    await repairCronStore();
    const jobs = await readPersistedJobs();
    expect(jobs).toHaveLength(3);
    for (const job of jobs) {
      expect(job.notify).toBeUndefined();
    }
    expect(jobs[0]?.delivery).toEqual({
      mode: "announce",
      to: "telegram:123",
      completionDestination: { mode: "webhook", to: WEBHOOK },
    });
    for (const job of jobs.slice(1)) {
      expect(job.delivery).toEqual({ mode: "webhook", to: WEBHOOK });
    }
  });

  it("does not migrate legacy notify fallback from a credential-bearing webhook URL", async () => {
    const credentialUrl = new URL("https://example.invalid/cron-finished?token=placeholder");
    credentialUrl.username = "user";
    credentialUrl.password = "password";
    await writeCronStore([
      createLegacyCronJob({
        id: "notify-credential-config",
        jobId: undefined,
        delivery: undefined,
      }),
    ]);

    await repairCronStore(undefined, createCronConfig(credentialUrl.href));

    const job = requirePersistedJob(await readPersistedJobs(), 0);
    expect(job.notify).toBeUndefined();
    expect(job.delivery).toBeUndefined();
    const { configJobs: persisted } = await loadCronJobsStoreWithConfigJobs(storePath);
    expect(persisted[0]?.notify).toBe(true);
    expectNoteContaining(
      "cron.webhook is not a valid HTTP(S) URL so doctor cannot migrate it automatically",
      "Doctor warnings",
    );
    expect(JSON.stringify(noteMock.mock.calls)).not.toContain(credentialUrl.href);
  });

  it("removes inert legacy notify:true for delivery.mode none when cron.webhook is unset and stops looping (#44460)", async () => {
    await writeCronStore([
      createCurrentCronJob({
        id: "notify-none-unset",
        name: "Notify none unset",
        notify: true,
        delivery: { mode: "none" },
      }),
    ]);

    const cfg = { cron: { store: storePath } } as unknown as OpenClawConfig;
    await repairCronStore(undefined, cfg);

    const { configJobs: persisted } = await loadCronJobsStoreWithConfigJobs(storePath);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]?.notify).toBeUndefined();
    expect(persisted[0]?.delivery).toEqual({ mode: "none" });

    noteMock.mockClear();
    await repairCronStore(undefined, cfg);
    expectNoNoteContaining("still uses legacy `notify: true`");
  });

  it("recovers supported quarantine schedule variants and retains invalid rows", async () => {
    await saveCronQuarantinedJobs({
      storePath,
      nowMs: 123,
      entries: [
        { kind: " CRON ", cron: "0 7 * * *", tz: "UTC" },
        { kind: "Every", everyMs: 60_000 },
        { kind: " Stream ", command: ["node", "events.mjs"], mode: " LINE " },
        { kind: "cron" },
      ].map((schedule, index) => ({
        sourceIndex: index,
        reason: "invalid-schedule",
        job: createLegacyCronJob({ id: `variant-${index}`, enabled: true, schedule }),
      })),
    });
    await repairCronStore();
    expect(await readPersistedJobs()).toMatchObject([
      { id: "variant-0", enabled: true, schedule: { kind: "cron" } },
      { id: "variant-1", enabled: true, schedule: { kind: "every" } },
      { id: "variant-2", enabled: true, schedule: { kind: "stream", mode: "line" } },
    ]);
    expect(await loadCronQuarantinedJobs(storePath)).toMatchObject([
      { reason: "invalid-schedule", job: { id: "variant-3" } },
    ]);
  });

  it("repairs legacy root delivery threadId hints into delivery", async () => {
    await writeCronStore([
      createCurrentCronJob({
        payload: { kind: "agentTurn", message: "Morning brief" },
        channel: " telegram ",
        to: "-1001234567890",
        threadId: " 99 ",
      }),
    ]);
    await repairCronStore();
    const job = requirePersistedJob(await readPersistedJobs(), 0);
    expect(job.channel).toBeUndefined();
    expect(job.to).toBeUndefined();
    expect(job.threadId).toBeUndefined();
    expect(job.delivery).toEqual({
      mode: "announce",
      channel: "telegram",
      to: "-1001234567890",
      threadId: "99",
    });
  });

  it("warns and continues when the cron job store cannot be read", async () => {
    // EISDIR is deterministic even under root, which can bypass permission failures (#86102).
    await fs.mkdir(storePath.replace(/\.json$/, "-quarantine.json"), { recursive: true });
    const prompter = makePrompter(true);
    await expect(repairCronStore(prompter)).resolves.toBeUndefined();
    expect(prompter.confirm).not.toHaveBeenCalled();
    expectNoteContaining("Unable to read cron job store at");
    expectNoteContaining("later health checks will continue");
  });
});

it("inspects cron under offline Doctor custody when disposable snapshot allocation is unavailable", async () => {
  const env = { ...process.env, OPENCLAW_STATE_DIR: tempRoot! };
  vi.stubEnv("OPENCLAW_STATE_DIR", tempRoot!);
  await saveCronStore(storePath, { version: 1, jobs: [createLegacyCronJob() as never] });
  await closeOpenClawStateDatabaseAsync();
  const databasePath = resolveOpenClawStateSqlitePath(env);
  const maintenance = createOpenClawDatabaseMaintenanceScope({
    schemaMaintenance: true,
    assertOwnerCurrent() {},
    assertDatabaseAccess(pathname) {
      expect(pathname).toBe(databasePath);
    },
  });
  const allocation = vi
    .spyOn(staging, "createSqliteSnapshotStagingDirectory")
    .mockRejectedValue(new Error("SQLite snapshot allocation and cleanup failed"));
  try {
    await maintenance.run(async () => {
      admitOpenClawMaintenanceLiveAuthorityReads(databasePath);
      const inventory = await inspectCronJobsForDoctor({ env });
      expect(inventory.jobs.map(({ id }) => id)).toEqual(["legacy-job"]);
    });
  } finally {
    await maintenance.close();
    allocation.mockRestore();
  }
});

it.each([
  { binding: "absent", populated: false, expected: "ready" },
  { binding: "absent", populated: true, expected: "ready" },
  { binding: "malformed", populated: false, expected: "unresolved" },
  { binding: "malformed", populated: true, expected: "unresolved" },
])(
  "classifies a $binding binding with populated=$populated without changing it",
  async ({ binding, populated, expected }) => {
    vi.stubEnv("OPENCLAW_STATE_DIR", tempRoot!);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(tempRoot!, "openclaw.json"));
    if (populated) {
      await saveCronStore(storePath, { version: 1, jobs: [createCurrentCronJob() as never] });
    }
    const { db } = openOpenClawStateDatabase();
    db.prepare("DELETE FROM config_machine_state WHERE state_key = 'cron.defaultStoreKey'").run();
    if (binding === "malformed") {
      db.prepare(
        "INSERT INTO config_machine_state (state_key, value_json, updated_at_ms) VALUES ('cron.defaultStoreKey', '17', 1)",
      ).run();
    }
    const before = db
      .prepare("SELECT * FROM config_machine_state WHERE state_key = 'cron.defaultStoreKey'")
      .all();
    const selection = await readCronStoreSelectionForDoctor({});
    expect(selection.status).toBe(expected);
    if (selection.status === "ready") {
      expect(selection.storeKey).toBe(storePath);
    }
    expect(
      db
        .prepare("SELECT * FROM config_machine_state WHERE state_key = 'cron.defaultStoreKey'")
        .all(),
    ).toEqual(before);
  },
);

it("reports a moved partition, refuses --yes guessing, and binds only an explicit Doctor choice", async () => {
  vi.stubEnv("OPENCLAW_STATE_DIR", tempRoot!);
  const configPath = path.join(tempRoot!, "openclaw.json");
  vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
  await fs.writeFile(configPath, "{}");
  const retainedKey = path.join(tempRoot!, "old-machine", "cron", "jobs.json");
  await saveCronStore(retainedKey, { version: 1, jobs: [createCurrentCronJob() as never] });
  const { db } = openOpenClawStateDatabase();
  db.prepare("DELETE FROM config_machine_state WHERE state_key = 'cron.defaultStoreKey'").run();
  const before = db.prepare("SELECT * FROM cron_jobs ORDER BY store_key, job_id").all();
  await closeOpenClawStateDatabaseAsync();

  const findings = await collectLegacyCronStoreHealthFindings({ cfg: {} });
  expect(findings).toEqual([
    expect.objectContaining({
      requirement: "cron-default-partition-selected",
      message: expect.stringContaining(retainedKey),
      fixHint: expect.stringContaining("Select the default cron partition"),
    }),
  ]);
  const options = { yes: true };
  await maybeRepairLegacyCronStore({
    cfg: {},
    options,
    prompter: createDoctorPrompter({ runtime: createNonExitingRuntime(), options }),
  });
  expect(
    openOpenClawStateDatabase()
      .db.prepare(
        "SELECT value_json FROM config_machine_state WHERE state_key = 'cron.defaultStoreKey'",
      )
      .get(),
  ).toBeUndefined();
  await closeOpenClawStateDatabaseAsync();

  const databasePath = resolveOpenClawStateSqlitePath();
  const maintenance = createOpenClawDatabaseMaintenanceScope({
    schemaMaintenance: true,
    assertOwnerCurrent() {},
    assertDatabaseAccess(pathname) {
      expect(pathname).toBe(databasePath);
    },
  });
  try {
    await maintenance.run(async () => {
      admitOpenClawMaintenanceLiveAuthorityReads(databasePath);
      // This preflight precedes the contribution that offers partition selection.
      await prepareDoctorMigrationBackups({
        schemas: { incompatible: [], indeterminate: [] },
        env: { ...process.env },
        check: "quick",
        verifiedSnapshots: [],
        automaticRepair: false,
        runtime: createNonExitingRuntime(),
        measure: async (_name, run) => run(),
      });
      await maybeRepairLegacyCronStore({
        cfg: {},
        options: { repair: true },
        prompter: {
          confirm: async () => false,
          selectRuntimeRepair: vi.fn().mockResolvedValue(retainedKey),
        },
      });
      const repaired = openOpenClawStateDatabase().db;
      expect(
        repaired
          .prepare(
            "SELECT value_json FROM config_machine_state WHERE state_key = 'cron.defaultStoreKey'",
          )
          .get(),
      ).toEqual({ value_json: JSON.stringify(retainedKey) });
      expect(repaired.prepare("SELECT * FROM cron_jobs ORDER BY store_key, job_id").all()).toEqual(
        before,
      );
      expect((await loadCronStore(storePath)).jobs.map((job) => job.id)).toEqual(["sqlite-job"]);
    });
  } finally {
    await maintenance.close();
  }
});
