import { spawn } from "node:child_process";
import { once } from "node:events";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  cleanupBackupArchivePublication,
  createBackupArchivePublication,
  type BackupArchivePublication,
} from "./backup-archive-publication.js";
import { removePreparedBackupArchive } from "./backup-create-stream.js";
import * as scratch from "./backup-scratch.js";
import * as fsSafe from "./fs-safe.js";
import { markSqliteNativeOpenFailure } from "./sqlite-error-diagnostics.js";

const plans: BackupArchivePublication[] = [];
const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    vi.restoreAllMocks();
    // Windows will not remove SQLite token files while these handles are open.
    for (const plan of plans.splice(0)) {
      plan.scratch?.release();
    }
    cleanup();
  }),
);

async function create(root: string, name: string) {
  const plan = await createBackupArchivePublication(path.join(root, name));
  plans.push(plan);
  return plan;
}

it("reclaims an unfinished archive after its actual publication owner is killed", async () => {
  const root = dirs.make("backup-publication-killed-");
  // One subprocess is necessary to prove that kernel-released SQLite locks,
  // without any finally/cleanup path, admit the next real publication call.
  const child = spawn(
    process.execPath,
    [
      "--import",
      "./scripts/tsx.mjs",
      "--input-type=module",
      "-e",
      `
    import fs from 'node:fs/promises';
    import path from 'node:path';
    import { createBackupArchivePublication } from './src/infra/backup-archive-publication.ts';
    const plan = await createBackupArchivePublication(path.join(process.argv[1], 'killed.tar.gz'));
    await fs.writeFile(plan.tempArchivePath, 'unfinished archive');
    process.send(plan.stagingDir);
    process.stdin.resume();
  `,
      root,
    ],
    { stdio: ["pipe", "ignore", "pipe", "ipc"] },
  );
  let diagnostics = "";
  child.stderr?.on("data", (chunk) => {
    diagnostics += String(chunk);
  });
  const closed = once(child, "close");
  try {
    const [directory] = await Promise.race([
      once(child, "message"),
      closed.then(() => {
        throw new Error(`Publication fixture exited early: ${diagnostics}`);
      }),
    ]);
    expect(typeof directory).toBe("string");
    const active = await create(root, "active.tar.gz");
    await expect(fs.readFile(path.join(directory, "archive.tar.gz.tmp"), "utf8")).resolves.toBe(
      "unfinished archive",
    );
    child.kill("SIGKILL");
    await closed;
    const next = await create(root, "next.tar.gz");
    await expect(fs.lstat(directory)).rejects.toMatchObject({ code: "ENOENT" });
    await cleanupBackupArchivePublication(active);
    await cleanupBackupArchivePublication(next);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
    await closed;
  }
});

it("reclaims a prior publication on the next publication entry point, preserving live owners", async () => {
  const root = dirs.make("backup-publication-recovery-");
  const abandoned = await create(root, "abandoned.tar.gz");
  await fs.writeFile(abandoned.tempArchivePath, "unfinished archive");
  await fs.writeFile(`${abandoned.tempArchivePath}.retry-2`, "unfinished second attempt");
  await fs.writeFile(`${abandoned.tempArchivePath}.retry-3`, "unfinished third attempt");
  const active = await create(root, "active.tar.gz");
  await fs.writeFile(active.tempArchivePath, "live archive");
  // Releasing without retirement models SQLite's transaction rollback when an
  // owner exits; process-kill proof additionally exercises the OS boundary.
  abandoned.scratch!.release();
  const next = await create(root, "next.tar.gz");
  await expect(fs.lstat(abandoned.stagingDir)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(fs.readFile(active.tempArchivePath, "utf8")).resolves.toBe("live archive");
  await cleanupBackupArchivePublication(next);
});

it("preserves unexpected publication payload and completed archives", async () => {
  const root = dirs.make("backup-publication-unexpected-");
  const abandoned = await create(root, "backup.tar.gz");
  await fs.writeFile(path.join(abandoned.stagingDir, "operator-file"), "keep");
  await fs.writeFile(abandoned.tempArchivePath, "partial");
  await fs.writeFile(path.join(root, "complete.tar.gz"), "complete");
  abandoned.scratch!.release();
  const next = await create(root, "next.tar.gz");
  await expect(fs.readFile(path.join(abandoned.stagingDir, "operator-file"), "utf8")).resolves.toBe(
    "keep",
  );
  await expect(fs.readFile(abandoned.tempArchivePath, "utf8")).resolves.toBe("partial");
  await expect(fs.readFile(path.join(root, "complete.tar.gz"), "utf8")).resolves.toBe("complete");
  await cleanupBackupArchivePublication(next);
});

it.runIf(process.platform !== "win32")(
  "preserves a publication symlink and its target",
  async () => {
    const root = dirs.make("backup-publication-symlink-");
    const abandoned = await create(root, "backup.tar.gz");
    const target = path.join(root, "operator-file");
    await fs.writeFile(target, "keep");
    await fs.symlink(target, abandoned.tempArchivePath);
    abandoned.scratch!.release();
    const next = await create(root, "next.tar.gz");
    expect((await fs.lstat(abandoned.tempArchivePath)).isSymbolicLink()).toBe(true);
    await expect(fs.readFile(target, "utf8")).resolves.toBe("keep");
    await cleanupBackupArchivePublication(next);
  },
);

it("does not adopt legacy or unowned publication directories", async () => {
  const root = dirs.make("backup-publication-unowned-");
  const legacy = path.join(root, ".openclaw-backup-publish-old-ABC123");
  const unowned = path.join(root, ".openclaw-backup-publish-unowned-ABC123");
  for (const directory of [legacy, unowned]) {
    await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, "archive.tar.gz.tmp"), "keep");
  }
  const next = await create(root, "next.tar.gz");
  for (const directory of [legacy, unowned]) {
    await expect(fs.readFile(path.join(directory, "archive.tar.gz.tmp"), "utf8")).resolves.toBe(
      "keep",
    );
  }
  await cleanupBackupArchivePublication(next);
});

it("preserves replacement files whose bigint identities collide as Numbers", async () => {
  const root = dirs.make("backup-publication-bigint-");
  const archivePath = path.join(root, "archive.tar.gz.tmp");
  await fs.writeFile(archivePath, "replacement");
  const identity = await fs.lstat(archivePath, { bigint: true });
  const original = 2n ** 53n;
  const replacement = original + 1n;
  expect(Number(original)).toBe(Number(replacement));
  const lstat = fsSync.lstatSync;
  vi.spyOn(fsSync, "lstatSync").mockImplementation((target, options) => {
    const result = lstat(target, options);
    if (target === archivePath && result) {
      Object.defineProperty(result, "ino", {
        value:
          options && typeof options === "object" && options.bigint
            ? replacement
            : Number(replacement),
      });
    }
    return result;
  });
  Object.defineProperty(identity, "ino", { value: original });
  expect(removePreparedBackupArchive({ archivePath, identity })).toBe(false);
  await expect(fs.readFile(archivePath, "utf8")).resolves.toBe("replacement");
});

it("gives actionable same-output-directory recovery guidance after publication cleanup fails", async () => {
  const root = dirs.make("backup-publication-cleanup-guidance-");
  const plan = await create(root, "backup.tar.gz");
  const log = vi.fn();
  const remove = vi
    .spyOn(fs, "rmdir")
    .mockRejectedValue(Object.assign(new Error("busy"), { code: "EBUSY" }));
  try {
    const warning = await scratch.finishBackupScratch(plan.scratch!, log);
    expect(warning).toContain("Run another backup using the same output directory");
    expect(warning).not.toContain("doctor --fix");
    expect(log).toHaveBeenCalledWith(warning);
  } finally {
    remove.mockRestore();
  }
  const next = await create(root, "next.tar.gz");
  await cleanupBackupArchivePublication(next);
  await expect(fs.readdir(root)).resolves.toEqual([]);
});

it("records publication cleanup failures for structured result propagation", async () => {
  const root = dirs.make("backup-publication-cleanup-warning-");
  const plan = await create(root, "backup.tar.gz");
  const rmdir = fs.rmdir;
  vi.spyOn(fs, "rmdir").mockImplementation(async (target) => {
    if (path.basename(String(target)).startsWith(".openclaw-backup-publish-retired-")) {
      throw Object.assign(new Error("synthetic publication cleanup failure"), {
        code: "EBUSY",
      });
    }
    return await rmdir(target);
  });

  await cleanupBackupArchivePublication(plan);

  expect(plan.warnings).toEqual([expect.stringContaining("synthetic publication cleanup failure")]);
});

it("fails explicitly when Windows identity admission is unknown", async () => {
  const root = dirs.make("backup-publication-unknown-identity-");
  const hostPlatform = process.platform;
  let classifyingUnknownAdmission = false;
  vi.spyOn(process, "platform", "get").mockImplementation(() =>
    classifyingUnknownAdmission ? "win32" : hostPlatform,
  );
  vi.spyOn(fsSafe, "root").mockImplementationOnce(async () => {
    classifyingUnknownAdmission = true;
    throw new fsSafe.FsSafeError("path-mismatch", "file identity changed or could not be verified");
  });
  const lstat = fs.lstat;
  vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
    const result = await lstat(...args);
    if (classifyingUnknownAdmission) {
      classifyingUnknownAdmission = false;
    }
    return result;
  });
  await expect(createBackupArchivePublication(path.join(root, "backup.tar.gz"))).rejects.toThrow(
    /requires stable file identity/iu,
  );
  await expect(fs.readdir(root)).resolves.toEqual([]);
});

it("continues with unregistered staging when the destination cannot open SQLite", async () => {
  const root = dirs.make("backup-publication-no-sqlite-");
  const admissionError = Object.assign(new Error("synthetic unsupported SQLite locking"), {
    code: "SQLITE_IOERR",
  });
  markSqliteNativeOpenFailure(admissionError);
  vi.spyOn(scratch, "createBackupScratchDirectory").mockRejectedValueOnce(admissionError);
  const log = vi.fn();
  const plan = await createBackupArchivePublication(path.join(root, "backup.tar.gz"), log);
  plans.push(plan);
  expect(plan.scratch).toBeUndefined();
  expect(path.basename(plan.stagingDir)).toMatch(/^\.openclaw-backup-publish-unowned-/);
  expect(plan.warnings).toEqual([
    expect.stringContaining("does not support recoverable SQLite staging"),
  ]);
  expect(log).toHaveBeenCalledWith(
    expect.stringContaining("does not support recoverable SQLite staging"),
  );
  await fs.writeFile(plan.tempArchivePath, "unregistered payload");
  await cleanupBackupArchivePublication(plan, log);
});

it("does not downgrade ordinary admission errors to unregistered staging", async () => {
  const root = dirs.make("backup-publication-admission-error-");
  vi.spyOn(scratch, "createBackupScratchDirectory").mockRejectedValueOnce(
    new Error("ownership changed"),
  );
  await expect(createBackupArchivePublication(path.join(root, "backup.tar.gz"))).rejects.toThrow(
    "ownership changed",
  );
  await expect(fs.readdir(root)).resolves.toEqual([]);
});
