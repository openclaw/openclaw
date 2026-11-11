import fs from "node:fs";
import path from "node:path";
import * as replaceFile from "@openclaw/fs-safe/atomic";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { RecoveryCleanupReport } from "../../commands/doctor-session-sqlite-recovery-inventory.js";
import { retireSessionSqliteRecovery } from "../../commands/doctor-session-sqlite-retirement.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { readMigrationArtifactIdentity } from "../../infra/session-sqlite-migration-artifact.js";
import {
  createSessionSqliteMigrationRun,
  readSessionSqliteMigrationManifest,
  writeSessionSqliteMigrationManifest,
} from "../../infra/session-sqlite-migration-manifest.js";
import { retainedCheckpointBinding } from "../../infra/update-retained-checkpoint.test-support.js";
import {
  createRetainedUpdateRecovery,
  storeRetainedUpdateRecovery,
} from "../../infra/update-retained-recovery.test-support.js";
import { createUpdateRun } from "../../infra/update-run-ledger.js";
import { defaultRuntime, ExitError } from "../../runtime.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { runRegisteredCli } from "../../test-utils/command-runner.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { cleanupSessionStateForTest } from "../../test-utils/session-state-cleanup.js";
import { registerUpdateCli } from "../update-cli.js";
import { updateCleanupCommand } from "./cleanup.js";

vi.mock("@openclaw/fs-safe/atomic", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openclaw/fs-safe/atomic")>()),
}));

const dirs = useAutoCleanupTempDirTracker(afterEach);
beforeEach(() => {
  vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
  vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
  vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(async () => {
  await cleanupSessionStateForTest();
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
});

function fixture(shared = false) {
  const home = dirs.make("cleanup-session-archives-");
  const stateDir = path.join(home, "state");
  const backupDir = path.join(home, "independent-backup");
  const agentDir = path.join(stateDir, "agents", "main");
  const sessions = shared
    ? path.join(stateDir, "shared-sessions")
    : path.join(agentDir, "sessions");
  const archiveDir = path.join(path.dirname(sessions), "session-sqlite-import-archive");
  fs.mkdirSync(sessions, { recursive: true });
  fs.mkdirSync(archiveDir);
  const env = {
    HOME: home,
    OPENCLAW_HOME: undefined,
    OPENCLAW_PROFILE: undefined,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
  };
  const cfg: OpenClawConfig = shared
    ? {
        agents: {
          ownership: "explicit",
          defaults: { sessionStore: { agentId: "main" } },
          entries: { main: {}, work: {} },
        },
        session: { store: path.join(sessions, "{agentId}.json") },
      }
    : {};
  fs.writeFileSync(env.OPENCLAW_CONFIG_PATH, JSON.stringify(cfg));
  const target = {
    agentId: "main",
    storePath: path.join(sessions, shared ? "main.json" : "sessions.json"),
    sqlitePath: shared
      ? path.join(sessions, "main.sqlite")
      : path.join(agentDir, "agent", "openclaw-agent.sqlite"),
  };
  const run = createSessionSqliteMigrationRun(env, [target]);
  const paths = ["history.trajectory.jsonl", "changed.jsonl"].map((name) =>
    path.join(archiveDir, `${name}.imported-1`),
  );
  fs.writeFileSync(paths[0]!, "unique historical trajectory\n");
  fs.writeFileSync(paths[1]!, "recorded original\n");
  const previousIdentity = readMigrationArtifactIdentity(paths[1]!);
  const moves = paths.map((archivePath, index) => ({
    archivePath,
    sourcePath: path.join(sessions, index === 0 ? "history.trajectory.jsonl" : "changed.jsonl"),
    kind: index === 0 ? ("trajectory" as const) : ("transcript" as const),
    ...(index === 1
      ? {
          artifact: {
            identity: previousIdentity,
            classification: "imported" as const,
            reason: "verified-import",
            dependencies: [],
            disposal: { state: "retained" as const },
          },
        }
      : {}),
  }));
  run.manifest.targets[0]!.plannedMoves = structuredClone(moves);
  run.manifest.targets[0]!.completedMoves = structuredClone(moves);
  run.manifest.targets[0]!.validationBeforeArchive = "passed";
  if (shared) {
    run.manifest.targets.push({
      ...structuredClone(run.manifest.targets[0]!),
      agentId: "work",
      storePath: path.join(sessions, "work.json"),
      sqlitePath: path.join(sessions, "work.sqlite"),
    });
  }
  run.manifest.completedAt = run.manifest.startedAt;
  writeSessionSqliteMigrationManifest(run);
  fs.writeFileSync(paths[1]!, "changed current bytes, not proof of import\n");
  fs.cpSync(stateDir, backupDir, { recursive: true });
  const backupPath = (file: string) => path.join(backupDir, path.relative(stateDir, file));
  const options = {
    retireSessionArchive: paths,
    archiveBackup: backupDir,
    acceptHistoryLoss: true,
    json: true,
  };
  return { home, stateDir, backupDir, env, cfg, paths, run, backupPath, previousIdentity, options };
}

function result() {
  return vi.mocked(defaultRuntime.writeJson).mock.calls.at(-1)![0] as RecoveryCleanupReport & {
    error?: { message: string };
  };
}

it("previews backup-backed retirement of both reported archive classes without changing receipts", async () => {
  const f = fixture();
  const before = fs.readFileSync(f.run.manifestPath);
  await withEnvAsync(f.env, async () => {
    await updateCleanupCommand({ ...f.options, dryRun: true });
    expect(
      result()
        .artifacts.filter((item) => item.outcome === "candidate")
        .map((item) => item.path)
        .toSorted(),
    ).toEqual(f.paths.toSorted());
    expect(result().artifacts.every((item) => item.reason === "explicit-history-retirement")).toBe(
      true,
    );
    expect(fs.readFileSync(f.run.manifestPath)).toEqual(before);
    expect(f.paths.every((file) => fs.existsSync(file))).toBe(true);
  });
});

it("retires only explicitly selected backed-up history and preserves the original evidence", async () => {
  const f = fixture();
  await withEnvAsync(f.env, async () => {
    await updateCleanupCommand({ ...f.options, yes: true });
    expect(result()).toMatchObject({ status: "complete", totals: { removedFiles: 2 } });
    expect(f.paths.some((file) => fs.existsSync(file))).toBe(false);
    expect(fs.readFileSync(f.backupPath(f.paths[0]!), "utf8")).toBe(
      "unique historical trajectory\n",
    );
    expect(fs.readFileSync(f.backupPath(f.paths[1]!), "utf8")).toBe(
      "changed current bytes, not proof of import\n",
    );
    const manifest = readSessionSqliteMigrationManifest(f.run.manifestPath)!;
    expect(manifest).toMatchObject({ manifestVersion: 5 });
    expect(manifest.targets[0]!.completedMoves[1]).toMatchObject({
      artifact: { classification: "protected", disposal: { state: "disposed" } },
      retirement: { previousArtifact: { identity: f.previousIdentity } },
    });
    await updateCleanupCommand({ ...f.options, yes: true });
    expect(result()).toMatchObject({ status: "complete", totals: { removedFiles: 0 } });
  });
});

it("does not let ordinary --yes consent retire unverified or changed archives", async () => {
  const f = fixture();
  await withEnvAsync(f.env, async () => {
    await expect(updateCleanupCommand({ yes: true, json: true })).rejects.toEqual(new ExitError(1));
    expect(
      result()
        .artifacts.map((item) => item.reason)
        .toSorted(),
    ).toEqual(["artifact-metadata-changed", "historical-import-proof-unavailable"]);
    expect(f.paths.every((file) => fs.existsSync(file))).toBe(true);
  });
});

it("parses repeated archive selections and requires history-loss consent independently of --yes", async () => {
  const f = fixture();
  await withEnvAsync(f.env, async () => {
    const argv = [
      "update",
      "cleanup",
      "--json",
      ...f.paths.flatMap((file) => ["--retire-session-archive", file]),
      "--archive-backup",
      f.backupDir,
    ];
    await runRegisteredCli({ register: registerUpdateCli, argv: [...argv, "--dry-run"] });
    expect(
      result()
        .artifacts.filter((item) => item.outcome === "candidate")
        .map((item) => item.path)
        .toSorted(),
    ).toEqual(f.paths.toSorted());
    await expect(
      runRegisteredCli({ register: registerUpdateCli, argv: [...argv, "--yes"] }),
    ).rejects.toEqual(new ExitError(1));
    expect(result().error?.message).toContain("--accept-history-loss");
    expect(f.paths.every((file) => fs.existsSync(file))).toBe(true);
    await expect(
      runRegisteredCli({ register: registerUpdateCli, argv: [...argv, "--accept-history-loss"] }),
    ).rejects.toEqual(new ExitError(1));
    expect(result().status).toBe("refused");
    await runRegisteredCli({
      register: registerUpdateCli,
      argv: [...argv, "--accept-history-loss", "--yes"],
    });
    expect(result()).toMatchObject({ status: "complete", totals: { removedFiles: 2 } });
  });
});

it.each<Array<[string, Partial<Parameters<typeof updateCleanupCommand>[0]>, string]>[number]>([
  ["missing backup", { archiveBackup: undefined }, "--archive-backup"],
  ["conflicting selection", { includeUnmanifested: ["/unused"] }, "--include-unmanifested"],
  [
    "orphan backup",
    { retireSessionArchive: undefined, acceptHistoryLoss: false },
    "--retire-session-archive",
  ],
  [
    "orphan consent",
    { retireSessionArchive: undefined, archiveBackup: undefined },
    "--retire-session-archive",
  ],
])("refuses %s without changing original files or manifests", async (_name, options, message) => {
  const f = fixture();
  const before = fs.readFileSync(f.run.manifestPath);
  await withEnvAsync(f.env, async () => {
    await expect(updateCleanupCommand({ ...f.options, ...options, yes: true })).rejects.toEqual(
      new ExitError(1),
    );
    expect(result().error?.message).toContain(message);
    expect(fs.readFileSync(f.run.manifestPath)).toEqual(before);
    expect(f.paths.every((file) => fs.existsSync(file))).toBe(true);
  });
});

it("requires every retained member of the selected session target", async () => {
  const f = fixture();
  await withEnvAsync(f.env, async () => {
    await expect(
      updateCleanupCommand({ ...f.options, retireSessionArchive: [f.paths[0]!], yes: true }),
    ).rejects.toEqual(new ExitError(1));
    expect(result().error?.message).toMatch(/group|target|all|complete/i);
    expect(f.paths.every((file) => fs.existsSync(file))).toBe(true);
  });
});

it.each(["intent", "disposed"] as const)(
  "resumes shared-store retirement after a partial cross-manifest %s write",
  async (phase) => {
    const f = fixture(true);
    const duplicate = createSessionSqliteMigrationRun(f.env, []);
    duplicate.manifest.targets = structuredClone(f.run.manifest.targets);
    duplicate.manifest.completedAt = f.run.manifest.completedAt;
    writeSessionSqliteMigrationManifest(duplicate);
    fs.copyFileSync(duplicate.manifestPath, f.backupPath(duplicate.manifestPath));
    const write = replaceFile.replaceFileAtomicSync;
    let writes = 0;
    await withEnvAsync(f.env, async () => {
      {
        using fault = vi.spyOn(replaceFile, "replaceFileAtomicSync");
        fault.mockImplementation((options) => {
          const content = String(options.content);
          if (
            [f.run.manifestPath, duplicate.manifestPath].includes(options.filePath) &&
            content.includes(phase === "intent" ? '"pending-disposal"' : '"disposed"') &&
            ++writes === 2
          ) {
            throw new Error("injected partial cross-manifest publication");
          }
          return write(options);
        });
        await expect(updateCleanupCommand({ ...f.options, yes: true })).rejects.toEqual(
          new ExitError(1),
        );
        expect(writes).toBe(2);
      }
      if (phase === "intent") {
        expect(f.paths.every((file) => fs.existsSync(file))).toBe(true);
      }
      await updateCleanupCommand({ ...f.options, yes: true });
      expect(result().status).toBe("complete");
      expect(f.paths.some((file) => fs.existsSync(file))).toBe(false);
      for (const file of [f.run.manifestPath, duplicate.manifestPath]) {
        const manifest = readSessionSqliteMigrationManifest(file)!;
        expect(manifest.targets).toHaveLength(2);
        expect(
          manifest.targets.every((target) =>
            target.completedMoves.every(
              (move) => move.retirement && move.artifact?.disposal.state === "disposed",
            ),
          ),
        ).toBe(true);
      }
    });
  },
);

it.each(["archive", "backup", "manifest", "archive inode"] as const)(
  "rechecks the %s after confirmation before retirement",
  async (change) => {
    const f = fixture();
    await withEnvAsync(f.env, async () => {
      await updateCleanupCommand({ ...f.options, dryRun: true });
      await expect(
        retireSessionSqliteRecovery({
          ...f.options,
          env: f.env,
          preview: result(),
          readConfig: async () => ({}),
          confirm: async () => {
            if (change === "archive inode") {
              const replacement = path.join(f.home, "replacement");
              fs.writeFileSync(replacement, fs.readFileSync(f.paths[0]!));
              fs.renameSync(replacement, f.paths[0]!);
              return true;
            }
            const changed =
              change === "archive"
                ? f.paths[0]!
                : change === "backup"
                  ? f.backupPath(f.paths[0]!)
                  : f.backupPath(f.run.manifestPath);
            fs.appendFileSync(changed, "changed during confirmation\n");
            return true;
          },
        }),
      ).rejects.toThrow(/changed|backup|match|manifest/i);
      expect(f.paths.every((file) => fs.existsSync(file))).toBe(true);
    });
  },
);

it("refuses unresolved configuration before explicit archive selection", async () => {
  const f = fixture();
  fs.writeFileSync(f.env.OPENCLAW_CONFIG_PATH, JSON.stringify({ $include: "missing.json" }));
  await withEnvAsync(f.env, async () => {
    await expect(updateCleanupCommand({ ...f.options, yes: true })).rejects.toEqual(
      new ExitError(1),
    );
    expect(result().error?.message).toMatch(/configuration.*resolve/i);
    expect(f.paths.every((file) => fs.existsSync(file))).toBe(true);
  });
});

it.each([
  "missing archive",
  "changed archive",
  "same-size changed archive",
  "missing manifest",
  "inside state",
] as const)("refuses an inadequate independent backup: %s", async (kind) => {
  const f = fixture();
  const backup = f.backupPath(kind === "missing manifest" ? f.run.manifestPath : f.paths[0]!);
  if (kind.startsWith("missing")) {
    fs.unlinkSync(backup);
  } else if (kind === "changed archive") {
    fs.appendFileSync(backup, "not the selected bytes");
  } else if (kind === "same-size changed archive") {
    fs.writeFileSync(backup, Buffer.alloc(fs.statSync(backup).size, "x"));
  }
  await withEnvAsync(f.env, async () => {
    await expect(
      updateCleanupCommand({
        ...f.options,
        archiveBackup: kind === "inside state" ? f.stateDir : f.backupDir,
        yes: true,
      }),
    ).rejects.toEqual(new ExitError(1));
    expect(result().status).toBe("blocked");
    expect(f.paths.every((file) => fs.existsSync(file))).toBe(true);
  });
});

it.each(["archive", "manifest"] as const)(
  "rejects a bind-mounted %s backup alias",
  async (kind) => {
    const f = fixture();
    const original = kind === "archive" ? f.paths[0]! : f.run.manifestPath;
    const copied = fs.statSync(f.backupPath(original), { bigint: true });
    const source = fs.statSync(original, { bigint: true });
    // Model bind-mount identity: two paths to the same inode, both reporting nlink=1.
    const alias = <T extends fs.Stats | fs.BigIntStats | undefined>(stat: T): T => {
      if (
        stat &&
        String(stat.ino) === String(copied.ino) &&
        String(stat.dev) === String(copied.dev)
      ) {
        Object.defineProperty(stat, "ino", {
          value: typeof stat.ino === "bigint" ? source.ino : Number(source.ino),
        });
      }
      return stat;
    };
    const lstat = fs.lstatSync;
    const fstat = fs.fstatSync;
    using statSpy = vi.spyOn(fs, "lstatSync");
    statSpy.mockImplementation((file, options) => alias(lstat(file, options)));
    using fdSpy = vi.spyOn(fs, "fstatSync");
    fdSpy.mockImplementation((fd, options) => alias(fstat(fd, options)));
    await withEnvAsync(f.env, async () => {
      await expect(updateCleanupCommand({ ...f.options, dryRun: true })).rejects.toEqual(
        new ExitError(1),
      );
      expect(result().error?.message).toMatch(/aliases its original/i);
      expect(f.paths.every((file) => fs.existsSync(file))).toBe(true);
    });
  },
);

it("rechecks configured live files at the claim boundary after progress callbacks", async () => {
  const f = fixture();
  await withEnvAsync(f.env, async () => {
    await updateCleanupCommand({ ...f.options, dryRun: true });
    const report = await retireSessionSqliteRecovery({
      ...f.options,
      env: f.env,
      preview: result(),
      readConfig: async () => JSON.parse(fs.readFileSync(f.env.OPENCLAW_CONFIG_PATH, "utf8")),
      confirm: async () => true,
      onProgress: () =>
        fs.writeFileSync(
          f.env.OPENCLAW_CONFIG_PATH,
          JSON.stringify({ session: { store: f.paths[0] } }),
        ),
    });
    expect(report.status).toBe("blocked");
    expect(report.artifacts.some((item) => item.detail?.includes("Active database path"))).toBe(
      true,
    );
    expect(f.paths.every((file) => fs.existsSync(file))).toBe(true);
  });
});

it("protects archives referenced by pending recovery despite explicit history-loss consent", async () => {
  const f = fixture();
  const options = { env: f.env };
  const runId = createUpdateRun({ trigger: "cli" }, options).runId;
  const runtime = { root: f.home, nodePath: process.execPath, version: "1.0.0", buildId: null };
  const recovery = createRetainedUpdateRecovery({ runId, from: runtime, to: runtime }, options);
  recovery.checkpoint = retainedCheckpointBinding(recovery);
  recovery.checkpoint.ref.manifestPath = f.run.manifestPath;
  storeRetainedUpdateRecovery(recovery, options);
  closeOpenClawStateDatabaseForTest();
  await withEnvAsync(f.env, async () => {
    await expect(updateCleanupCommand({ ...f.options, yes: true })).rejects.toEqual(
      new ExitError(1),
    );
    expect(result().error?.message).toMatch(/pending|recovery/i);
    expect(f.paths.every((file) => fs.existsSync(file))).toBe(true);
  });
});

it("refuses a recreated original from an ordinary completed disposal", async () => {
  const f = fixture();
  for (const moves of [
    f.run.manifest.targets[0]!.plannedMoves,
    f.run.manifest.targets[0]!.completedMoves,
  ]) {
    moves[1]!.artifact!.disposal = { state: "disposed", disposedAt: new Date().toISOString() };
  }
  writeSessionSqliteMigrationManifest(f.run);
  const before = fs.readFileSync(f.run.manifestPath);
  await withEnvAsync(f.env, async () => {
    await expect(updateCleanupCommand({ ...f.options, yes: true })).rejects.toEqual(
      new ExitError(1),
    );
    expect(result().error?.message).toMatch(/unsupported recovery operation/i);
    expect(fs.readFileSync(f.run.manifestPath)).toEqual(before);
    expect(f.paths.every((file) => fs.existsSync(file))).toBe(true);
  });
});

it("refuses conflicting pending claims across referencing manifests", async () => {
  const f = fixture();
  await withEnvAsync(f.env, async () => {
    await updateCleanupCommand({ ...f.options, dryRun: true });
    await retireSessionSqliteRecovery({
      ...f.options,
      env: f.env,
      preview: result(),
      readConfig: async () => ({}),
      confirm: async () => true,
      onProgress: () => {
        throw new Error("injected interruption before claiming");
      },
    });
    const pending = readSessionSqliteMigrationManifest(f.run.manifestPath)!;
    const conflicting = createSessionSqliteMigrationRun(f.env, []);
    conflicting.manifest.targets = structuredClone(pending.targets);
    conflicting.manifest.manifestVersion = 5;
    conflicting.manifest.completedAt = pending.completedAt;
    for (const moves of [
      conflicting.manifest.targets[0]!.plannedMoves,
      conflicting.manifest.targets[0]!.completedMoves,
    ]) {
      const disposal = moves[0]!.artifact!.disposal;
      if (disposal.state !== "pending-disposal") {
        throw new Error("expected durable pending claim");
      }
      disposal.claimPath = path.join(
        path.dirname(f.paths[0]!),
        ".cleanup-00000000-0000-0000-0000-000000000000",
      );
    }
    writeSessionSqliteMigrationManifest(conflicting);
    await expect(updateCleanupCommand({ ...f.options, yes: true })).rejects.toEqual(
      new ExitError(1),
    );
    expect(result().error?.message).toMatch(/conflicting disposal claims/i);
    expect(f.paths.every((file) => fs.existsSync(file))).toBe(true);
  });
});

it("preserves a pending claim that becomes a configured live store before retry", async () => {
  const f = fixture();
  await withEnvAsync(f.env, async () => {
    await updateCleanupCommand({ ...f.options, dryRun: true });
    const interrupted = await retireSessionSqliteRecovery({
      ...f.options,
      env: f.env,
      preview: result(),
      readConfig: async () => ({}),
      confirm: async () => true,
      onProgress: ({ phase, index }) => {
        if (phase === "claiming" && index === 2) {
          throw new Error("injected interruption before the second claim");
        }
      },
    });
    expect(interrupted.status).toBe("blocked");
    const pending = readSessionSqliteMigrationManifest(f.run.manifestPath)!;
    const disposal = pending.targets[0]!.completedMoves[0]!.artifact!.disposal;
    if (disposal.state !== "pending-disposal") {
      throw new Error("expected durable pending claim");
    }
    const claimBytes = fs.readFileSync(disposal.claimPath);
    const remainingBytes = fs.readFileSync(f.paths[1]!);
    fs.writeFileSync(
      f.env.OPENCLAW_CONFIG_PATH,
      JSON.stringify({ session: { store: disposal.claimPath } }),
    );
    await expect(updateCleanupCommand({ ...f.options, yes: true })).rejects.toEqual(
      new ExitError(1),
    );
    expect(result().error?.message).toMatch(/active|live/i);
    expect(fs.readFileSync(disposal.claimPath)).toEqual(claimBytes);
    expect(fs.readFileSync(f.paths[1]!)).toEqual(remainingBytes);
  });
});

it("resumes an interrupted group claim with the original backup and durable retirement evidence", async () => {
  const f = fixture();
  const backupManifest = fs.readFileSync(f.backupPath(f.run.manifestPath));
  await withEnvAsync(f.env, async () => {
    await updateCleanupCommand({ ...f.options, dryRun: true });
    const interrupted = await retireSessionSqliteRecovery({
      ...f.options,
      env: f.env,
      preview: result(),
      readConfig: async () => ({}),
      confirm: async () => true,
      onProgress: ({ phase, index }) => {
        if (phase === "claiming" && index === 2) {
          throw new Error("injected interruption before the second claim");
        }
      },
    });
    expect(interrupted.status).toBe("blocked");
    const pending = readSessionSqliteMigrationManifest(f.run.manifestPath)!;
    expect(
      pending.targets[0]!.completedMoves.every(
        (move) => move.artifact?.disposal.state === "pending-disposal",
      ),
    ).toBe(true);
    expect(f.paths.filter((file) => fs.existsSync(file))).toHaveLength(1);
    await updateCleanupCommand({ ...f.options, yes: true });
    expect(result().status).toBe("complete");
    expect(f.paths.some((file) => fs.existsSync(file))).toBe(false);
    expect(fs.readFileSync(f.backupPath(f.run.manifestPath))).toEqual(backupManifest);
    const completed = readSessionSqliteMigrationManifest(f.run.manifestPath)!;
    expect(
      completed.targets[0]!.completedMoves.every(
        (move) => move.retirement && move.artifact?.disposal.state === "disposed",
      ),
    ).toBe(true);
  });
});
