// Covers reclaiming backup temp artifacts that a hard-killed run orphaned.
import { randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createBackupArchive } from "./backup-create.js";
import {
  keepBackupTempDirectoryAlive,
  sweepStaleBackupTempDirectories,
} from "./backup-temp-sweep.js";

const HOUR_MS = 60 * 60_000;
const ARCHIVE_NOW_MS = Date.UTC(2026, 4, 9, 8, 0, 0);

// Crash fixtures retain the marker that normal cleanup removes.
const OWNER_MARKER_FILENAME = ".openclaw-backup-owner";

async function writeAgedDirectory(directoryPath: string, ageMs: number): Promise<void> {
  await fs.mkdir(directoryPath, { recursive: true });
  await fs.writeFile(path.join(directoryPath, "archive.tar.gz.tmp"), "orphaned payload\n");
  // Creating the file bumps the directory mtime, so age the directory last.
  const stamp = new Date(Date.now() - ageMs);
  await fs.utimes(path.join(directoryPath, "archive.tar.gz.tmp"), stamp, stamp);
  await fs.utimes(directoryPath, stamp, stamp);
}

// Same fixture as `writeAgedDirectory`, but also carries the ownership
// marker a real run writes immediately after `mkdtemp`. This models a
// genuine orphan of *this* format (heartbeat-aware, hard-killed after
// claiming ownership) rather than a pre-upgrade directory that never had the
// chance to claim it.
async function writeAgedOwnedDirectory(directoryPath: string, ageMs: number): Promise<void> {
  await fs.mkdir(directoryPath, { recursive: true });
  await fs.writeFile(path.join(directoryPath, OWNER_MARKER_FILENAME), "", { mode: 0o600 });
  await fs.writeFile(path.join(directoryPath, "archive.tar.gz.tmp"), "orphaned payload\n");
  const stamp = new Date(Date.now() - ageMs);
  const entries = await fs.readdir(directoryPath);
  for (const entry of entries) {
    await fs.utimes(path.join(directoryPath, entry), stamp, stamp);
  }
  await fs.utimes(directoryPath, stamp, stamp);
}

async function pathExists(targetPath: string): Promise<boolean> {
  return await fs.stat(targetPath).then(
    () => true,
    () => false,
  );
}

async function withTempRootEnv<T>(tempRoot: string, run: () => Promise<T>): Promise<T> {
  // os.tmpdir() reads TMPDIR on POSIX but TEMP/TMP on Windows, so override all
  // three — otherwise this sweep test never redirects the temp root on Windows.
  const names = ["TMPDIR", "TEMP", "TMP"] as const;
  const previous = names.map((name) => [name, process.env[name]] as const);
  for (const name of names) {
    process.env[name] = tempRoot;
  }
  try {
    return await run();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
}

describe("createBackupArchive stale temp sweep", () => {
  it("removes a staging directory orphaned by an earlier hard-killed run", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-backup-sweep-staging-",
        scenario: "minimal",
      },
      async (state) => {
        const outputDir = state.path("backups");
        const tempRoot = state.path("tmproot");
        await fs.mkdir(outputDir, { recursive: true });
        await fs.mkdir(tempRoot, { recursive: true });
        const orphan = path.join(tempRoot, "openclaw-backup-a1b2c3");
        await writeAgedOwnedDirectory(orphan, 48 * HOUR_MS);
        const log = vi.fn();

        await withTempRootEnv(tempRoot, async () => {
          await createBackupArchive({
            output: outputDir,
            includeWorkspace: false,
            nowMs: ARCHIVE_NOW_MS,
            log,
          });
        });

        expect(await pathExists(orphan)).toBe(false);
        expect(log).not.toHaveBeenCalledWith(
          expect.stringContaining("preserved changed or non-empty staging directory"),
        );
      },
    );
  });

  it("removes a publish staging directory orphaned beside the output archive", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-backup-sweep-publish-",
        scenario: "minimal",
      },
      async (state) => {
        const outputDir = state.path("backups");
        await fs.mkdir(outputDir, { recursive: true });
        const orphan = path.join(outputDir, `.openclaw-backup-publish-${randomUUID()}-a1b2c3`);
        await writeAgedOwnedDirectory(orphan, 48 * HOUR_MS);

        await createBackupArchive({
          output: outputDir,
          includeWorkspace: false,
          nowMs: ARCHIVE_NOW_MS,
        });

        expect(await pathExists(orphan)).toBe(false);
      },
    );
  });

  it("leaves an aged staging directory alone when no run ever claimed it", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-backup-sweep-legacy-staging-",
        scenario: "minimal",
      },
      async (state) => {
        const outputDir = state.path("backups");
        const tempRoot = state.path("tmproot");
        await fs.mkdir(outputDir, { recursive: true });
        await fs.mkdir(tempRoot, { recursive: true });
        // Exact name shape a pre-upgrade (pre-heartbeat) build would also
        // produce, but nothing ever wrote the ownership marker onto it. That
        // could mean an orphan of this build, or a still-running backup from
        // the older one — the two are indistinguishable by age alone, so the
        // conservative sweep must leave it alone either way.
        const possiblyLiveLegacyRun = path.join(tempRoot, "openclaw-backup-1eGacy");
        await writeAgedDirectory(possiblyLiveLegacyRun, 48 * HOUR_MS);

        await withTempRootEnv(tempRoot, async () => {
          await createBackupArchive({
            output: outputDir,
            includeWorkspace: false,
            nowMs: ARCHIVE_NOW_MS,
          });
        });

        expect(await pathExists(possiblyLiveLegacyRun)).toBe(true);
      },
    );
  });

  it("preserves an aged Fleet archive temp file beside the output", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-backup-sweep-fleet-file-",
        scenario: "minimal",
      },
      async (state) => {
        const outputDir = state.path("backups");
        await fs.mkdir(outputDir, { recursive: true });
        // Fleet backup publishes through the same `<archive>.<uuid>.tmp`
        // shape as the retired backup-create writer. Backup-create cannot
        // prove ownership of this sibling artifact, even after it ages out.
        const fleetTemp = path.join(outputDir, `fleet-backup.tar.gz.${randomUUID()}.tmp`);
        await fs.writeFile(fleetTemp, "fleet payload\n");
        const aged = new Date(Date.now() - 48 * HOUR_MS);
        await fs.utimes(fleetTemp, aged, aged);

        await createBackupArchive({
          output: outputDir,
          includeWorkspace: false,
          nowMs: ARCHIVE_NOW_MS,
        });

        expect(await pathExists(fleetTemp)).toBe(true);
      },
    );
  });

  it("keeps a legacy archive-temp file a live pre-durable-publish run is still writing", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-backup-sweep-legacy-file-live-",
        scenario: "minimal",
      },
      async (state) => {
        const outputDir = state.path("backups");
        await fs.mkdir(outputDir, { recursive: true });
        const liveFile = path.join(
          outputDir,
          `2026-05-08T00-00-00.000-00-00-openclaw-backup.tar.gz.${randomUUID()}.tmp`,
        );
        // Unlike a staging directory, this file is the direct write target of
        // `tar` in the retired scheme, so its own mtime already tracks an
        // active writer with no extra fence needed.
        await fs.writeFile(liveFile, "still streaming\n");

        await createBackupArchive({
          output: outputDir,
          includeWorkspace: false,
          nowMs: ARCHIVE_NOW_MS,
        });

        expect(await pathExists(liveFile)).toBe(true);
      },
    );
  });

  it("keeps a staging directory whose archive is still being written", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-backup-sweep-active-",
        scenario: "minimal",
      },
      async (state) => {
        const outputDir = state.path("backups");
        const tempRoot = state.path("tmproot");
        await fs.mkdir(outputDir, { recursive: true });
        await fs.mkdir(tempRoot, { recursive: true });
        // A long tar write never touches the parent directory, so a live run
        // can carry a stale directory mtime alongside a fresh archive file.
        const activeRun = path.join(tempRoot, "openclaw-backup-c3d4e5");
        await writeAgedOwnedDirectory(activeRun, 48 * HOUR_MS);
        await fs.appendFile(path.join(activeRun, "archive.tar.gz.tmp"), "still streaming\n");

        await withTempRootEnv(tempRoot, async () => {
          await createBackupArchive({
            output: outputDir,
            includeWorkspace: false,
            nowMs: ARCHIVE_NOW_MS,
          });
        });

        expect(await pathExists(activeRun)).toBe(true);
      },
    );
  });

  it("keeps recent, sibling-owned, and non-mkdtemp directories", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-backup-sweep-scope-",
        scenario: "minimal",
      },
      async (state) => {
        const outputDir = state.path("backups");
        const tempRoot = state.path("tmproot");
        await fs.mkdir(outputDir, { recursive: true });
        await fs.mkdir(tempRoot, { recursive: true });
        // `openclaw-backup-` prefixes `openclaw-backup-verify-sqlite-`, so a
        // prefix-only match would delete a concurrent `backup verify` run.
        const concurrentVerify = path.join(tempRoot, "openclaw-backup-verify-sqlite-a1b2c3");
        const concurrentCreate = path.join(tempRoot, "openclaw-backup-b2c3d4");
        const unrelatedName = path.join(tempRoot, "openclaw-backup-user-notes");
        const unrelatedDir = path.join(tempRoot, "unrelated-data");
        const matchingFile = path.join(tempRoot, "openclaw-backup-file01");
        await writeAgedOwnedDirectory(concurrentVerify, 48 * HOUR_MS);
        await writeAgedOwnedDirectory(concurrentCreate, 0);
        await writeAgedOwnedDirectory(unrelatedName, 48 * HOUR_MS);
        await writeAgedOwnedDirectory(unrelatedDir, 48 * HOUR_MS);
        await fs.writeFile(matchingFile, "unrelated file");

        await withTempRootEnv(tempRoot, async () => {
          await createBackupArchive({
            output: outputDir,
            includeWorkspace: false,
            nowMs: ARCHIVE_NOW_MS,
          });
        });

        expect(await pathExists(concurrentVerify)).toBe(true);
        expect(await pathExists(concurrentCreate)).toBe(true);
        expect(await pathExists(unrelatedName)).toBe(true);
        expect(await pathExists(unrelatedDir)).toBe(true);
        expect(await fs.readFile(matchingFile, "utf8")).toBe("unrelated file");
      },
    );
  });
});

describe("live-owner fence", () => {
  // `tar` only reads the staging directory, so a backup whose archive stream
  // runs longer than the orphan window would age out while still live.
  const STAGING_PATTERN = /^openclaw-backup-[A-Za-z0-9]{6}$/u;

  // Both cases share one fixture and one elapsed window; only the live owner
  // differs, so the assertion isolates the fence itself.
  async function withStagingRootPastOrphanWindow(
    run: (params: { root: string; staging: string }) => Promise<void>,
  ): Promise<void> {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-fence-")));
    vi.useFakeTimers();
    try {
      const staging = path.join(root, "openclaw-backup-liv001");
      await fs.mkdir(staging);
      await fs.writeFile(path.join(staging, "manifest.json"), "{}\n");
      await run({ root, staging });
    } finally {
      vi.useRealTimers();
      await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  it("keeps a staging directory alive across a full orphan window", async () => {
    await withStagingRootPastOrphanWindow(async ({ root, staging }) => {
      const stopKeepAlive = keepBackupTempDirectoryAlive(staging, await fs.lstat(staging));
      try {
        // Models an archive stream that outlives the window: `tar` only reads
        // staging, so the heartbeat is the sole thing keeping it claimed
        // while this run — and its sweep against it — is still live.
        await vi.advanceTimersByTimeAsync(25 * HOUR_MS);

        await sweepStaleBackupTempDirectories({
          directoryPath: root,
          entryPattern: STAGING_PATTERN,
        });

        expect(await pathExists(staging)).toBe(true);
      } finally {
        stopKeepAlive();
      }
    });
  });

  it("reclaims the same directory once its owner stops refreshing", async () => {
    await withStagingRootPastOrphanWindow(async ({ root, staging }) => {
      // The hard-kill case: ownership was established (the marker exists)
      // but nothing refreshes it afterward. Written directly rather than via
      // `keepBackupTempDirectoryAlive`, whose stop function always removes
      // the marker as part of a clean finish — this models the marker
      // outliving the process that wrote it, not a clean stop.
      await fs.writeFile(path.join(staging, OWNER_MARKER_FILENAME), "", { mode: 0o600 });
      await vi.advanceTimersByTimeAsync(25 * HOUR_MS);

      await sweepStaleBackupTempDirectories({
        directoryPath: root,
        entryPattern: STAGING_PATTERN,
      });

      expect(await pathExists(staging)).toBe(false);
    });
  });

  it("leaves the same directory alone when no run ever claimed it", async () => {
    await withStagingRootPastOrphanWindow(async ({ root, staging }) => {
      // Negative control for the marker itself: identical shape and age, but
      // no run ever wrote the ownership marker — the pre-upgrade case, which
      // must never be reclaimed no matter how idle it looks.
      await vi.advanceTimersByTimeAsync(25 * HOUR_MS);

      await sweepStaleBackupTempDirectories({
        directoryPath: root,
        entryPattern: STAGING_PATTERN,
      });

      expect(await pathExists(staging)).toBe(true);
    });
  });

  it("creates a private marker and retires it without leaving a timer", async () => {
    await withStagingRootPastOrphanWindow(async ({ staging }) => {
      const marker = path.join(staging, OWNER_MARKER_FILENAME);
      const stop = keepBackupTempDirectoryAlive(staging, await fs.lstat(staging));
      try {
        const identity = await fs.lstat(marker);
        expect(identity.isFile()).toBe(true);
        expect(identity.nlink).toBe(1);
        if (process.platform !== "win32") {
          expect(identity.mode & 0o777).toBe(0o600);
        }
        expect(stop()).toBe(true);
        expect(stop()).toBe(true);
        await expect(fs.lstat(marker)).rejects.toMatchObject({ code: "ENOENT" });
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        stop();
      }
    });
  });

  it.each(["before stop", "after stop"] as const)(
    "preserves a marker replaced %s",
    async (replacementTime) => {
      await withStagingRootPastOrphanWindow(async ({ root, staging }) => {
        const marker = path.join(staging, OWNER_MARKER_FILENAME);
        const stop = keepBackupTempDirectoryAlive(staging, await fs.lstat(staging));
        try {
          if (replacementTime === "after stop") {
            expect(stop()).toBe(true);
          } else {
            await fs.rename(marker, path.join(root, "original-owner"));
          }
          await fs.writeFile(marker, "replacement owner", { mode: 0o600 });
          const beforeRefresh = await fs.lstat(staging);

          await vi.advanceTimersByTimeAsync(HOUR_MS);

          expect((await fs.lstat(staging)).mtimeMs).toBe(beforeRefresh.mtimeMs);
          const retired = stop();
          expect(await fs.readFile(marker, "utf8")).toBe("replacement owner");
          expect(retired).toBe(false);
          expect(vi.getTimerCount()).toBe(0);
        } finally {
          stop();
        }
      });
    },
  );

  it("preserves a replacement directory during refresh and stop", async () => {
    await withStagingRootPastOrphanWindow(async ({ root, staging }) => {
      const stop = keepBackupTempDirectoryAlive(staging, await fs.lstat(staging));
      try {
        await fs.rename(staging, path.join(root, "original-staging"));
        await writeAgedOwnedDirectory(staging, 48 * HOUR_MS);
        const beforeRefresh = await fs.lstat(staging);

        await vi.advanceTimersByTimeAsync(HOUR_MS);

        expect((await fs.lstat(staging)).mtimeMs).toBe(beforeRefresh.mtimeMs);
        expect(stop()).toBe(false);
        expect(await fs.readFile(path.join(staging, "archive.tar.gz.tmp"), "utf8")).toBe(
          "orphaned payload\n",
        );
        expect(await pathExists(path.join(staging, OWNER_MARKER_FILENAME))).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        stop();
      }
    });
  });

  it("rejects a changed directory before creating its ownership marker", async () => {
    await withStagingRootPastOrphanWindow(async ({ root, staging }) => {
      const identity = await fs.lstat(staging);
      await fs.rename(staging, path.join(root, "original-staging"));
      await fs.mkdir(staging);

      expect(() => keepBackupTempDirectoryAlive(staging, identity)).toThrow();

      expect(await fs.readdir(staging)).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  it.each(["file", "directory"] as const)(
    "refuses an existing marker %s without starting a timer",
    async (markerType) => {
      await withStagingRootPastOrphanWindow(async ({ staging }) => {
        const marker = path.join(staging, OWNER_MARKER_FILENAME);
        const payload = markerType === "file" ? marker : path.join(marker, "foreign-data");
        if (markerType === "directory") {
          await fs.mkdir(marker);
        }
        await fs.writeFile(payload, "existing owner", { mode: 0o600 });
        const identity = await fs.lstat(staging);

        expect(() => keepBackupTempDirectoryAlive(staging, identity)).toThrow();

        expect(await fs.readFile(payload, "utf8")).toBe("existing owner");
        expect(vi.getTimerCount()).toBe(0);
      });
    },
  );

  it.each(["unchanged directory", "replaced marker", "replaced directory"] as const)(
    "cleans only its own marker after close fails: %s",
    async (ownerState) => {
      await withStagingRootPastOrphanWindow(async ({ root, staging }) => {
        const identity = await fs.lstat(staging);
        const marker = path.join(staging, OWNER_MARKER_FILENAME);
        const failure = Object.assign(new Error("Cannot close ownership marker"), { code: "EIO" });
        const originalClose = fsSync.closeSync.bind(fsSync);
        const closeSpy = vi.spyOn(fsSync, "closeSync").mockImplementationOnce((descriptor) => {
          originalClose(descriptor);
          if (ownerState === "replaced directory") {
            fsSync.renameSync(staging, path.join(root, "original-staging"));
            fsSync.mkdirSync(staging);
          } else if (ownerState === "replaced marker") {
            fsSync.renameSync(marker, path.join(root, "original-owner"));
          }
          if (ownerState !== "unchanged directory") {
            fsSync.writeFileSync(marker, "replacement owner", { mode: 0o600 });
          }
          throw failure;
        });
        try {
          expect(() => keepBackupTempDirectoryAlive(staging, identity)).toThrow(failure);
        } finally {
          closeSpy.mockRestore();
        }

        if (ownerState === "unchanged directory") {
          await expect(fs.lstat(marker)).rejects.toMatchObject({ code: "ENOENT" });
          expect(await fs.readFile(path.join(staging, "manifest.json"), "utf8")).toBe("{}\n");
        } else {
          expect(await fs.readFile(marker, "utf8")).toBe("replacement owner");
        }
        expect(vi.getTimerCount()).toBe(0);
      });
    },
  );

  it.each(["directory replacement", "marker replacement", "refresh", "unreadable child"] as const)(
    "preserves staging after %s during inspection",
    async (change) => {
      await withStagingRootPastOrphanWindow(async ({ root, staging }) => {
        await fs.unlink(path.join(staging, "manifest.json"));
        const stop =
          change === "refresh"
            ? keepBackupTempDirectoryAlive(staging, await fs.lstat(staging))
            : undefined;
        await writeAgedOwnedDirectory(staging, 48 * HOUR_MS);
        const archive = path.join(staging, "archive.tar.gz.tmp");
        const marker = path.join(staging, OWNER_MARKER_FILENAME);
        const stamp = new Date(Date.now() - 48 * HOUR_MS);
        const originalLstat = fsSync.lstatSync.bind(fsSync);
        let changed = false;
        const lstatSpy = vi.spyOn(fsSync, "lstatSync").mockImplementation((target, options) => {
          const identity = originalLstat(target, options);
          if (String(target) === archive && !changed) {
            changed = true;
            switch (change) {
              case "directory replacement":
                fsSync.renameSync(staging, path.join(root, "original-staging"));
                fsSync.mkdirSync(staging);
                fsSync.writeFileSync(archive, "orphaned payload\n");
                fsSync.writeFileSync(marker, "replacement owner", { mode: 0o600 });
                fsSync.utimesSync(archive, stamp, stamp);
                fsSync.utimesSync(marker, stamp, stamp);
                fsSync.utimesSync(staging, stamp, stamp);
                break;
              case "marker replacement":
                fsSync.renameSync(marker, path.join(root, "original-owner"));
                fsSync.writeFileSync(marker, "replacement owner", { mode: 0o600 });
                fsSync.utimesSync(marker, stamp, stamp);
                fsSync.utimesSync(staging, stamp, stamp);
                break;
              case "refresh":
                vi.advanceTimersByTime(HOUR_MS);
                break;
              case "unreadable child":
                throw Object.assign(new Error("Cannot inspect archive"), { code: "EIO" });
            }
          }
          return identity;
        });
        try {
          await sweepStaleBackupTempDirectories({
            directoryPath: root,
            entryPattern: STAGING_PATTERN,
          });
        } finally {
          lstatSpy.mockRestore();
          stop?.();
        }

        expect(changed).toBe(true);
        expect(await fs.readFile(archive, "utf8")).toBe("orphaned payload\n");
        if (change === "directory replacement" || change === "marker replacement") {
          expect(await fs.readFile(marker, "utf8")).toBe("replacement owner");
        }
      });
    },
  );

  it.each(["directory", "hardlink"] as const)(
    "preserves an aged directory with a %s ownership marker",
    async (markerType) => {
      await withStagingRootPastOrphanWindow(async ({ root, staging }) => {
        await writeAgedOwnedDirectory(staging, 48 * HOUR_MS);
        const marker = path.join(staging, OWNER_MARKER_FILENAME);
        const originalMarker = path.join(root, "original-owner");
        await fs.rename(marker, originalMarker);
        if (markerType === "directory") {
          await fs.mkdir(marker);
        } else {
          await fs.link(originalMarker, marker);
        }
        const stamp = new Date(Date.now() - 48 * HOUR_MS);
        await fs.utimes(marker, stamp, stamp);
        await fs.utimes(staging, stamp, stamp);

        await sweepStaleBackupTempDirectories({
          directoryPath: root,
          entryPattern: STAGING_PATTERN,
        });

        expect(await fs.readFile(path.join(staging, "archive.tar.gz.tmp"), "utf8")).toBe(
          "orphaned payload\n",
        );
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "preserves an aged directory whose ownership marker is not private",
    async () => {
      await withStagingRootPastOrphanWindow(async ({ root, staging }) => {
        await writeAgedOwnedDirectory(staging, 48 * HOUR_MS);
        await fs.chmod(path.join(staging, OWNER_MARKER_FILENAME), 0o644);

        await sweepStaleBackupTempDirectories({
          directoryPath: root,
          entryPattern: STAGING_PATTERN,
        });

        expect(await fs.readFile(path.join(staging, "archive.tar.gz.tmp"), "utf8")).toBe(
          "orphaned payload\n",
        );
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "preserves symlinked staging, markers, and children without touching their targets",
    async () => {
      await withStagingRootPastOrphanWindow(async ({ root, staging }) => {
        const foreign = path.join(root, "foreign-data");
        await fs.writeFile(foreign, "foreign payload", { mode: 0o600 });
        const stamp = new Date(Date.now() - 48 * HOUR_MS);
        await fs.utimes(foreign, stamp, stamp);
        const linkedMarker = path.join(root, "openclaw-backup-mark01");
        const linkedChild = path.join(root, "openclaw-backup-link01");
        const linkedDirectory = path.join(root, "openclaw-backup-link02");
        for (const directory of [linkedMarker, linkedChild]) {
          await writeAgedOwnedDirectory(directory, 48 * HOUR_MS);
        }
        await fs.unlink(path.join(linkedMarker, OWNER_MARKER_FILENAME));
        await fs.symlink(foreign, path.join(linkedMarker, OWNER_MARKER_FILENAME));
        await fs.symlink(foreign, path.join(linkedChild, "foreign-link"));
        await fs.utimes(linkedMarker, stamp, stamp);
        await fs.utimes(linkedChild, stamp, stamp);
        await fs.symlink(linkedChild, linkedDirectory);
        const stop = keepBackupTempDirectoryAlive(staging, await fs.lstat(staging));
        try {
          await fs.rename(staging, path.join(root, "original-staging"));
          await fs.symlink(linkedChild, staging);
          const beforeRefresh = await fs.lstat(linkedChild);

          await vi.advanceTimersByTimeAsync(HOUR_MS);
          expect(stop()).toBe(false);
          await sweepStaleBackupTempDirectories({
            directoryPath: root,
            entryPattern: STAGING_PATTERN,
          });

          expect((await fs.lstat(linkedChild)).mtimeMs).toBe(beforeRefresh.mtimeMs);
          expect((await fs.lstat(linkedDirectory)).isSymbolicLink()).toBe(true);
          expect((await fs.lstat(staging)).isSymbolicLink()).toBe(true);
          expect(
            (await fs.lstat(path.join(linkedMarker, OWNER_MARKER_FILENAME))).isSymbolicLink(),
          ).toBe(true);
          expect(await fs.readFile(foreign, "utf8")).toBe("foreign payload");
          expect(await pathExists(path.join(linkedChild, OWNER_MARKER_FILENAME))).toBe(true);
        } finally {
          stop();
        }
      });
    },
  );
});
