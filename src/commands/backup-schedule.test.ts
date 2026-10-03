import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerCronCli } from "../cli/cron-cli.js";
import { registerBackupCommand } from "../cli/program/register.backup.js";
import { summarizeBackupSchedules } from "../cron/backup-command.js";
import { CronService } from "../cron/service.js";
import { createCronStoreHarness, createNoopLogger } from "../cron/service.test-harness.js";
import type { CronListPageOptions } from "../cron/service/list-page-types.js";
import type { CronJob, CronJobCreate, CronJobPatch } from "../cron/types.js";
import { defaultRuntime } from "../runtime.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

const gatewayRpc = vi.hoisted(() => ({
  call: vi.fn(),
  isImplicitLocalTarget: vi.fn(async () => true),
}));
const configMocks = vi.hoisted(() => ({
  getRuntimeConfig: vi.fn(),
}));

vi.mock("../cli/gateway-rpc.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../cli/gateway-rpc.js")>();
  return {
    ...actual,
    callGatewayFromCli: gatewayRpc.call,
    isImplicitLocalGatewayTargetFromCli: gatewayRpc.isImplicitLocalTarget,
  };
});

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return { ...actual, getRuntimeConfig: configMocks.getRuntimeConfig };
});

import { GIT_BACKUP_PUSH_CREDENTIAL_WARNING } from "./backup-git.js";
import { backupDisableCommand, backupEnableCommand } from "./backup-schedule.js";

const BACKUP_CRON_JOB_NAME = "openclaw-backup-scheduled";
const { makeStorePath } = createCronStoreHarness({ prefix: "openclaw-backup-lookup-" });

const roots: string[] = [];

async function runCli(args: string[]) {
  const program = new Command();
  program.exitOverride();
  registerBackupCommand(program);
  registerCronCli(program);
  await program.parseAsync(args, { from: "user" });
}

// enable --push preflights an origin remote, so push fixtures need a real repo.
async function pushReadyRepository(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-backup-schedule-test-"));
  roots.push(root);
  execFileSync("git", ["-C", root, "init"], { stdio: "ignore" });
  execFileSync("git", ["-C", root, "remote", "add", "origin", "git@example.invalid:backups.git"], {
    stdio: "ignore",
  });
  return root;
}

describe("scheduled backups", () => {
  beforeEach(() => {
    gatewayRpc.call.mockReset();
    gatewayRpc.isImplicitLocalTarget.mockReset().mockResolvedValue(true);
    configMocks.getRuntimeConfig.mockReset().mockReturnValue({
      agents: { entries: { main: {}, "ops-team": {} } },
      storage: {
        locations: {
          archive: {
            provider: "filesystem",
            settings: { path: "/mnt/backups" },
            encryption: "none",
          },
        },
      },
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      roots.splice(0).map(async (root) => await fs.rm(root, { recursive: true, force: true })),
    );
  });

  it("adds one isolated command job with the selected Git backup argv", async () => {
    gatewayRpc.call.mockImplementation(async (method: string) => {
      if (method === "cron.add") {
        return { created: true, job: { id: "backup-job" } };
      }
      throw new Error(`unexpected method ${method}`);
    });
    const runtime = createTestRuntime();
    const repository = await pushReadyRepository();
    await expect(
      backupEnableCommand(runtime, {
        repository,
        every: "6h",
        push: true,
        excludeSecrets: true,
      }),
    ).resolves.toEqual({ id: "backup-job", updated: false });
    expect(gatewayRpc.call).toHaveBeenCalledWith(
      "cron.add",
      expect.anything(),
      expect.objectContaining({
        declarationKey: BACKUP_CRON_JOB_NAME,
        name: BACKUP_CRON_JOB_NAME,
        schedule: { kind: "every", everyMs: 21_600_000 },
        sessionTarget: "isolated",
        payload: {
          kind: "command",
          argv: [
            "openclaw",
            "backup",
            "git",
            "create",
            "--repository",
            repository,
            "--all",
            "--push",
            "--exclude-secrets",
          ],
        },
      }),
    );
    expect(gatewayRpc.call).toHaveBeenCalledOnce();
    expect(runtime.error).not.toHaveBeenCalled();
  });

  it("schedules a configured agent using its normalized id", async () => {
    gatewayRpc.call.mockResolvedValue({ created: true, job: { id: "backup-job" } });
    const runtime = createTestRuntime();

    await backupEnableCommand(runtime, {
      repository: "/tmp/openclaw-backups",
      agent: "Ops Team",
    });

    const spec = gatewayRpc.call.mock.calls[0]?.[2] as { payload: { argv: string[] } };
    expect(spec.payload.argv).toContain("ops-team");
    expect(spec.payload.argv).not.toContain("--all");
  });

  it.each([false, true])(
    "round-trips offsite CLI options with explicit claim=%s through the persisted schedule and status projection",
    async (claim) => {
      let persisted: CronJobCreate | undefined;
      gatewayRpc.call.mockImplementation(
        async (method: string, _options: unknown, params: CronJobCreate) => {
          if (method !== "cron.add") {
            throw new Error(`unexpected method ${method}`);
          }
          persisted = params;
          return { created: true, job: { id: "offsite-job" } };
        },
      );
      vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
      await runCli([
        "backup",
        "enable",
        "--to",
        "archive",
        "--every",
        "6h",
        "--namespace",
        "host-a",
        ...(claim ? ["--claim-namespace"] : []),
        "--no-include-workspace",
        "--keep-daily",
        "7",
        "--keep-weekly",
        "4",
        "--keep-monthly",
        "0",
      ]);
      const spec = expectDefined(persisted, "persisted offsite schedule");
      expect(spec.declarationKey).toBe("openclaw-backup-offsite-scheduled");
      expect(spec.payload).toEqual({
        kind: "command",
        argv: [
          "openclaw",
          "backup",
          "create",
          "--to",
          "archive",
          "--namespace",
          "host-a",
          ...(claim ? ["--claim-namespace"] : []),
          "--no-include-workspace",
          "--keep-daily",
          "7",
          "--keep-weekly",
          "4",
          "--keep-monthly",
          "0",
        ],
      });
      expect(
        summarizeBackupSchedules([
          {
            ...spec,
            id: "offsite-job",
            createdAtMs: 1,
            updatedAtMs: 1,
            state: { nextRunAtMs: 21_600_001 },
          },
        ]),
      ).toEqual([
        {
          id: "offsite-job",
          mode: "offsite",
          target: "archive",
          namespace: "host-a",
          enabled: true,
          everyMs: 21_600_000,
          nextRunAtMs: 21_600_001,
        },
      ]);
    },
  );

  it.each([{ argv: ["--all"] }, { argv: ["--global"] }, { argv: ["--agent", "main"] }])(
    "reports installed Git schedule argv $argv in status",
    ({ argv }) => {
      expect(
        summarizeBackupSchedules([
          {
            id: "git-job",
            name: "Renamed by operator",
            enabled: true,
            createdAtMs: 1,
            updatedAtMs: 1,
            sessionTarget: "isolated",
            wakeMode: "now",
            state: {},
            declarationKey: "openclaw-backup-scheduled",
            schedule: { kind: "every", everyMs: 86_400_000 },
            payload: {
              kind: "command",
              argv: [
                "openclaw",
                "backup",
                "git",
                "create",
                "--repository",
                "/backups/git",
                ...argv,
                "--push",
                "--exclude-secrets",
              ],
            },
          },
        ]),
      ).toEqual([
        {
          id: "git-job",
          mode: "git",
          everyMs: 86_400_000,
          target: "/backups/git",
          enabled: true,
        },
      ]);
    },
  );

  it.each([
    { flags: [], removed: ["git-job", "offsite-job"] },
    { flags: ["--git"], removed: ["git-job"] },
    { flags: ["--offsite"], removed: ["offsite-job"] },
  ])("disables only selected backup modes $flags", async ({ flags, removed }) => {
    const base: CronJob = {
      id: "git-job",
      name: "Renamed by operator",
      enabled: true,
      createdAtMs: 1,
      updatedAtMs: 1,
      declarationKey: "openclaw-backup-scheduled",
      schedule: { kind: "every", everyMs: 60_000 },
      payload: { kind: "command", argv: ["openclaw", "backup", "git", "create"] },
      sessionTarget: "isolated",
      wakeMode: "now",
      state: {},
    };
    const jobs = [
      base,
      { ...base, id: "offsite-job", declarationKey: "openclaw-backup-offsite-scheduled" },
      { ...base, id: "unmanaged-job", declarationKey: undefined },
    ];
    gatewayRpc.call.mockImplementation(async (method: string) => {
      if (method === "cron.list") {
        return {
          jobs,
          snapshotRevision: "1",
          total: jobs.length,
          offset: 0,
          limit: 200,
          hasMore: false,
          nextOffset: null,
        };
      }
      if (method === "cron.remove") {
        return { removed: true };
      }
      throw new Error(`unexpected method ${method}`);
    });
    vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    await runCli(["backup", "disable", ...flags]);
    expect(
      gatewayRpc.call.mock.calls
        .filter(([method]) => method === "cron.remove")
        .map((call) => call[2]),
    ).toEqual(removed.map((id) => ({ id })));
  });

  it.each([
    { options: { to: "archive", repository: "/backups" }, message: "cannot be combined" },
    { options: { repository: "/backups", keepDaily: "7" }, message: "require --to" },
    { options: { to: "missing" }, message: 'Storage location "missing" is not configured' },
    {
      options: { repository: "/tmp/openclaw-backups", agent: "nope-agent" },
      message: 'Unknown agent id "nope-agent". Run openclaw agents list to see configured agents.',
    },
    {
      options: { repository: "/tmp/openclaw-backups", agent: "   " },
      message: "--agent must not be blank",
    },
    {
      options: { repository: "/tmp/openclaw-backups", every: "   " },
      message: "Invalid duration (empty)",
    },
  ])("rejects invalid schedule options $options", async ({ options, message }) => {
    await expect(backupEnableCommand(createTestRuntime(), options)).rejects.toThrow(message);
    expect(gatewayRpc.call).not.toHaveBeenCalled();
  });

  it.each([
    { scenario: "renamed", renamed: true, decoys: 1, disabled: false },
    { scenario: "beyond the first page", renamed: false, decoys: 200, disabled: false },
    { scenario: "already disabled", renamed: false, decoys: 1, disabled: true },
  ])(
    "removes the $scenario managed declaration through the CLI",
    async ({ renamed, decoys, disabled }) => {
      const { storePath } = await makeStorePath();
      const runJob = vi.fn(async () => {
        throw new Error("Scheduled execution is outside this lookup test");
      });
      const cron = new CronService({
        scheduler: createTestGatewayScheduler(),
        nowMs: () => Date.now(),
        storePath,
        cronEnabled: false,
        log: createNoopLogger(),
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        runIsolatedAgentJob: runJob,
        runCommandJob: runJob,
      });
      gatewayRpc.call.mockImplementation(
        async (method: string, _options: unknown, params: unknown) => {
          switch (method) {
            case "cron.add":
              return await cron.add(params as CronJobCreate);
            case "cron.list":
              return await cron.listPage(params as CronListPageOptions);
            case "cron.get":
              return await cron.readJob((params as { id: string }).id);
            case "cron.update": {
              const { id, patch } = params as { id: string; patch: CronJobPatch };
              return await cron.update(id, patch);
            }
            case "cron.remove":
              return await cron.remove((params as { id: string }).id);
            default:
              throw new Error(`Unexpected test RPC: ${method}`);
          }
        },
      );
      const runtime = createTestRuntime();
      vi.spyOn(defaultRuntime, "log").mockImplementation(runtime.log);
      vi.spyOn(defaultRuntime, "error").mockImplementation(runtime.error);
      vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
      vi.spyOn(defaultRuntime, "exit").mockImplementation((code) => {
        throw new Error(`Unexpected CLI exit ${code}`);
      });
      try {
        const decoyIds: string[] = [];
        for (let index = 0; index < decoys; index += 1) {
          const job = await cron.add({
            name: BACKUP_CRON_JOB_NAME,
            enabled: true,
            schedule: { kind: "every", everyMs: 60_000 },
            sessionTarget: "isolated",
            wakeMode: "next-heartbeat",
            payload: { kind: "command", argv: ["synthetic-command"] },
            delivery: { mode: "none" },
          });
          decoyIds.push(job.id);
        }
        const enableArgs = [
          "backup",
          "enable",
          "--repository",
          path.dirname(storePath),
          "--global-only",
        ];
        await runCli(enableArgs);
        const managed = expectDefined(
          (await cron.list({ includeDisabled: true })).find(
            (job) => job.declarationKey === BACKUP_CRON_JOB_NAME,
          ),
          "created managed backup",
        );
        await runCli([...enableArgs, "--every", "6h"]);
        expect(await cron.readJob(managed.id)).toMatchObject({
          schedule: { everyMs: 21_600_000 },
          payload: { argv: expect.arrayContaining(["--global"]) },
        });
        if (renamed) {
          await runCli(["cron", "edit", managed.id, "--name", "Nightly operator backup"]);
        }
        if (disabled) {
          await cron.update(managed.id, { enabled: false });
        }
        const page = await cron.listPage({ includeDisabled: true, limit: 200 });
        expect(page.total).toBe(decoys + 1);
        if (decoys === 200) {
          expect(page.jobs.some((job) => job.id === managed.id)).toBe(false);
          expect(page.hasMore).toBe(true);
        }

        await runCli(["backup", "disable"]);

        expect(await cron.readJob(managed.id)).toBeUndefined();
        expect(runtime.log).toHaveBeenLastCalledWith("Scheduled backups disabled.");
        expect(
          (await cron.list({ includeDisabled: true })).map((job) => job.id).toSorted(),
        ).toEqual(decoyIds.toSorted());
        await runCli(["backup", "disable"]);
        expect(runtime.log).toHaveBeenLastCalledWith("Scheduled backups are already disabled.");
        expect(runtime.error).not.toHaveBeenCalled();
        expect(runJob).not.toHaveBeenCalled();
      } finally {
        cron.stop();
      }
    },
  );

  it("redacts pushed schedules by default and warns only on explicit full fidelity", async () => {
    const runtime = createTestRuntime();
    gatewayRpc.call.mockResolvedValue({ created: true, job: { id: "backup-job" } });

    // Default pushed schedule: redacted, no credential warning.
    await backupEnableCommand(runtime, {
      repository: await pushReadyRepository(),
      push: true,
    });
    expect(gatewayRpc.call).toHaveBeenLastCalledWith(
      "cron.add",
      expect.anything(),
      expect.objectContaining({
        payload: expect.objectContaining({ argv: expect.arrayContaining(["--exclude-secrets"]) }),
      }),
    );
    expect(runtime.error).not.toHaveBeenCalled();

    // Explicit --include-secrets keeps full fidelity and warns.
    await backupEnableCommand(runtime, {
      repository: await pushReadyRepository(),
      push: true,
      includeSecrets: true,
    });
    const lastSpec = gatewayRpc.call.mock.calls.at(-1)?.[2] as {
      payload: { argv: string[] };
    };
    expect(lastSpec.payload.argv).not.toContain("--exclude-secrets");
    expect(runtime.error).toHaveBeenCalledWith(GIT_BACKUP_PUSH_CREDENTIAL_WARNING);

    await expect(
      backupEnableCommand(runtime, {
        repository: await pushReadyRepository(),
        push: true,
        includeSecrets: true,
        excludeSecrets: true,
      }),
    ).rejects.toThrow(/not both/);
  });

  it("refuses a pushed schedule when the repository has no origin remote", async () => {
    const runtime = createTestRuntime();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-backup-schedule-test-"));
    roots.push(root);
    execFileSync("git", ["-C", root, "init"], { stdio: "ignore" });
    await expect(backupEnableCommand(runtime, { repository: root, push: true })).rejects.toThrow(
      /--push requires an origin remote/,
    );
    expect(gatewayRpc.call).not.toHaveBeenCalled();
  });

  it("rejects scheduling through a non-local Gateway before touching local paths", async () => {
    gatewayRpc.isImplicitLocalTarget.mockResolvedValue(false);
    const runtime = createTestRuntime();
    const expected =
      "backup enable manages backups on the Gateway host and currently requires a local Gateway. Create the cron job manually with openclaw cron add for remote Gateways.";

    await expect(
      backupEnableCommand(runtime, {
        repository: "/path/that/does/not/exist",
        push: true,
        url: "ws://127.0.0.1:18789",
      }),
    ).rejects.toThrow(expected);
    await expect(
      backupDisableCommand(runtime, { url: "wss://gateway.example.invalid" }),
    ).rejects.toThrow(expected);
    expect(gatewayRpc.call).not.toHaveBeenCalled();
  });
});
