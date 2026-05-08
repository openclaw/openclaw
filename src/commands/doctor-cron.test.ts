import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { loadCronStore, saveCronStore } from "../cron/store.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { maybeRepairLegacyCronStore, noteLegacyWhatsAppCrontabHealthCheck } from "./doctor-cron.js";

type TerminalNote = (message: string, title?: string) => void;

const noteMock = vi.hoisted(() => vi.fn<TerminalNote>());

vi.mock("../terminal/note.js", () => ({
  note: noteMock,
}));

let tempRoot: string | null = null;
let originalOpenClawStateDir: string | undefined;

async function makeTempStorePath() {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-doctor-cron-"));
  originalOpenClawStateDir = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = path.join(tempRoot, "state");
  return path.join(tempRoot, "cron", "jobs.json");
}

afterEach(async () => {
  closeOpenClawStateDatabaseForTest();
  if (originalOpenClawStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = originalOpenClawStateDir;
  }
  originalOpenClawStateDir = undefined;
  noteMock.mockClear();
  if (tempRoot) {
    await fs.rm(tempRoot, { recursive: true, force: true });
    tempRoot = null;
  }
});

function makePrompter(confirmResult = true) {
  return {
    confirm: vi.fn().mockResolvedValue(confirmResult),
  };
}

function createCronConfig(storePath: string): OpenClawConfig {
  return {
    cron: {
      store: storePath,
      webhook: "https://example.invalid/cron-finished",
    },
  };
}

function createLegacyCronJob(overrides: Record<string, unknown> = {}) {
  return {
    jobId: "legacy-job",
    name: "Legacy job",
    notify: true,
    createdAtMs: Date.parse("2026-02-01T00:00:00.000Z"),
    updatedAtMs: Date.parse("2026-02-02T00:00:00.000Z"),
    schedule: { kind: "cron", cron: "0 7 * * *", tz: "UTC" },
    payload: {
      kind: "systemEvent",
      text: "Morning brief",
    },
    state: {},
    ...overrides,
  };
}

async function writeCronStore(storePath: string, jobs: Array<Record<string, unknown>>) {
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.writeFile(
    storePath,
    JSON.stringify(
      {
        version: 1,
        jobs,
      },
      null,
      2,
    ),
    "utf-8",
  );
}

async function readPersistedJobs(storePath: string): Promise<Array<Record<string, unknown>>> {
  const persisted = JSON.parse(await fs.readFile(storePath, "utf-8")) as {
    jobs: Array<Record<string, unknown>>;
  };
  return persisted.jobs;
}

function requirePersistedJob(jobs: Array<Record<string, unknown>>, index: number) {
  const job = jobs[index];
  if (!job) {
    throw new Error(`expected persisted cron job ${index}`);
  }
  return job;
}

describe("maybeRepairLegacyCronStore", () => {
  it("repairs legacy cron store fields and migrates notify fallback to webhook delivery", async () => {
    const storePath = await makeTempStorePath();
    await writeCronStore(storePath, [createLegacyCronJob()]);

    const noteSpy = noteMock;
    const cfg = createCronConfig(storePath);

    await maybeRepairLegacyCronStore({
      cfg,
      options: {},
      prompter: makePrompter(true),
    });

    const persisted = await loadCronStore(storePath);
    const [job] = persisted.jobs;
    const legacyJob = job as Record<string, unknown> | undefined;
    expect(legacyJob?.jobId).toBeUndefined();
    expect(job?.id).toBe("legacy-job");
    expect(legacyJob?.notify).toBeUndefined();
    expect(job?.schedule).toMatchObject({
      kind: "cron",
      expr: "0 7 * * *",
      tz: "UTC",
    });
    expect(job.delivery).toMatchObject({
      mode: "webhook",
      to: "https://example.invalid/cron-finished",
    });
    expect(job.payload).toMatchObject({
      kind: "systemEvent",
      text: "Morning brief",
    });

    expect(noteSpy).toHaveBeenCalledWith(
      expect.stringContaining("Legacy cron job storage detected"),
      "Cron",
    );
    expect(noteSpy).toHaveBeenCalledWith(
      expect.stringContaining("Cron store normalized"),
      "Doctor changes",
    );
    await expect(fs.stat(storePath)).rejects.toThrow();
  });

  it("imports legacy cron runtime state sidecars into SQLite", async () => {
    const storePath = await makeTempStorePath();
    const statePath = storePath.replace(/\.json$/, "-state.json");
    await writeCronStore(storePath, [
      {
        id: "stateful-job",
        name: "Stateful job",
        enabled: true,
        createdAtMs: Date.parse("2026-02-01T00:00:00.000Z"),
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "tick" },
        state: {},
      },
    ]);
    await fs.writeFile(
      statePath,
      JSON.stringify(
        {
          version: 1,
          jobs: {
            "stateful-job": {
              updatedAtMs: Date.parse("2026-02-01T00:01:00.000Z"),
              state: { nextRunAtMs: Date.parse("2026-02-01T00:02:00.000Z") },
            },
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    await maybeRepairLegacyCronStore({
      cfg: createCronConfig(storePath),
      options: {},
      prompter: makePrompter(true),
    });

    const loaded = await loadCronStore(storePath);
    expect(loaded.jobs[0]?.updatedAtMs).toBe(Date.parse("2026-02-01T00:01:00.000Z"));
    expect(loaded.jobs[0]?.state.nextRunAtMs).toBe(Date.parse("2026-02-01T00:02:00.000Z"));
    await expect(fs.stat(statePath)).rejects.toThrow();
    expect(noteMock).toHaveBeenCalledWith(
      expect.stringContaining("Imported 1 cron runtime state row into SQLite"),
      "Doctor changes",
    );
  });

  it("imports legacy cron runtime state sidecars when job definitions are already SQLite-backed", async () => {
    const storePath = await makeTempStorePath();
    const statePath = storePath.replace(/\.json$/, "-state.json");
    await saveCronStore(storePath, {
      version: 1,
      jobs: [
        {
          id: "stateful-job",
          name: "Stateful job",
          enabled: true,
          createdAtMs: Date.parse("2026-02-01T00:00:00.000Z"),
          updatedAtMs: Date.parse("2026-02-01T00:00:00.000Z"),
          schedule: { kind: "every", everyMs: 60_000 },
          sessionTarget: "main",
          wakeMode: "next-heartbeat",
          payload: { kind: "systemEvent", text: "tick" },
          state: {},
        },
      ],
    });
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    await fs.writeFile(
      statePath,
      JSON.stringify(
        {
          version: 1,
          jobs: {
            "stateful-job": {
              updatedAtMs: Date.parse("2026-02-01T00:01:00.000Z"),
              state: { nextRunAtMs: Date.parse("2026-02-01T00:02:00.000Z") },
            },
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    await maybeRepairLegacyCronStore({
      cfg: createCronConfig(storePath),
      options: {},
      prompter: makePrompter(true),
    });

    const loaded = await loadCronStore(storePath);
    expect(loaded.jobs[0]?.updatedAtMs).toBe(Date.parse("2026-02-01T00:01:00.000Z"));
    expect(loaded.jobs[0]?.state.nextRunAtMs).toBe(Date.parse("2026-02-01T00:02:00.000Z"));
    await expect(fs.stat(storePath)).rejects.toThrow();
    await expect(fs.stat(statePath)).rejects.toThrow();
    expect(noteMock).toHaveBeenCalledWith(
      expect.stringContaining("Imported 1 cron runtime state row into SQLite"),
      "Doctor changes",
    );
  });

  it("imports legacy cron run-log files into SQLite", async () => {
    const storePath = await makeTempStorePath();
    const logPath = path.join(path.dirname(storePath), "runs", "stateful-job.jsonl");
    await writeCronStore(storePath, [
      {
        id: "stateful-job",
        name: "Stateful job",
        enabled: true,
        createdAtMs: Date.parse("2026-02-01T00:00:00.000Z"),
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "tick" },
        state: {},
      },
    ]);
    await fs.mkdir(path.dirname(logPath), { recursive: true });
    await fs.writeFile(
      logPath,
      `${JSON.stringify({ ts: 1, jobId: "stateful-job", action: "finished", status: "ok" })}\n`,
      "utf-8",
    );

    await maybeRepairLegacyCronStore({
      cfg: createCronConfig(storePath),
      options: {},
      prompter: makePrompter(true),
    });

    const { readCronRunLogEntriesFromSqliteSync } = await import("../cron/run-log.js");
    expect(readCronRunLogEntriesFromSqliteSync(storePath, { jobId: "stateful-job" })).toEqual([
      expect.objectContaining({ ts: 1, status: "ok" }),
    ]);
    await expect(fs.stat(logPath)).rejects.toThrow();
    expect(noteMock).toHaveBeenCalledWith(
      expect.stringContaining("Imported 1 cron run-log row from 1 legacy run-log file"),
      "Doctor changes",
    );
  });

  it("imports legacy cron run-log files when job definitions are already SQLite-backed", async () => {
    const storePath = await makeTempStorePath();
    const logPath = path.join(path.dirname(storePath), "runs", "stateful-job.jsonl");
    await saveCronStore(storePath, {
      version: 1,
      jobs: [
        {
          id: "stateful-job",
          name: "Stateful job",
          enabled: true,
          createdAtMs: Date.parse("2026-02-01T00:00:00.000Z"),
          updatedAtMs: Date.parse("2026-02-01T00:00:00.000Z"),
          schedule: { kind: "every", everyMs: 60_000 },
          sessionTarget: "main",
          wakeMode: "next-heartbeat",
          payload: { kind: "systemEvent", text: "tick" },
          state: {},
        },
      ],
    });
    await fs.mkdir(path.dirname(logPath), { recursive: true });
    await fs.writeFile(
      logPath,
      `${JSON.stringify({ ts: 1, jobId: "stateful-job", action: "finished", status: "ok" })}\n`,
      "utf-8",
    );

    await maybeRepairLegacyCronStore({
      cfg: createCronConfig(storePath),
      options: {},
      prompter: makePrompter(true),
    });

    const { readCronRunLogEntriesFromSqliteSync } = await import("../cron/run-log.js");
    expect(readCronRunLogEntriesFromSqliteSync(storePath, { jobId: "stateful-job" })).toEqual([
      expect.objectContaining({ ts: 1, status: "ok" }),
    ]);
    await expect(fs.stat(storePath)).rejects.toThrow();
    await expect(fs.stat(logPath)).rejects.toThrow();
    expect(noteMock).toHaveBeenCalledWith(
      expect.stringContaining("Imported 1 cron run-log row from 1 legacy run-log file"),
      "Doctor changes",
    );
  });

  it("repairs malformed persisted cron ids before list rendering sees them", async () => {
    const storePath = await makeTempStorePath();
    await writeCronStore(storePath, [
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

    await maybeRepairLegacyCronStore({
      cfg: createCronConfig(storePath),
      options: {},
      prompter: makePrompter(true),
    });

    const persisted = await loadCronStore(storePath);
    expect(persisted.jobs[0]?.id).toBe("42");
    expect(typeof persisted.jobs[1]?.id).toBe("string");
    expect(persisted.jobs[1]?.id).toMatch(/^cron-/);
    expect(noteMock).toHaveBeenCalledWith(
      expect.stringContaining("stores `id` as a non-string value"),
      "Cron",
    );
    expect(noteMock).toHaveBeenCalledWith(
      expect.stringContaining("missing a canonical string `id`"),
      "Cron",
    );
  });

  it("warns instead of replacing announce delivery for notify fallback jobs", async () => {
    const storePath = await makeTempStorePath();
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
          version: 1,
          jobs: [
            {
              id: "notify-and-announce",
              name: "Notify and announce",
              notify: true,
              createdAtMs: Date.parse("2026-02-01T00:00:00.000Z"),
              updatedAtMs: Date.parse("2026-02-02T00:00:00.000Z"),
              schedule: { kind: "every", everyMs: 60_000 },
              sessionTarget: "isolated",
              wakeMode: "now",
              payload: { kind: "agentTurn", message: "Status" },
              delivery: { mode: "announce", channel: "telegram", to: "123" },
              state: {},
            },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );

    const noteSpy = noteMock;

    await maybeRepairLegacyCronStore({
      cfg: {
        cron: {
          store: storePath,
          webhook: "https://example.invalid/cron-finished",
        },
      },
      options: { nonInteractive: true },
      prompter: makePrompter(true),
    });

    const persisted = await loadCronStore(storePath);
    expect((persisted.jobs[0] as Record<string, unknown> | undefined)?.notify).toBe(true);
    expect(noteSpy).toHaveBeenCalledWith(
      expect.stringContaining('uses legacy notify fallback alongside delivery mode "announce"'),
      "Doctor warnings",
    );
  });

  it("does not auto-repair in non-interactive mode without explicit repair approval", async () => {
    const storePath = await makeTempStorePath();
    await writeCronStore(storePath, [createLegacyCronJob()]);

    const noteSpy = noteMock;
    const prompter = makePrompter(false);

    await maybeRepairLegacyCronStore({
      cfg: createCronConfig(storePath),
      options: { nonInteractive: true },
      prompter,
    });

    const jobs = await readPersistedJobs(storePath);
    const job = requirePersistedJob(jobs, 0);
    expect(prompter.confirm).toHaveBeenCalledWith({
      message: "Repair legacy cron jobs now?",
      initialValue: true,
    });
    expect(job.jobId).toBe("legacy-job");
    expect(job.notify).toBe(true);
    expect(noteSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("Cron store normalized"),
      "Doctor changes",
    );
  });

  it("migrates notify fallback none delivery jobs to cron.webhook", async () => {
    const storePath = await makeTempStorePath();
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(
      storePath,
      JSON.stringify(
        {
          version: 1,
          jobs: [
            {
              id: "notify-none",
              name: "Notify none",
              notify: true,
              createdAtMs: Date.parse("2026-02-01T00:00:00.000Z"),
              updatedAtMs: Date.parse("2026-02-02T00:00:00.000Z"),
              schedule: { kind: "every", everyMs: 60_000 },
              payload: {
                kind: "systemEvent",
                text: "Status",
              },
              delivery: { mode: "none", to: "123456789" },
              state: {},
            },
          ],
        },
        null,
        2,
      ),
      "utf-8",
    );

    await maybeRepairLegacyCronStore({
      cfg: {
        cron: {
          store: storePath,
          webhook: "https://example.invalid/cron-finished",
        },
      },
      options: {},
      prompter: makePrompter(true),
    });

    const persisted = await loadCronStore(storePath);
    expect((persisted.jobs[0] as Record<string, unknown> | undefined)?.notify).toBeUndefined();
    expect(persisted.jobs[0]?.delivery).toMatchObject({
      mode: "webhook",
      to: "https://example.invalid/cron-finished",
    });
  });

  it("repairs legacy root delivery threadId hints into delivery", async () => {
    const storePath = await makeTempStorePath();
    await writeCronStore(storePath, [
      {
        id: "legacy-thread-hint",
        name: "Legacy thread hint",
        enabled: true,
        createdAtMs: Date.parse("2026-02-01T00:00:00.000Z"),
        updatedAtMs: Date.parse("2026-02-02T00:00:00.000Z"),
        schedule: { kind: "cron", cron: "0 7 * * *", tz: "UTC" },
        sessionTarget: "isolated",
        wakeMode: "now",
        payload: {
          kind: "agentTurn",
          message: "Morning brief",
        },
        channel: " telegram ",
        to: "-1001234567890",
        threadId: " 99 ",
        state: {},
      },
    ]);

    await maybeRepairLegacyCronStore({
      cfg: createCronConfig(storePath),
      options: {},
      prompter: makePrompter(true),
    });

    const persisted = await loadCronStore(storePath);
    const legacyJob = persisted.jobs[0] as Record<string, unknown> | undefined;
    expect(legacyJob?.channel).toBeUndefined();
    expect(legacyJob?.to).toBeUndefined();
    expect(legacyJob?.threadId).toBeUndefined();
    expect(persisted.jobs[0]?.delivery).toMatchObject({
      mode: "announce",
      channel: "telegram",
      to: "-1001234567890",
      threadId: "99",
    });
  });

  it("rewrites stale managed dreaming jobs to the isolated agentTurn shape", async () => {
    const storePath = await makeTempStorePath();
    await writeCronStore(storePath, [
      {
        id: "memory-dreaming",
        name: "Memory Dreaming Promotion",
        description:
          "[managed-by=memory-core.short-term-promotion] Promote weighted short-term recalls.",
        enabled: true,
        createdAtMs: Date.parse("2026-04-01T00:00:00.000Z"),
        updatedAtMs: Date.parse("2026-04-01T00:00:00.000Z"),
        schedule: { kind: "cron", expr: "0 3 * * *", tz: "UTC" },
        sessionTarget: "main",
        wakeMode: "now",
        payload: {
          kind: "systemEvent",
          text: "__openclaw_memory_core_short_term_promotion_dream__",
        },
        state: {},
      },
    ]);

    const noteSpy = noteMock;

    await maybeRepairLegacyCronStore({
      cfg: createCronConfig(storePath),
      options: {},
      prompter: makePrompter(true),
    });

    const persisted = await loadCronStore(storePath);
    const [job] = persisted.jobs;
    expect(job).toMatchObject({
      sessionTarget: "isolated",
      payload: {
        kind: "agentTurn",
        message: "__openclaw_memory_core_short_term_promotion_dream__",
        lightContext: true,
      },
      delivery: { mode: "none" },
    });
    expect(noteSpy).toHaveBeenCalledWith(expect.stringContaining("managed dreaming job"), "Cron");
    expect(noteSpy).toHaveBeenCalledWith(
      expect.stringContaining("Rewrote 1 managed dreaming job"),
      "Doctor changes",
    );
  });
});

describe("noteLegacyWhatsAppCrontabHealthCheck", () => {
  it("warns about legacy ensure-whatsapp crontab entries on Linux", async () => {
    await noteLegacyWhatsAppCrontabHealthCheck({
      platform: "linux",
      readCrontab: async () => ({
        stdout: [
          "# keep comments ignored",
          "*/5 * * * * ~/.openclaw/bin/ensure-whatsapp.sh >> ~/.openclaw/logs/whatsapp-health.log 2>&1",
          "0 9 * * * /usr/bin/true",
          "",
        ].join("\n"),
      }),
    });

    expect(noteMock).toHaveBeenCalledWith(
      expect.stringContaining("Legacy WhatsApp crontab health check detected"),
      "Cron",
    );
    expect(noteMock).toHaveBeenCalledWith(
      expect.stringContaining("systemd user bus environment is missing"),
      "Cron",
    );
    expect(noteMock).toHaveBeenCalledWith(expect.stringContaining("Matched 1 entry"), "Cron");
  });

  it("ignores missing crontab support and non-Linux hosts", async () => {
    await noteLegacyWhatsAppCrontabHealthCheck({
      platform: "darwin",
      readCrontab: async () => {
        throw new Error("should not read crontab on non-Linux");
      },
    });
    await noteLegacyWhatsAppCrontabHealthCheck({
      platform: "linux",
      readCrontab: async () => {
        throw Object.assign(new Error("crontab missing"), { code: "ENOENT" });
      },
    });

    expect(noteMock).not.toHaveBeenCalled();
  });
});
