import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { formatCliOperatorError } from "../cli/failure-output.js";
import {
  registerSignalExitBarrier,
  waitForCliSignalExit,
  waitForSignalExitBarriers,
} from "../cli/signal-exit-barrier.js";
import * as lifecycleWriteCustody from "../infra/lifecycle-write-custody.js";
import { readLifecycleWriteCustody } from "../infra/lifecycle-write-custody.js";
import {
  CommandProcessCleanupError,
  hasCommandProcessCleanupError,
} from "../process/exec-result.js";
import { readBackupRuns } from "../state/backup-run-records.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { createTempHomeEnv, type TempHomeEnv } from "../test-utils/temp-home.js";
import {
  buildBackupArchivePath,
  buildBackupArchiveRoot,
  resolveBackupPlanFromDisk,
} from "./backup-shared.js";
import * as backupVerify from "./backup-verify.js";
import {
  createMockTarStream,
  mockStateOnlyBackupPlan,
  resetBackupTempHome,
  backupWalkMock,
} from "./backup.test-support.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

const { backupCreateCommand } = await import("./backup.js");
const actualTar = await vi.importActual<typeof import("tar")>("tar");
const { walkBackupTar } = await vi.importActual<typeof import("../infra/backup-tar-walk.js")>(
  "../infra/backup-tar-walk.js",
);
const create = (
  options: Parameters<typeof backupCreateCommand>[1],
  runtime = createTestRuntime(),
) => backupCreateCommand(runtime, options);

async function withEnv(name: string, value: string, run: () => Promise<void> | void) {
  const snapshot = captureEnv([name]);
  setTestEnvValue(name, value);
  try {
    await run();
  } finally {
    snapshot.restore();
  }
}

describe("backup commands", () => {
  let tempHome: TempHomeEnv;
  let stateDir: string;

  async function writeWorkspaceBackupConfig(workspaceDir: string) {
    await fs.writeFile(
      path.join(stateDir, "openclaw.json"),
      JSON.stringify({
        agents: { ownership: "explicit", entries: { main: { workspace: workspaceDir } } },
      }),
      "utf8",
    );
  }

  async function prepareWorkspace() {
    const workspaceDir = path.join(stateDir, "workspace");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "SOUL.md"), "# soul\n", "utf8");
    return workspaceDir;
  }

  beforeAll(async () => {
    tempHome = await createTempHomeEnv("openclaw-backup-test-");
    stateDir = path.join(tempHome.home, ".openclaw");
  });

  beforeEach(async () => {
    await resetBackupTempHome(tempHome);
    backupWalkMock.mockReset();
    backupWalkMock.mockImplementation(() => createMockTarStream());
  });

  afterEach(async () => {
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await tempHome.restore();
  });

  it.each(["success", "failure", "uncertain", "SIGINT", "SIGTERM"] as const)(
    "retains archive custody until stream cleanup is confirmed: %s",
    async (outcome) => {
      await mockStateOnlyBackupPlan(stateDir);
      const beginCustody = lifecycleWriteCustody.beginLifecycleWriteCustody;
      let releaseCustody: (() => void) | undefined;
      vi.spyOn(lifecycleWriteCustody, "beginLifecycleWriteCustody").mockImplementation((phase) => {
        releaseCustody = beginCustody(phase);
        return releaseCustody;
      });
      const entered = createDeferred();
      const settled = createDeferred();
      const failed = outcome === "failure" || outcome === "uncertain";
      const cause =
        outcome === "uncertain"
          ? new AggregateError([new CommandProcessCleanupError()], "nested cleanup")
          : undefined;
      backupWalkMock.mockImplementation(() =>
        createMockTarStream({
          beforeRead: async () => {
            entered.resolve();
            await settled.promise;
          },
          ...(failed ? { error: new Error("archive failed", cause ? { cause } : undefined) } : {}),
        }),
      );
      const running = create({
        output: path.join(tempHome.home, `backup-${outcome}.tgz`),
        includeWorkspace: false,
      }).catch((error: unknown) => error);
      await entered.promise;
      try {
        expect(readLifecycleWriteCustody()).toEqual([{ phase: "backup", count: 1 }]);
        const signalDrain =
          outcome === "SIGINT" || outcome === "SIGTERM"
            ? waitForSignalExitBarriers(outcome)
            : undefined;
        settled.resolve();
        const result = await running;
        await signalDrain;
        expect(result instanceof Error).toBe(outcome !== "success");
        expect(hasCommandProcessCleanupError(result)).toBe(outcome === "uncertain");
        expect(readLifecycleWriteCustody()).toEqual(
          outcome === "uncertain" ? [{ phase: "backup", count: 1 }] : [],
        );
      } finally {
        settled.resolve();
        await running;
        await waitForCliSignalExit();
        releaseCustody?.();
      }
      expect(readLifecycleWriteCustody()).toEqual([]);
    },
  );

  it("retains a committed archive and records its verified outcome before signal exit", async () => {
    openOpenClawStateDatabase();
    await closeStateDatabaseForTest();
    await mockStateOnlyBackupPlan(stateDir);
    backupWalkMock.mockImplementationOnce(walkBackupTar);
    const archivePath = path.join(tempHome.home, "committed.tar.gz");
    const entered = createDeferred();
    const continueVerification = createDeferred();
    const verify = backupVerify.verifyBackupArchive;
    vi.spyOn(backupVerify, "verifyBackupArchive").mockImplementation(async (...args) => {
      entered.resolve();
      await continueVerification.promise;
      return verify(...args);
    });
    const running = create({
      output: archivePath,
      verify: true,
      nowMs: 123,
    });
    const observed = running.catch((error: unknown) => error);
    let cleanupStarted = false;
    const releaseBarrier = registerSignalExitBarrier(async () => {
      cleanupStarted = true;
    });
    let signalDrain: Promise<void> | undefined;
    try {
      await Promise.race([
        entered.promise,
        running.then(() => {
          throw new Error("Backup completed without entering requested verification");
        }),
      ]);
      const committed = await fs.stat(archivePath, { bigint: true });
      let drained = false;
      signalDrain = waitForSignalExitBarriers("SIGTERM").then(() => {
        drained = true;
      });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(drained).toBe(false);
      expect(cleanupStarted).toBe(false);
      expect(readLifecycleWriteCustody()).toEqual([{ phase: "backup", count: 1 }]);
      continueVerification.resolve();
      await expect(running).resolves.toMatchObject({ archivePath, verified: true });
      await signalDrain;
      expect(await waitForCliSignalExit()).toBe(143);
      expect((await fs.stat(archivePath, { bigint: true })).ino).toBe(committed.ino);
      expect(await readBackupRuns(process.env)).toContainEqual(
        expect.objectContaining({ archivePath, status: "ok", kind: "archive" }),
      );
    } finally {
      continueVerification.resolve();
      await observed;
      await signalDrain;
      await waitForCliSignalExit();
      releaseBarrier();
    }
  });

  it.each([
    ["Asia/Shanghai", "2026-03-14T09-02-03.456+08-00-openclaw-backup"],
    ["America/New_York", "2026-03-13T21-02-03.456-04-00-openclaw-backup"],
  ])("formats backup archive timestamps in %s local time", async (timezone, expected) => {
    await withEnv("TZ", timezone, () => {
      expect(buildBackupArchiveRoot(Date.UTC(2026, 2, 14, 1, 2, 3, 456))).toBe(expected);
    });
  });

  it("orders coverage checks by canonical path so symlinked workspaces do not duplicate state", async () => {
    if (process.platform === "win32") {
      return;
    }

    const workspaceDir = await prepareWorkspace();
    await withTestDir({ prefix: "openclaw-workspace-link-" }, async (symlinkDir) => {
      const workspaceLink = path.join(symlinkDir, "ws-link");
      await fs.symlink(workspaceDir, workspaceLink);
      await writeWorkspaceBackupConfig(workspaceLink);
      const plan = await resolveBackupPlanFromDisk({ includeWorkspace: true, nowMs: 123 });
      const included = expectDefined(plan.included[0], "included state asset");
      const stateSourcePath = included.sourcePath;
      expect(plan.included).toStrictEqual([
        {
          kind: "state",
          sourcePath: stateSourcePath,
          displayPath: included.displayPath,
          archivePath: buildBackupArchivePath(buildBackupArchiveRoot(123), stateSourcePath),
        },
      ]);
      expect(plan.skipped).toStrictEqual([
        {
          kind: "workspace",
          sourcePath: path.join(stateSourcePath, "workspace"),
          displayPath: path.join(included.displayPath, "workspace"),
          reason: "covered",
          coveredBy: included.displayPath,
        },
      ]);
      const skipped = expectDefined(plan.skipped[0], "covered workspace skip entry");
      expect(path.relative(stateSourcePath, skipped.sourcePath).startsWith("..")).toBe(false);
    });
  });

  it("backupCreateCommand omits volatile files and keeps notices out of JSON output", async () => {
    await withTestDir({ prefix: "openclaw-backups-json-" }, async (backupDir) => {
      const runtime = createTestRuntime();
      await mockStateOnlyBackupPlan(stateDir);
      const sessions = path.join(stateDir, "sessions");
      await fs.mkdir(sessions);
      await fs.writeFile(path.join(sessions, "s.jsonl"), "volatile\n");
      backupWalkMock.mockImplementationOnce(walkBackupTar);

      const result = await backupCreateCommand(runtime, {
        output: backupDir,
        json: true,
      });

      const entries: string[] = [];
      await actualTar.t({
        file: result.archivePath,
        onReadEntry: (entry) => {
          entries.push(entry.path);
        },
      });
      expect(entries.some((entry) => entry.endsWith("/sessions/s.jsonl"))).toBe(false);
      expect(result.skippedVolatileCount).toBe(1);
      expect(runtime.log).toHaveBeenCalledTimes(1);
      const [payload] = expectDefined(vi.mocked(runtime.log).mock.calls[0], "runtime log call");
      if (typeof payload !== "string") {
        throw new Error("backup test expected JSON string output");
      }
      expect(payload).not.toContain("Backup skipped");
      expect(JSON.parse(payload)).toHaveProperty("skippedVolatileCount", 1);
    });
  });

  it.each(["EACCES", "EEXIST"] as const)(
    "reports an actionable %s output-parent failure",
    async (code) => {
      const outputParent = path.join(
        tempHome.home,
        code === "EACCES" ? "missing-parent/daily" : "not-a-directory",
      );
      const outputPath = path.join(outputParent, "backup.tar.gz");
      if (code === "EEXIST") {
        await fs.writeFile(outputParent, "file\n", "utf8");
      }
      await mockStateOnlyBackupPlan(stateDir);
      if (code === "EACCES") {
        vi.spyOn(fs, "mkdir").mockRejectedValueOnce(
          Object.assign(new Error(`EACCES: filesystem error, mkdir '${outputParent}'`), {
            code,
            path: outputParent,
            syscall: "mkdir",
          }),
        );
      }
      const error = await create({ output: outputPath }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      const detail = code === "EACCES" ? "directory is not writable" : "parent is not a directory";
      const recovery =
        code === "EACCES"
          ? "Check the path and directory permissions, then run"
          : "Choose a directory path and run";
      const operatorMessage = `Backup archive creation failed: ${outputPath}. Backup output ${detail}: ${outputParent}. ${recovery} \`openclaw backup create --output <archive>\` again.`;
      expect(formatCliOperatorError(error, { argv: [], env: {} })).toBe(operatorMessage);
      const debug = formatCliOperatorError(error, { argv: [], env: { OPENCLAW_DEBUG: "1" } });
      if (code === "EACCES") {
        expect(debug).toBe(
          `${operatorMessage} | EACCES: filesystem error, mkdir '${outputParent}' | EACCES`,
        );
      } else {
        expect(debug).toMatch(/\| EEXIST: .*mkdir.*\| EEXIST/u);
      }
    },
  );

  it("rejects symlinked output paths even when intermediate directories do not exist yet", async () => {
    if (process.platform === "win32") {
      return;
    }

    await withTestDir({ prefix: "openclaw-backup-link-" }, async (symlinkDir) => {
      const symlinkPath = path.join(symlinkDir, "linked-state");
      await fs.writeFile(path.join(stateDir, "openclaw.json"), JSON.stringify({}), "utf8");
      await fs.symlink(stateDir, symlinkPath);

      const runtime = createTestRuntime();
      await mockStateOnlyBackupPlan(stateDir);

      await expect(
        create({ output: path.join(symlinkPath, "new", "subdir", "backup.tar.gz") }, runtime),
      ).rejects.toThrow(/must not be written inside a source path/i);
    });
  });

  it.each([false, true])(
    "falls back to home when cwd is a backed-up workspace (symlink=%s)",
    async (symlink) => {
      if (symlink && process.platform === "win32") {
        return;
      }
      const workspaceDir = await prepareWorkspace();
      await writeWorkspaceBackupConfig(workspaceDir);
      await withTestDir({ prefix: "openclaw-backup-cwd-link-" }, async (linkParent) => {
        const cwd = symlink ? path.join(linkParent, "workspace-link") : workspaceDir;
        if (symlink) {
          await fs.symlink(workspaceDir, cwd);
        }
        vi.spyOn(process, "cwd").mockReturnValue(cwd);
        const nowMs = Date.UTC(2026, 2, 9, 1, 2, 3);
        const result = await create({ nowMs });
        expect(result.archivePath).toBe(
          path.join(tempHome.home, `${buildBackupArchiveRoot(nowMs)}.tar.gz`),
        );
        await fs.rm(result.archivePath, { force: true });
      });
    },
  );

  it("handles invalid syntax according to backup scope", async () => {
    const configPath = path.join(tempHome.home, "custom-config.json");
    await fs.writeFile(path.join(stateDir, "openclaw.json"), "{}", "utf8");
    await fs.writeFile(configPath, '{"agents": { defaults: { workspace: ', "utf8");
    await withEnv("OPENCLAW_CONFIG_PATH", configPath, async () => {
      const runtime = createTestRuntime();
      await expect(create({ dryRun: true }, runtime)).rejects.toThrow(
        /ownership could not be resolved/i,
      );

      await expect(create({ dryRun: true, includeWorkspace: false }, runtime)).rejects.toThrow(
        /ownership could not be resolved/i,
      );

      const configOnly = await create({ dryRun: true, onlyConfig: true }, runtime);
      expect(configOnly.assets).toStrictEqual([
        {
          kind: "config",
          sourcePath: expect.any(String),
          displayPath: expect.any(String),
          archivePath: expect.stringContaining("/payload/"),
        },
      ]);
    });
  });

  it("discovers workspaces through the stable upgrade compatibility view", async () => {
    const configPath = path.join(tempHome.home, "stable-openclaw.json");
    const workspaceDir = path.join(tempHome.home, "stable-workspace");
    const stableConfig = {
      meta: {
        lastTouchedAt: "2026-08-01T00:00:00.000Z",
        lastTouchedVersion: "2026.7.1-2",
      },
      agents: {
        defaults: {
          workspace: workspaceDir,
          heartbeat: { skipWhenBusy: true },
        },
      },
      gateway: { mode: "local" },
    };
    const originalRaw = `${JSON.stringify(stableConfig, null, 2)}\n`;
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(configPath, originalRaw, "utf8");
    const canonicalWorkspaceDir = await fs.realpath(workspaceDir);
    await withEnv("OPENCLAW_CONFIG_PATH", configPath, async () => {
      const plan = await resolveBackupPlanFromDisk({ nowMs: 123 });

      expect(plan.included).toContainEqual(
        expect.objectContaining({ kind: "workspace", sourcePath: canonicalWorkspaceDir }),
      );
      expect(await fs.readFile(configPath, "utf8")).toBe(originalRaw);
      expect(plan.configPath).toBe(configPath);
      expect(plan.stateDir).toBe(stateDir);
    });
  });
});
