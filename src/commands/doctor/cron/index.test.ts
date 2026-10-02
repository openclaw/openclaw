import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../../test/helpers/sqlite-statement-execution-counter.js";
import type { OpenClawConfig } from "../../../config/config.js";
import { readCronRunHistoryPageForTests } from "../../../cron/run-history.test-support.js";
import {
  loadCronJobsStoreWithConfigJobs,
  loadCronQuarantinedJobs,
  loadCronStore,
  saveCronQuarantinedJobs,
  saveCronStore,
} from "../../../cron/store.js";
import { cronStoreKey } from "../../../cron/store/key.js";
import { closeOpenClawStateDatabaseAsync } from "../../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../../state/openclaw-state-db.paths.js";
import { withRestoredMocks } from "../../../test-utils/vitest-spies.js";
import { collectLegacyCronStoreHealthFindings, maybeRepairLegacyCronStore } from "./index.js";

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
    jobId: "legacy-job",
    name: "Legacy job",
    notify: true,
    createdAtMs: Date.parse("2026-02-01T00:00:00.000Z"),
    updatedAtMs: Date.parse("2026-02-02T00:00:00.000Z"),
    schedule: { kind: "cron", cron: "0 7 * * *", tz: "UTC" },
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
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.writeFile(storePath, JSON.stringify({ version: 1, jobs }, null, 2), "utf-8");
}

async function writeCurrentCronStore(jobs: StoredJob[]) {
  await saveCronStore(storePath, { version: 1, jobs: jobs as never });
}

async function writeLegacyCronArrayStore(jobs: StoredJob[]) {
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.writeFile(storePath, JSON.stringify(jobs, null, 2), "utf-8");
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

function createFsError(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: ${message}`), { code });
}

function mockExdevRename(filePath: string) {
  const realRename = fs.rename.bind(fs);
  return vi.spyOn(fs, "rename").mockImplementation(async (oldPath, newPath) => {
    if (oldPath === filePath) {
      throw createFsError("EXDEV", "cross-device link not permitted, rename");
    }
    return await realRename(oldPath, newPath);
  });
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

  it("reports legacy cron store, run-log, and payload findings without mutating files", async () => {
    await writeLegacyCronArrayStore([createLegacyCronJob()]);
    const runLogPath = path.join(path.dirname(storePath), "runs", "legacy-job.jsonl");
    await fs.mkdir(path.dirname(runLogPath), { recursive: true });
    await fs.writeFile(runLogPath, "");
    const source = await fs.readFile(storePath, "utf-8");
    const findings = await collectLegacyCronStoreHealthFindings({
      cfg: createCronConfig(),
    });
    for (const [requirement, findingPath] of [
      ["legacy-cron-store", storePath],
      ["legacy-notify-fallback", resolveOpenClawStateSqlitePath()],
    ]) {
      expect(findings).toContainEqual(
        expect.objectContaining({
          checkId: "core/doctor/legacy-cron-store",
          severity: "warning",
          path: findingPath,
          requirement,
        }),
      );
    }
    expect(findings.some(({ requirement }) => requirement === "legacy-cron-run-logs")).toBe(true);
    await expect(fs.readFile(storePath, "utf-8")).resolves.toBe(source);
    await expect(fs.stat(runLogPath)).resolves.toBeDefined();
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

  it("detects, repairs, reloads, and idempotently migrates the stable documented SQLite trigger script", async () => {
    const stableScript =
      "const res = await tools.call('exec', { command: 'gh pr checks 123 --json state -q \\'.[].state\\' | sort -u' }); const status = String(res?.result?.details?.aggregated ?? '').trim(); json({ fire: status !== trigger.state?.status, message: `PR 123 CI: ${trigger.state?.status ?? 'unknown'} -> ${status}`, state: { status } });";
    const ignoredResultScript =
      "// Preserve the trigger comment.\nawait tools.call(\"exec\", { command: 'echo done' });";
    const betaOnlyPayloadScript =
      "await tools.call('exec', { command: 'leave payload unchanged' })";
    await writeCurrentCronStore([
      createCurrentCronJob({
        id: "stable-pr-watcher",
        name: "Stable PR watcher",
        schedule: { kind: "every", everyMs: 30_000 },
        trigger: { script: stableScript, once: false },
      }),
      createCurrentCronJob({
        id: "ignored-result",
        name: "Ignored result watcher",
        trigger: { script: ignoredResultScript },
      }),
      createCurrentCronJob({
        id: "beta-script-payload",
        payload: { kind: "script", script: betaOnlyPayloadScript },
      }),
    ]);
    const cfg = createCronConfig();
    const findings = await collectLegacyCronStoreHealthFindings({ cfg });
    for (const name of ["Stable PR watcher", "Ignored result watcher"]) {
      expect(findings).toContainEqual(
        expect.objectContaining({
          requirement: "legacy-cron-trigger-script",
          message: expect.stringContaining(name),
        }),
      );
    }
    expect((await loadCronStore(storePath)).jobs[0]?.trigger?.script).toBe(stableScript);
    const decline = makePrompter(false);
    await repairCronStore(decline);
    expect(decline.confirm).toHaveBeenCalledTimes(1);
    expectNoteContaining("Stable PR watcher");
    expect((await loadCronStore(storePath)).jobs[0]?.trigger?.script).toBe(stableScript);
    noteMock.mockClear();
    await repairCronStore();
    const expectedScript = stableScript
      .replace("tools.call('exec', ", "exec(")
      .replace("res?.result?.details", "res");
    const reloaded = await loadCronJobsStoreWithConfigJobs(storePath);
    expect(reloaded.store.jobs[0]?.trigger?.script).toBe(expectedScript);
    expect(reloaded.store.jobs[1]?.trigger?.script).toBe(
      "// Preserve the trigger comment.\nawait exec({ command: 'echo done' });",
    );
    expect(reloaded.store.jobs[2]?.payload).toEqual({
      kind: "script",
      script: betaOnlyPayloadScript,
    });
    expect(reloaded.configJobs[0]?.trigger).toEqual({ script: expectedScript, once: false });
    expect(fsSync.existsSync(storePath)).toBe(false);
    expectNoteContaining("Stable PR watcher", "Doctor changes");
    expectNoteContaining("2 legacy cron trigger scripts", "Doctor changes");
    noteMock.mockClear();
    const second = makePrompter(true);
    await repairCronStore(second);
    expect(second.confirm).not.toHaveBeenCalled();
    expectNoNoteContaining("legacy trigger script");
    expect((await loadCronStore(storePath)).jobs[0]?.trigger?.script).toBe(expectedScript);
  });

  it("leaves unsupported legacy trigger scripts untouched and reports redacted per-job remediation", async () => {
    const scripts: Array<[string, string]> = [
      ["dynamic-name", "await tools.call(toolName, { command: 'secret-token' })"],
      ["dynamic-args", "await tools.call('exec', args)"],
      [
        "mixed-legacy",
        "const res = await tools.call('exec', { command: 'secret-token' }); tools.search('x')",
      ],
      [
        "envelope-result",
        "const res = await tools.call('exec', { command: 'x' }); json(res.result)",
      ],
      ["envelope-tool", "const res = await tools.call('exec', { command: 'x' }); json(res.tool)"],
      [
        "destructured",
        "const { result } = await tools.call('exec', { command: 'x' }); json(result)",
      ],
      [
        "reassigned",
        "let res = await tools.call('exec', { command: 'x' }); res = other; json(res.result.details)",
      ],
      ["shadowed", "const tools = localTools; await tools.call('exec', { command: 'x' })"],
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
      [
        "commented-envelope",
        "const res = await tools.call('exec', { command: 'x' }); json(res.result /* preserve this */ .details)",
      ],
      [
        "aliased-result",
        "const res = await tools.call('exec', { command: 'x' }); const alias = res",
      ],
      ["shadowed-exec", "const exec = localExec; await tools.call('exec', { command: 'x' })"],
      [
        "ambiguous-scope",
        "const res = await tools.call('exec', { command: 'x' }); function inspect() { return res.result.details }",
      ],
    ];
    const unsupportedScripts = scripts.map(([id, script]) => ({ id, script }));
    await writeCurrentCronStore(
      unsupportedScripts.map(({ id, script }) =>
        createCurrentCronJob({ id, name: `Legacy ${id}`, trigger: { script } }),
      ),
    );
    const cfg = createCronConfig();

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
      expectNoteContaining(`Legacy ${id}`, "Cron");
    }
    expectNoteContaining("manually");
    expectNoNoteContaining("secret-token");
    expect(
      (await loadCronStore(storePath)).jobs.map((job) => ({
        id: job.id,
        script: job.trigger?.script,
      })),
    ).toEqual(unsupportedScripts);
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
      .mockRejectedValueOnce(createFsError("EACCES", "archive unavailable"));
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

  it("falls back to copy+unlink when renaming the legacy cron store fails with EXDEV", async () => {
    const archivePath = `${storePath}.migrated.2`;
    const sourceMtime = new Date("2026-01-02T03:04:05.000Z");
    await writeLegacyCronArrayStore([createLegacyCronJob()]);
    await fs.writeFile(`${storePath}.migrated`, "old archive");
    await fs.chmod(storePath, 0o640);
    await fs.utimes(storePath, sourceMtime, sourceMtime);

    const renameSpy = mockExdevRename(storePath);
    const realOpen = fs.open.bind(fs);
    let archiveFileSynced = false;
    const openSpy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await realOpen(...args);
      if (args[0] === archivePath && args[1] === "r+") {
        const realSync = handle.sync.bind(handle);
        vi.spyOn(handle, "sync").mockImplementation(async () => {
          archiveFileSynced = true;
          await realSync();
        });
      }
      return handle;
    });

    await withRestoredMocks([openSpy, renameSpy], async () => {
      await repairCronStore();

      expect(renameSpy).toHaveBeenCalled();
      expect(archiveFileSynced).toBe(true);
      await expect(fs.readFile(`${storePath}.migrated`, "utf-8")).resolves.toBe("old archive");
      const job = requirePersistedJob(await readPersistedJobs(), 0);
      expect(job.jobId).toBeUndefined();
      expect(job.notify).toBeUndefined();
      expect(job).toMatchObject({
        id: "legacy-job",
        schedule: { kind: "cron", expr: "0 7 * * *", tz: "UTC" },
        delivery: { mode: "webhook", to: WEBHOOK },
        payload: { kind: "systemEvent", text: "Morning brief" },
      });
      await expect(fs.stat(storePath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.readFile(archivePath, "utf-8")).resolves.toContain("legacy-job");
      const archiveStat = await fs.stat(archivePath);
      if (process.platform !== "win32") {
        expect(archiveStat.mode & 0o777).toBe(0o640);
      }
      expect(archiveStat.mtimeMs).toBe(sourceMtime.getTime());
      expectNoteContaining("Cron store migrated to SQLite", "Doctor changes");
      expectNoNoteContaining("could not archive the legacy cron file", "Doctor warnings");
    });

    noteMock.mockClear();
    await repairCronStore();
    expectNoNoteContaining("Legacy cron job storage detected");
  });

  it("refuses a migration plan when the legacy source changes during confirmation", async () => {
    await writeCronStore([createLegacyCronJob()]);
    const changedJob = createLegacyCronJob({ jobId: "changed-job", name: "Changed job" });
    const prompter = {
      confirm: vi.fn(async () => {
        await writeCronStore([changedJob]);
        return true;
      }),
    };

    await repairCronStore(prompter);

    expect(await readPersistedJobs()).toHaveLength(0);
    await expect(fs.readFile(storePath, "utf-8")).resolves.toContain("changed-job");
    await expect(fs.stat(`${storePath}.migrated`)).rejects.toMatchObject({ code: "ENOENT" });
    expectNoteContaining("changed while doctor was preparing", "Doctor warnings");
    expectNoNoteContaining("Cron store migrated to SQLite", "Doctor changes");

    noteMock.mockClear();
    await repairCronStore();
    expect((await readPersistedJobs()).map((job) => job.id)).toEqual(["changed-job"]);
    await expect(fs.stat(storePath)).rejects.toMatchObject({ code: "ENOENT" });
    expectNoteContaining("Cron store migrated to SQLite", "Doctor changes");
  });

  it("keeps a source that changes during an EXDEV copy and imports it on retry", async () => {
    const archivePath = `${storePath}.migrated`;
    await writeCronStore([createLegacyCronJob()]);

    const renameSpy = mockExdevRename(storePath);
    const realCopyFile = fs.copyFile.bind(fs);
    const copyFileSpy = vi.spyOn(fs, "copyFile").mockImplementation(async (src, dest, mode) => {
      await realCopyFile(src, dest, mode);
      if (src === storePath) {
        await writeCronStore([createLegacyCronJob({ jobId: "late-job", name: "Late job" })]);
      }
    });

    await withRestoredMocks([copyFileSpy, renameSpy], repairCronStore);

    expect((await readPersistedJobs()).map((job) => job.id)).toEqual(["legacy-job"]);
    await expect(fs.readFile(storePath, "utf-8")).resolves.toContain("late-job");
    await expect(fs.stat(archivePath)).rejects.toMatchObject({ code: "ENOENT" });
    expectNoteContaining("changed during archival", "Doctor warnings");

    noteMock.mockClear();
    await repairCronStore();
    expect((await readPersistedJobs()).map((job) => job.id)).toEqual(["legacy-job", "late-job"]);
    await expect(fs.stat(storePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(archivePath)).resolves.toBeTruthy();
  });

  it("restores an archived state sidecar when the primary archive fails", async () => {
    const statePath = storePath.replace(/\.json$/, "-state.json");
    await writeCronStore([createLegacyCronJob()]);
    await fs.writeFile(statePath, JSON.stringify({ version: 1, jobs: {} }), "utf-8");

    const realRename = fs.rename.bind(fs);
    const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (oldPath, newPath) => {
      if (oldPath === storePath) {
        throw createFsError("EIO", "primary archive failed");
      }
      return await realRename(oldPath, newPath);
    });

    await withRestoredMocks([renameSpy], repairCronStore);

    await expect(fs.stat(storePath)).resolves.toBeTruthy();
    await expect(fs.stat(statePath)).resolves.toBeTruthy();
    await expect(fs.stat(`${statePath}.migrated`)).rejects.toMatchObject({ code: "ENOENT" });
    expectNoteContaining("EIO", "Doctor warnings");
    expectNoNoteContaining("Cron store migrated to SQLite", "Doctor changes");

    noteMock.mockClear();
    await repairCronStore();
    await expect(fs.stat(storePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(statePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(`${statePath}.migrated`)).resolves.toBeTruthy();
    expectNoteContaining("Cron store migrated to SQLite", "Doctor changes");
  });

  it("restores the primary source when a state sidecar is recreated during archival", async () => {
    const statePath = storePath.replace(/\.json$/, "-state.json");
    await writeCronStore([createLegacyCronJob()]);
    await fs.writeFile(statePath, JSON.stringify({ version: 1, jobs: {} }), "utf-8");

    const realRename = fs.rename.bind(fs);
    const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (oldPath, newPath) => {
      if (oldPath === storePath) {
        await fs.writeFile(
          statePath,
          JSON.stringify({ version: 1, jobs: { "legacy-job": { state: { lastRunAtMs: 2 } } } }),
          "utf-8",
        );
      }
      return await realRename(oldPath, newPath);
    });

    await withRestoredMocks([renameSpy], repairCronStore);

    await expect(fs.stat(storePath)).resolves.toBeTruthy();
    await expect(fs.readFile(statePath, "utf-8")).resolves.toContain("lastRunAtMs");
    await expect(fs.stat(`${statePath}.migrated`)).resolves.toBeTruthy();
    expectNoteContaining("state appeared after", "Doctor warnings");
    expectNoteContaining("archive rollback failed", "Doctor warnings");
    expectNoNoteContaining("Cron store migrated to SQLite", "Doctor changes");
  });

  it("does not resurrect a migrated job removed before an archive retry", async () => {
    const archivePath = `${storePath}.migrated`;
    await writeCronStore(
      Array.from({ length: 2 }, () => createLegacyCronJob({ id: undefined, jobId: undefined })),
    );

    const renameSpy = mockExdevRename(storePath);
    const realUnlink = fs.unlink.bind(fs);
    const unlinkSpy = vi.spyOn(fs, "unlink").mockImplementation(async (target) => {
      if (target === storePath) {
        throw createFsError("EBUSY", "resource busy, unlink");
      }
      return await realUnlink(target);
    });

    await withRestoredMocks([unlinkSpy, renameSpy], async () => {
      await repairCronStore();
      expectNoteContaining("EBUSY", "Doctor warnings");
      expectNoNoteContaining("Cron store migrated to SQLite", "Doctor changes");
      await expect(fs.stat(storePath)).resolves.toBeTruthy();
      await expect(fs.stat(archivePath)).rejects.toMatchObject({ code: "ENOENT" });
    });
    const firstJobs = await readPersistedJobs();
    expect(firstJobs).toHaveLength(2);
    const ids = firstJobs.map((job) => job.id);
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) {
      expect(id).toMatch(/^cron-migrated-\d+-[a-f0-9]{64}$/);
    }

    // Simulate runtime-owned one-shot deletion after SQLite import but before cleanup retry.
    await writeCurrentCronStore([requirePersistedJob(firstJobs, 1)]);
    noteMock.mockClear();
    await repairCronStore();

    expect(await readPersistedJobs()).toEqual([firstJobs[1]]);
    await expect(fs.stat(storePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(archivePath)).resolves.toBeTruthy();
    await expect(fs.stat(`${archivePath}.2`)).rejects.toMatchObject({ code: "ENOENT" });
    expectNoteContaining("Cron store migrated to SQLite", "Doctor changes");
  });

  it("imports legacy-only jobs when SQLite already has cron rows", async () => {
    await writeCurrentCronStore([createCurrentCronJob({ id: "legacy-job", name: "SQLite wins" })]);
    await writeCronStore([
      createLegacyCronJob({ name: "Stale duplicate" }),
      createLegacyCronJob({ jobId: "legacy-only", name: "Legacy only" }),
    ]);
    await repairCronStore();
    expect(await readPersistedJobs()).toMatchObject([
      { id: "legacy-job", name: "SQLite wins" },
      { id: "legacy-only", name: "Legacy only" },
    ]);
    expectNoteContaining("1 legacy JSON cron job will be imported into SQLite");
    expectNoteContaining("Cron store migrated to SQLite", "Doctor changes");
  });

  it("migrates legacy run logs even when the legacy job store was already archived", async () => {
    await writeCurrentCronStore([createCurrentCronJob()]);
    const runLogPath = path.join(path.dirname(storePath), "runs", "sqlite-job.jsonl");
    await fs.mkdir(path.dirname(runLogPath), { recursive: true });
    await fs.writeFile(
      runLogPath,
      `${JSON.stringify({
        ts: Date.parse("2026-02-04T00:00:00.000Z"),
        jobId: "sqlite-job",
        action: "finished",
        status: "ok",
        summary: "done",
      })}\n`,
      "utf-8",
    );

    await repairCronStore();

    const entries = readCronRunHistoryPageForTests({
      storeKey: cronStoreKey(storePath),
      jobId: "sqlite-job",
    }).entries;
    expect(entries).toMatchObject([{ jobId: "sqlite-job", summary: "done" }]);
    await expect(fs.stat(runLogPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(`${runLogPath}.migrated`)).resolves.toBeTruthy();
    expectNoteContaining("legacy JSON cron run logs will be imported into SQLite");
    expectNoteContaining("Cron run logs migrated to SQLite", "Doctor changes");
  });

  it("does not report store normalization when run-log migration fails", async () => {
    await writeCurrentCronStore([createCurrentCronJob()]);
    const runLogPath = path.join(path.dirname(storePath), "runs", "sqlite-job.jsonl");
    await fs.mkdir(path.dirname(runLogPath), { recursive: true });
    await fs.writeFile(runLogPath, "{}\n", "utf-8");

    const realReadFileSync = fsSync.readFileSync.bind(fsSync);
    const readSpy = vi.spyOn(fsSync, "readFileSync").mockImplementation((filePath, options) => {
      if (filePath === runLogPath) {
        throw createFsError("EIO", "run-log read failed");
      }
      return realReadFileSync(filePath as never, options as never) as never;
    });

    await withRestoredMocks([readSpy], repairCronStore);

    await expect(fs.stat(runLogPath)).resolves.toBeTruthy();
    expectNoteContaining("run-log read failed", "Doctor warnings");
    expectNoNoteContaining("Cron store normalized", "Doctor changes");
    expectNoNoteContaining("Cron run logs migrated", "Doctor changes");
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

  it("repairs malformed persisted cron ids before list rendering sees them", async () => {
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

    const jobs = await readPersistedJobs();
    const firstJob = requirePersistedJob(jobs, 0);
    const secondJob = requirePersistedJob(jobs, 1);
    expect(firstJob.id).toBe("42");
    expect(secondJob.id).toMatch(/^cron-/);
    expectNoteContaining("stores `id` as a non-string value");
    expectNoteContaining("missing a canonical string `id`");
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

  it("migrates valid schedule variants and quarantines invalid rows", async () => {
    await writeCronStore(
      [
        { kind: " CRON ", cron: "0 7 * * *", tz: "UTC" },
        { kind: "Every", everyMs: 60_000 },
        { kind: " Stream ", command: ["node", "events.mjs"], mode: " LINE " },
        { kind: "cron" },
      ].map((schedule, index) =>
        createLegacyCronJob({ id: `variant-${index}`, jobId: undefined, enabled: true, schedule }),
      ),
    );
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
    await fs.mkdir(storePath, { recursive: true });
    const prompter = makePrompter(true);
    await expect(repairCronStore(prompter)).resolves.toBeUndefined();
    expect(prompter.confirm).not.toHaveBeenCalled();
    expectNoteContaining("Unable to read cron job store at");
    expectNoteContaining("later health checks will continue");
  });
});

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
