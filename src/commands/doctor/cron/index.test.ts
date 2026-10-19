import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../../test/helpers/sqlite-statement-execution-counter.js";
import type { OpenClawConfig } from "../../../config/config.js";
import * as store from "../../../cron/store.js";
import { cronStoreKey } from "../../../cron/store/key.js";
import * as quarantine from "../../../cron/store/quarantine.js";
import * as staging from "../../../infra/sqlite-snapshot-staging.js";
import { createOpenClawDatabaseMaintenanceScope } from "../../../state/openclaw-state-db-async-lifecycle.js";
import * as stateDb from "../../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../../state/openclaw-state-db.paths.js";
import { admitOpenClawMaintenanceLiveAuthorityReads } from "../../../state/openclaw-state-maintenance-context.js";
import { collectLegacyCronStoreHealthFindings, maybeRepairLegacyCronStore } from "./index.js";
import { inspectCronJobsForDoctor } from "./store-repair.js";

type StoredJob = Record<string, unknown>;
const WEBHOOK = "https://example.invalid/cron-finished";
const agentTurn = (message: string, fields: StoredJob = {}) => ({
  kind: "agentTurn",
  message,
  ...fields,
});

const noteMock = vi.hoisted(() => vi.fn<(message: string, title?: string) => void>());

vi.mock("../../../../packages/terminal-core/src/note.js", () => ({ note: noteMock }));

let tempRoot: string | null = null;
let storePath: string;

beforeEach(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-doctor-cron-"));
  storePath = path.join(tempRoot, "cron", "jobs.json");
});

afterEach(async () => {
  await stateDb.closeOpenClawStateDatabaseAsync();
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

function cronConfig(webhook = WEBHOOK): OpenClawConfig {
  return { cron: { store: storePath, webhook } } as unknown as OpenClawConfig;
}

function repairCronStore(
  prompter: Parameters<typeof maybeRepairLegacyCronStore>[0]["prompter"] = makePrompter(true),
  cfg = cronConfig(),
) {
  return maybeRepairLegacyCronStore({ cfg, options: {}, prompter });
}

function legacyJob(overrides: StoredJob = {}) {
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

function makeJob(overrides: StoredJob = {}) {
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

async function seedRawJobs(...jobs: StoredJob[]) {
  const entries = jobs.map((job, index) => {
    const rawId = job.id ?? job.jobId;
    const id =
      typeof rawId === "string" || typeof rawId === "number" ? String(rawId) : `raw-${index}`;
    return { job, id };
  });
  await saveJobs(...entries.map(({ id }) => ({ id })));
  const db = stateDb.openOpenClawStateDatabase().db;
  for (const { job, id } of entries) {
    db.prepare(
      "UPDATE cron_jobs SET job_json = ?, state_json = ? WHERE store_key = ? AND job_id = ?",
    ).run(JSON.stringify(job), JSON.stringify(job.state ?? {}), cronStoreKey(storePath), id);
  }
}

async function saveJobs(...jobs: StoredJob[]) {
  await store.saveCronStore(storePath, { version: 1, jobs: jobs.map(makeJob) as never });
}

async function readJobs(): Promise<StoredJob[]> {
  return (await store.loadCronStore(storePath)).jobs as unknown as StoredJob[];
}

const firstJob = async () => expectDefined((await readJobs())[0], "persisted cron job");

function expectNote(message: string, title = "Cron"): void {
  expect(noteMock).toHaveBeenCalledWith(expect.stringContaining(message), title);
}

function expectNoNote(message: string, title = "Cron"): void {
  expect(noteMock).not.toHaveBeenCalledWith(expect.stringContaining(message), title);
}

async function expectAdvisory(
  jobs: StoredJob[],
  notes: string[],
  absent: string[] = [],
  cfg = cronConfig(),
) {
  await saveJobs(...jobs);
  const before = await readJobs();
  const prompter = makePrompter();
  await repairCronStore(prompter, cfg);
  expect(prompter.confirm).not.toHaveBeenCalled();
  for (const note of notes) {
    expectNote(note);
  }
  for (const note of absent) {
    expectNoNote(note);
  }
  expect(await readJobs()).toEqual(before);
}

it("reports alias-only Gateway exec jobs with recreation guidance", async () => {
  await saveJobs({
    id: "legacy-gateway-exec",
    name: "Legacy gateway shell",
    scheduledToolPolicy: { version: 1, mode: "trusted" },
    payload: agentTurn("run", { toolsAllow: ["gateway_exec"] }),
  });

  const findings = await collectLegacyCronStoreHealthFindings({ cfg: cronConfig() });

  expect(findings).toContainEqual(
    expect.objectContaining({
      requirement: "legacy-gateway-exec-recreation",
      message: expect.stringContaining("retired `gateway_exec` alias"),
      fixHint: expect.stringContaining("fresh authenticated creator turn"),
    }),
  );
  expect((await readJobs())[0]?.payload).toMatchObject({ toolsAllow: ["gateway_exec"] });
});

it("includes disabled authority debt in the remediation inventory", async () => {
  await saveJobs(
    ...[true, false].map((enabled) => ({
      id: `authority-${enabled}`,
      enabled,
      owner: { agentId: "main", sessionKey: "agent:main:discord:group:ops" },
      payload: agentTurn("run", { toolsAllow: ["write"] }),
    })),
  );
  const findings = await collectLegacyCronStoreHealthFindings({ cfg: cronConfig() });
  expect(
    findings.find(({ requirement }) => requirement === "cron-scheduled-authority-reauthorization"),
  ).toMatchObject({
    message: "2 tool-bearing automations require explicit scheduled authority reauthorization.",
    fixHint: expect.stringContaining("openclaw automations list --all"),
  });
});

it.each(["structured", "interactive"])(
  "reports the original quarantine observation failure in %s Doctor output",
  async (mode) => {
    vi.stubEnv("OPENCLAW_STATE_DIR", path.dirname(path.dirname(storePath)));
    await saveJobs();
    const observation = vi
      .spyOn(quarantine, "loadCronQuarantinedJobs")
      .mockRejectedValueOnce(new Error("quarantine observation unavailable"));
    try {
      if (mode === "structured") {
        expect(await collectLegacyCronStoreHealthFindings({ cfg: cronConfig() })).toEqual([
          expect.objectContaining({
            requirement: "cron-store-readable",
            fixHint: expect.stringContaining("quarantine observation unavailable"),
          }),
        ]);
      } else {
        await repairCronStore();
        expectNote("Unable to read cron job store");
        expectNote("quarantine observation unavailable");
      }
    } finally {
      observation.mockRestore();
    }
  },
);

it("preserves prompt-window runtime state and authority while repairing config", async () => {
  const runAtMs = Date.parse("2026-09-01T12:00:00.000Z");
  const staleAuthority = {
    version: 1,
    runtimeId: "codex",
    namespace: "codex.apps",
    payload: { apps: [{ id: "calendar" }] },
  };
  const freshAuthority = { ...staleAuthority, payload: { apps: [{ id: "mail" }] } };
  await saveJobs({
    id: "runtime-job",
    notify: true,
    owner: { agentId: "main", sessionKey: "agent:main:discord:group:ops", accountId: "work" },
    payload: agentTurn("scheduled continuation", { toolsAllow: ["read", "cron"] }),
    scheduledToolPolicy: {
      version: 1,
      mode: "account",
      ownerSessionKey: "agent:main:discord:group:ops",
      ownerAccountId: "work",
    },
    toolsAllowProvenance: { version: 1, source: "final-executable-surface" },
    runtimeAuthority: staleAuthority,
    state: { runningAtMs: runAtMs - 1 },
  });
  const state = {
    queuedAtMs: runAtMs,
    runningAtMs: runAtMs,
    lastRunAtMs: runAtMs,
    lastRunStatus: "ok",
    consecutiveErrors: 0,
  };
  const prompter = {
    confirm: vi.fn(async () => {
      const current = await firstJob();
      await saveJobs({
        ...current,
        updatedAtMs: runAtMs,
        state,
        runtimeAuthority: freshAuthority,
      });
      return true;
    }),
  };
  await repairCronStore(prompter);
  const repaired = await firstJob();
  expect(repaired.notify).toBeUndefined();
  expect(repaired).toMatchObject({ state, updatedAtMs: runAtMs });
  expect(repaired.runtimeAuthority).toEqual(freshAuthority);
  expect(prompter.confirm).toHaveBeenCalledTimes(1);
  expectNoNote("Legacy cron job storage detected");
  expectNote("Cron store issues detected");
  expectNoNote("jobs.json");
});

it("detects, repairs, reloads, and idempotently migrates the stable documented SQLite trigger script", async () => {
  const stableScript =
    "const res = await tools.call('exec', { command: 'gh pr checks 123 --json state -q \\'.[].state\\' | sort -u' }); const status = String(res?.result?.details?.aggregated ?? '').trim(); json({ fire: status !== trigger.state?.status, message: `PR 123 CI: ${trigger.state?.status ?? 'unknown'} -> ${status}`, state: { status } });";
  const ignoredResultScript =
    "// Preserve the trigger comment.\nawait tools.call(\"exec\", { command: 'echo done' });";
  const betaOnlyPayloadScript = "await tools.call('exec', { command: 'leave payload unchanged' })";
  await saveJobs(
    {
      id: "stable-pr-watcher",
      name: "Stable PR watcher",
      schedule: { kind: "every", everyMs: 30_000 },
      trigger: { script: stableScript, once: false },
    },
    {
      id: "ignored-result",
      name: "Ignored result watcher",
      trigger: { script: ignoredResultScript },
    },
    {
      id: "beta-script-payload",
      payload: { kind: "script", script: betaOnlyPayloadScript },
    },
  );
  const cfg = cronConfig();
  const findings = await collectLegacyCronStoreHealthFindings({ cfg });
  for (const name of ["Stable PR watcher", "Ignored result watcher"]) {
    expect(findings).toContainEqual(
      expect.objectContaining({
        requirement: "legacy-cron-trigger-script",
        message: expect.stringContaining(name),
      }),
    );
  }
  expect((await store.loadCronStore(storePath)).jobs[0]?.trigger?.script).toBe(stableScript);
  const decline = makePrompter(false);
  await repairCronStore(decline);
  expect(decline.confirm).toHaveBeenCalledTimes(1);
  expectNote("Stable PR watcher");
  expect((await store.loadCronStore(storePath)).jobs[0]?.trigger?.script).toBe(stableScript);
  noteMock.mockClear();
  await repairCronStore();
  const expectedScript = stableScript
    .replace("tools.call('exec', ", "exec(")
    .replace("res?.result?.details", "res");
  const reloaded = await store.loadCronJobsStoreWithConfigJobs(storePath);
  expect(reloaded.store.jobs[0]?.trigger?.script).toBe(expectedScript);
  expect(reloaded.store.jobs[1]?.trigger?.script).toBe(
    "// Preserve the trigger comment.\nawait exec({ command: 'echo done' });",
  );
  expect(reloaded.store.jobs[2]?.payload).toEqual({
    kind: "script",
    script: betaOnlyPayloadScript,
  });
  expect(reloaded.configJobs[0]?.trigger).toEqual({ script: expectedScript, once: false });
  await expect(fs.stat(storePath)).rejects.toMatchObject({ code: "ENOENT" });
  expectNote("Stable PR watcher", "Doctor changes");
  expectNote("2 legacy cron trigger scripts", "Doctor changes");
  noteMock.mockClear();
  const second = makePrompter(true);
  await repairCronStore(second);
  expect(second.confirm).not.toHaveBeenCalled();
  expectNoNote("legacy trigger script");
  expect((await store.loadCronStore(storePath)).jobs[0]?.trigger?.script).toBe(expectedScript);
});

it("leaves unsupported legacy trigger scripts untouched and reports redacted per-job remediation", async () => {
  const call = "await tools.call('exec', { command: 'x' })";
  const res = `const res = ${call}`;
  const scripts: Array<[string, string]> = [
    ["dynamic-name", "await tools.call(toolName, { command: 'secret-token' })"],
    ["dynamic-args", "await tools.call('exec', args)"],
    [
      "mixed-legacy",
      "const res = await tools.call('exec', { command: 'secret-token' }); tools.search('x')",
    ],
    ["envelope-result", `${res}; json(res.result)`],
    ["envelope-tool", `${res}; json(res.tool)`],
    ["destructured", `const { result } = ${call}; json(result)`],
    ["reassigned", `let res = ${call}; res = other; json(res.result.details)`],
    ["shadowed", `const tools = localTools; ${call}`],
    ["catalog", "json(ALL_TOOLS)"],
    ["global-tools", "await globalThis.tools.call('exec', { command: 'x' })"],
    ["global-catalog", "json(globalThis.ALL_TOOLS)"],
    ["computed-global-tools", 'json(globalThis["tools"])'],
    ["top-level-this-tools", "json(this.tools)"],
    ["describe", "json(await tools.describe('exec'))"],
    ["safe-name", "await tools.exec({ command: 'x' })"],
    ["computed-callee", "await tools['call']('exec', { command: 'x' })"],
    ["spread-args", "await tools.call('exec', { ...args })"],
    ["computed-args", "await tools.call('exec', { [key]: 'x' })"],
    ["commented-call", "await tools.call('exec', /* preserve this */ { command: 'x' })"],
    ["commented-envelope", `${res}; json(res.result /* preserve this */ .details)`],
    ["aliased-result", `${res}; const alias = res`],
    ["shadowed-exec", `const exec = localExec; ${call}`],
    ["ambiguous-scope", `${res}; function inspect() { return res.result.details }`],
  ];
  const unsupportedScripts = scripts.map(([id, script]) => ({ id, script }));
  await saveJobs(
    ...unsupportedScripts.map(({ id, script }) => ({
      id,
      name: `Legacy ${id}`,
      trigger: { script },
    })),
  );
  const cfg = cronConfig();

  const findings = await collectLegacyCronStoreHealthFindings({ cfg });
  for (const { id } of unsupportedScripts) {
    expect(findings).toContainEqual(
      expect.objectContaining({
        requirement: "unsupported-legacy-cron-trigger-script",
        message: expect.stringContaining(`Legacy ${id}`),
      }),
    );
  }

  const prompter = makePrompter(true);
  await maybeRepairLegacyCronStore({ cfg, options: { repair: true }, prompter });

  expect(prompter.confirm).not.toHaveBeenCalled();
  for (const { id } of unsupportedScripts) {
    expectNote(`Legacy ${id}`, "Cron");
  }
  expectNote("manually");
  expectNoNote("secret-token");
  expect(
    (await store.loadCronStore(storePath)).jobs.map((job) => ({
      id: job.id,
      script: job.trigger?.script,
    })),
  ).toEqual(unsupportedScripts);
});

it("recovers a valid quarantined schedule only after Doctor confirmation", async () => {
  vi.stubEnv("OPENCLAW_STATE_DIR", path.dirname(path.dirname(storePath)));
  await saveJobs();
  await store.saveCronQuarantinedJobs({
    storePath,
    nowMs: Date.parse("2026-08-30T18:50:02.000Z"),
    entries: [
      {
        sourceIndex: 0,
        reason: "invalid-schedule",
        job: makeJob({
          id: "variant-cron",
          schedule: { kind: " CRON ", expr: "0 9 * * *", tz: "UTC" },
        }),
        state: { nextRunAtMs: 123 },
        updatedAtMs: 456,
      },
      {
        sourceIndex: 1,
        reason: "invalid-schedule",
        job: legacyJob({
          id: "invalid",
          schedule: { kind: "cron" },
        }),
      },
    ],
  });
  const cfg = cronConfig();
  expect(await collectLegacyCronStoreHealthFindings({ cfg })).toEqual([
    expect.objectContaining({
      path: resolveOpenClawStateSqlitePath(),
      requirement: "quarantined-cron-rows",
    }),
  ]);
  const decline = makePrompter(false);

  await maybeRepairLegacyCronStore({ cfg, options: {}, prompter: decline });
  expectNote("Quarantined cron job rows found");
  expect((await store.loadCronStore(storePath)).jobs).toEqual([]);
  expect(await store.loadCronQuarantinedJobs(storePath)).toHaveLength(2);
  expect(decline.confirm).toHaveBeenCalledOnce();

  const confirm = makePrompter(true);
  await maybeRepairLegacyCronStore({ cfg, options: { repair: true }, prompter: confirm });

  const persisted = (await store.loadCronStore(storePath)).jobs;
  expect(persisted).toHaveLength(1);
  expect(persisted[0]).toMatchObject({
    id: "variant-cron",
    enabled: true,
    schedule: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
    state: { nextRunAtMs: 123 },
  });
  expect(await store.loadCronQuarantinedJobs(storePath)).toMatchObject([
    { reason: "invalid-schedule", job: { id: "invalid" } },
  ]);
  expectNote("Recovered 1 quarantined automation", "Doctor changes");
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
  expect(await collectLegacyCronStoreHealthFindings({ cfg: cronConfig() })).toEqual([
    expect.objectContaining({ path: quarantinePath, requirement: "legacy-cron-quarantine" }),
  ]);
  await expect(fs.stat(resolveOpenClawStateSqlitePath())).rejects.toMatchObject({
    code: "ENOENT",
  });
  await expect(fs.readFile(quarantinePath, "utf-8")).resolves.toBe(historicalBytes);
  await saveJobs();
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
  expect(await store.loadCronQuarantinedJobs(storePath)).toEqual(historicalJobs);
  await expect(fs.stat(quarantinePath)).resolves.toBeDefined();
  expectNote("could not archive the legacy cron file", "Doctor warnings");
  rename.mockRestore();

  await repairCronStore();

  expect(await store.loadCronQuarantinedJobs(storePath)).toEqual(historicalJobs);
  await expect(fs.stat(`${quarantinePath}.migrated`)).resolves.toBeDefined();
});

it("surfaces cron payload model overrides without rewriting current jobs", async () => {
  const jobs = [
    makeJob({
      id: "api-pinned",
      payload: agentTurn("Brief", { model: "openai/gpt-5.4", thinking: "high" }),
    }),
    makeJob({ id: "alias-pinned", payload: agentTurn("Brief", { model: "gpt" }) }),
    makeJob({ id: "inherits-default", payload: agentTurn("Brief") }),
    makeJob({
      id: "disabled-pinned",
      enabled: false,
      payload: agentTurn("Dormant job", { model: "ollama/qwen3" }),
    }),
  ];
  const cfg = cronConfig();
  cfg.agents = { defaults: { model: { primary: "test:opus", fallbacks: [] } } };
  await expectAdvisory(
    jobs,
    [
      "2 jobs set `payload.model`",
      "Provider namespaces: bare/alias=1, openai=1",
      "2 jobs use a different model than `agents.defaults.model`",
      "alias-pinned -> gpt",
    ],
    ["ollama", "jobs.json"],
    cfg,
  );
  expect((await firstJob()).payload).toMatchObject({
    model: "openai/gpt-5.4",
    thinking: "high",
  });
});
const RUNNING_AT_MS = Date.parse("2026-05-01T00:00:00.000Z");
const healthJob = (id: string, state: StoredJob, enabled = true, name = "SQLite job") =>
  makeJob({ id, state, enabled, name });
it.each([
  {
    label: "disabled and enabled in-flight jobs without clearing their state",
    jobs: [
      healthJob("running-job", { runningAtMs: RUNNING_AT_MS }, false),
      healthJob("running-enabled", { runningAtMs: RUNNING_AT_MS + 1000 }),
    ],
    notes: [
      "2 automations are still marked in-flight",
      "marks such runs interrupted the next time it starts",
      "openclaw automations list --all",
      "openclaw automations show <id>",
    ],
    absent: ["shows it as `running`"],
  },
  {
    label: "only enabled jobs at the chronic failure threshold",
    jobs: [
      healthJob("failing-a", { lastRunStatus: "error", consecutiveErrors: 3 }),
      healthJob("failing-b", { lastRunStatus: "error", consecutiveErrors: 12 }),
      healthJob("recovering", { lastRunStatus: "error", consecutiveErrors: 2 }),
      healthJob("disabled-exhausted", { lastRunStatus: "error", consecutiveErrors: 9 }, false),
    ],
    notes: ["2 automations have failed 3+ runs in a row"],
    absent: [],
  },
  {
    label: "auto-disabled jobs with their reasons and recovery commands",
    jobs: [
      healthJob(
        "run-failure-job",
        {
          consecutiveErrors: 10,
          autoDisabled: { reason: "consecutive-failures", atMs: 1, consecutiveErrors: 10 },
        },
        false,
        "Run failure job",
      ),
      healthJob(
        "schedule-error-job",
        {
          scheduleErrorCount: 3,
          autoDisabled: { reason: "schedule-errors", atMs: 2, consecutiveErrors: 3 },
        },
        false,
        "Schedule error job",
      ),
      healthJob("disabled-one-shot", { lastRunStatus: "error", consecutiveErrors: 9 }, false),
    ],
    notes: [
      "2 automations are auto-disabled",
      "Run failure job (run-failure-job)",
      "recorded reason `consecutive-failures` after 10",
      "openclaw automations enable run-failure-job",
      "Schedule error job (schedule-error-job)",
      "recorded reason `schedule-errors` after 3",
      "openclaw automations enable schedule-error-job",
    ],
    absent: ["disabled-one-shot"],
  },
])("reports $label", async ({ jobs, notes, absent }) => expectAdvisory(jobs, notes, absent));

it.each([
  {
    label: "advises on shell/process prompts without a --fix note (#94655)",
    tools: [["*"], ["bash"], ["process"]],
    message: "Run python3 scripts/check_mail.py and send a compact summary if anything changed.",
    notes: [
      "3 isolated automations drive shell/process tools",
      ...[1, 2, 3].map((index) => `Shell prompt job ${index}`),
      "informational only",
    ],
    absent: ["Cron store issues detected", "openclaw doctor --fix", "jobs.json"],
  },
  {
    label: "keeps restricted command prompts actionable without a --fix note",
    tools: [["read", "message"]],
    message: "Command to run:\n- command: python3 scripts/check_mail.py\n- workdir: /tmp/workspace",
    notes: ["lacks shell/process tool access", "Recreate it as a command automation"],
    absent: [
      "informational only",
      "keep running as-is",
      "Cron store issues detected",
      "openclaw doctor --fix",
    ],
  },
])("$label", async ({ tools, message, notes, absent }) => {
  const jobs = tools.map((toolsAllow, index) =>
    makeJob({
      id: `shell-prompt-job-${index + 1}`,
      name: `Shell prompt job ${index + 1}`,
      schedule: { kind: "cron", expr: "*/30 * * * *", tz: "UTC" },
      payload: agentTurn(message, { toolsAllow }),
      delivery: { mode: "announce" },
    }),
  );
  await expectAdvisory(jobs, notes, absent);
  expect(await readJobs()).toEqual(jobs);
});

it("quarantines malformed SQLite identifiers without dropping their definitions", async () => {
  await seedRawJobs(
    legacyJob({ id: 42, jobId: undefined, notify: false }),
    legacyJob({ id: undefined, jobId: undefined, name: "Missing id", notify: false }),
  );

  await repairCronStore();

  expect(await readJobs()).toEqual([]);
  expect(await store.loadCronQuarantinedJobs(storePath)).toMatchObject([
    { reason: "missing-id", job: { id: 42 } },
    { reason: "missing-id", job: { name: "Missing id" } },
  ]);
});

it("migrates notify fallback while preserving announce delivery", async () => {
  await seedRawJobs(
    makeJob({
      id: "notify-and-announce",
      notify: true,
      payload: agentTurn("Status"),
      delivery: { to: "telegram:123" },
    }),
    ...["none", "webhook"].map((mode) =>
      makeJob({
        id: `notify-${mode}`,
        notify: true,
        sessionTarget: "main",
        delivery: { mode, to: mode === "none" ? "123456789" : "ftp://example.invalid/cron" },
      }),
    ),
  );
  await repairCronStore();
  const jobs = await readJobs();
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
  await seedRawJobs(
    legacyJob({ id: "notify-credential-config", jobId: undefined, delivery: undefined }),
  );

  await repairCronStore(undefined, cronConfig(credentialUrl.href));

  const job = await firstJob();
  expect([job.notify, job.delivery]).toEqual([undefined, undefined]);
  const { configJobs: persisted } = await store.loadCronJobsStoreWithConfigJobs(storePath);
  expect(persisted[0]?.notify).toBe(true);
  expectNote(
    "cron.webhook is not a valid HTTP(S) URL so doctor cannot migrate it automatically",
    "Doctor warnings",
  );
  expect(JSON.stringify(noteMock.mock.calls)).not.toContain(credentialUrl.href);
});

it("removes inert legacy notify:true for delivery.mode none when cron.webhook is unset and stops looping (#44460)", async () => {
  await seedRawJobs(
    makeJob({
      id: "notify-none-unset",
      name: "Notify none unset",
      notify: true,
      delivery: { mode: "none" },
    }),
  );

  const cfg = { cron: { store: storePath } } as unknown as OpenClawConfig;
  await repairCronStore(undefined, cfg);

  const { configJobs: persisted } = await store.loadCronJobsStoreWithConfigJobs(storePath);
  expect(persisted).toHaveLength(1);
  expect(persisted[0]?.notify).toBeUndefined();
  expect(persisted[0]?.delivery).toEqual({ mode: "none" });

  noteMock.mockClear();
  await repairCronStore(undefined, cfg);
  expectNoNote("still uses legacy `notify: true`");
});

it("warns and continues when the cron job store cannot be read", async () => {
  // EISDIR is deterministic even under root, which can bypass permission failures (#86102).
  await fs.mkdir(storePath.replace(/\.json$/, "-quarantine.json"), { recursive: true });
  const prompter = makePrompter(true);
  await expect(repairCronStore(prompter)).resolves.toBeUndefined();
  expect(prompter.confirm).not.toHaveBeenCalled();
  expectNote("Unable to read cron job store at");
  expectNote("later health checks will continue");
});

it("inspects cron under offline Doctor custody when disposable snapshot allocation is unavailable", async () => {
  const env = { ...process.env, OPENCLAW_STATE_DIR: tempRoot! };
  vi.stubEnv("OPENCLAW_STATE_DIR", tempRoot!);
  await store.saveCronStore(storePath, { version: 1, jobs: [legacyJob() as never] });
  await stateDb.closeOpenClawStateDatabaseAsync();
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
