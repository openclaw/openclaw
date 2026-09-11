import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { removePreparedBackupArchive } from "./backup-create-stream.js";
import {
  keepBackupTempDirectoryAlive,
  sweepStaleBackupTempDirectories,
} from "./backup-temp-sweep.js";

const HOUR_MS = 60 * 60_000;
const OWNER_MARKER = ".openclaw-backup-owner";
const STAGING_PATTERN = /^openclaw-backup-[A-Za-z0-9]{6}$/u;

async function withWindowsMetadata(run: (root: string) => Promise<void>): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-backup-win-identity-"));
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  if (!platform) {
    throw new Error("Missing process.platform descriptor");
  }
  vi.useFakeTimers();
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  try {
    await run(root);
  } finally {
    vi.restoreAllMocks();
    vi.clearAllTimers();
    vi.useRealTimers();
    Object.defineProperty(process, "platform", platform);
    await fs.rm(root, { recursive: true, force: true });
  }
}

function createStaging(root: string): { staging: string; marker: string; archive: string } {
  const staging = path.join(root, "openclaw-backup-win001");
  fsSync.mkdirSync(staging);
  return {
    staging,
    marker: path.join(staging, OWNER_MARKER),
    archive: path.join(staging, "archive.tar.gz.tmp"),
  };
}

function ageStaging(staging: string): void {
  const stamp = new Date(Date.now() - 48 * HOUR_MS);
  for (const name of fsSync.readdirSync(staging)) {
    fsSync.utimesSync(path.join(staging, name), stamp, stamp);
  }
  fsSync.utimesSync(staging, stamp, stamp);
}

describe("backup staging with simulated Windows identity metadata", () => {
  it.each([
    { observation: "initial", field: "dev" },
    { observation: "initial", field: "ino" },
    { observation: "current", field: "dev" },
    { observation: "current", field: "ino" },
  ] as const)(
    "rejects a directory with unknown $observation $field before claiming it",
    async ({ observation, field }) => {
      await withWindowsMetadata(async (root) => {
        const { staging, marker } = createStaging(root);
        const identity = fsSync.lstatSync(staging);
        if (observation === "initial") {
          Object.defineProperty(identity, field, { value: 0 });
        }
        const originalLstat = fsSync.lstatSync.bind(fsSync);
        vi.spyOn(fsSync, "lstatSync").mockImplementation((target, options) => {
          const current = originalLstat(target, options);
          if (observation === "current" && String(target) === staging && current) {
            Object.defineProperty(current, field, { value: 0 });
          }
          return current;
        });

        expect(() => keepBackupTempDirectoryAlive(staging, identity)).toThrow();

        expect(fsSync.existsSync(marker)).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
      });
    },
  );

  it.each(["dev", "ino"] as const)(
    "rejects unknown initial marker %s without deleting the marker or starting a timer",
    async (field) => {
      await withWindowsMetadata(async (root) => {
        const { staging, marker } = createStaging(root);
        const identity = fsSync.lstatSync(staging);
        const originalFstat = fsSync.fstatSync.bind(fsSync);
        vi.spyOn(fsSync, "fstatSync").mockImplementationOnce((descriptor, options) => {
          const markerIdentity = originalFstat(descriptor, options);
          Object.defineProperty(markerIdentity, field, { value: 0 });
          return markerIdentity;
        });

        expect(() => keepBackupTempDirectoryAlive(staging, identity)).toThrow();

        expect(fsSync.readFileSync(marker, "utf8")).toBe("");
        expect(vi.getTimerCount()).toBe(0);
      });
    },
  );

  it.each([
    { owner: "directory", field: "dev" },
    { owner: "directory", field: "ino" },
    { owner: "marker", field: "dev" },
    { owner: "marker", field: "ino" },
  ] as const)(
    "preserves an owner with unknown current $owner $field during refresh and stop",
    async ({ owner, field }) => {
      await withWindowsMetadata(async (root) => {
        const { staging, marker, archive } = createStaging(root);
        const stop = keepBackupTempDirectoryAlive(staging, fsSync.lstatSync(staging));
        try {
          if (field === "ino") {
            if (owner === "directory") {
              const displaced = path.join(root, "original-staging");
              fsSync.renameSync(staging, displaced);
              fsSync.mkdirSync(staging);
              fsSync.renameSync(path.join(displaced, OWNER_MARKER), marker);
            } else {
              fsSync.renameSync(marker, path.join(root, "original-owner"));
              fsSync.writeFileSync(marker, "replacement owner", { mode: 0o600 });
            }
          }
          fsSync.writeFileSync(archive, "preserved archive");
          const previousMtime = fsSync.lstatSync(staging).mtimeMs;
          const originalLstat = fsSync.lstatSync.bind(fsSync);
          const unknownPath = owner === "directory" ? staging : marker;
          vi.spyOn(fsSync, "lstatSync").mockImplementation((target, options) => {
            const current = originalLstat(target, options);
            if (String(target) === unknownPath && current) {
              Object.defineProperty(current, field, { value: 0 });
            }
            return current;
          });

          await vi.advanceTimersByTimeAsync(HOUR_MS);
          const retired = stop();

          expect(originalLstat(staging).mtimeMs).toBe(previousMtime);
          expect(fsSync.readFileSync(archive, "utf8")).toBe("preserved archive");
          expect(fsSync.readFileSync(marker, "utf8")).toBe(
            owner === "marker" && field === "ino" ? "replacement owner" : "",
          );
          expect(retired).toBe(false);
          expect(vi.getTimerCount()).toBe(0);
        } finally {
          stop();
        }
      });
    },
  );

  it.each([
    { owner: "directory", observation: "initial", field: "dev" },
    { owner: "directory", observation: "initial", field: "ino" },
    { owner: "directory", observation: "current", field: "dev" },
    { owner: "directory", observation: "current", field: "ino" },
    { owner: "marker", observation: "initial", field: "dev" },
    { owner: "marker", observation: "initial", field: "ino" },
    { owner: "marker", observation: "current", field: "dev" },
    { owner: "marker", observation: "current", field: "ino" },
  ] as const)(
    "preserves stale staging with unknown $observation $owner $field",
    async ({ owner, observation, field }) => {
      await withWindowsMetadata(async (root) => {
        const { staging, marker, archive } = createStaging(root);
        fsSync.writeFileSync(marker, "", { mode: 0o600 });
        fsSync.writeFileSync(archive, "preserved archive");
        ageStaging(staging);
        const originalLstat = fsSync.lstatSync.bind(fsSync);
        const unknownPath = owner === "directory" ? staging : marker;
        let inspectedArchive = false;
        let obscuredIdentity = false;
        vi.spyOn(fsSync, "lstatSync").mockImplementation((target, options) => {
          const current = originalLstat(target, options);
          if (String(target) === archive && !inspectedArchive) {
            inspectedArchive = true;
            if (observation === "current" && field === "ino") {
              if (owner === "directory") {
                const displaced = path.join(root, "original-staging");
                fsSync.renameSync(staging, displaced);
                fsSync.mkdirSync(staging);
                fsSync.renameSync(path.join(displaced, OWNER_MARKER), marker);
                fsSync.writeFileSync(archive, "preserved archive");
              } else {
                fsSync.renameSync(marker, path.join(root, "original-owner"));
                fsSync.writeFileSync(marker, "replacement owner", { mode: 0o600 });
              }
              ageStaging(staging);
            }
          }
          if (
            String(target) === unknownPath &&
            current &&
            !obscuredIdentity &&
            (observation === "initial" || inspectedArchive)
          ) {
            obscuredIdentity = true;
            Object.defineProperty(current, field, { value: 0 });
          }
          return current;
        });

        await sweepStaleBackupTempDirectories({
          directoryPath: root,
          entryPattern: STAGING_PATTERN,
        });

        expect(obscuredIdentity).toBe(true);
        expect(fsSync.readFileSync(archive, "utf8")).toBe("preserved archive");
        expect(fsSync.readFileSync(marker, "utf8")).toBe(
          owner === "marker" && observation === "current" && field === "ino"
            ? "replacement owner"
            : "",
        );
      });
    },
  );

  it.each(["dev", "ino"] as const)(
    "preserves prepared archive bytes when current %s is unknown",
    async (field) => {
      await withWindowsMetadata(async (root) => {
        const { archive } = createStaging(root);
        fsSync.writeFileSync(archive, "prepared archive");
        const identity = fsSync.lstatSync(archive);
        if (field === "ino") {
          fsSync.renameSync(archive, path.join(root, "original-archive"));
          fsSync.writeFileSync(archive, "replacement archive");
        }
        const originalLstat = fsSync.lstatSync.bind(fsSync);
        vi.spyOn(fsSync, "lstatSync").mockImplementation((target, options) => {
          const current = originalLstat(target, options);
          if (String(target) === archive && current) {
            Object.defineProperty(current, field, { value: 0 });
          }
          return current;
        });

        const removed = removePreparedBackupArchive({ archivePath: archive, identity });

        expect(fsSync.readFileSync(archive, "utf8")).toBe(
          field === "ino" ? "replacement archive" : "prepared archive",
        );
        expect(removed).toBe(false);
      });
    },
  );

  it("refreshes and retires known owners, then reclaims a known stale orphan", async () => {
    await withWindowsMetadata(async (root) => {
      const { staging, marker, archive } = createStaging(root);
      const identity = fsSync.lstatSync(staging);
      expect(identity.dev).not.toBe(0);
      expect(identity.ino).not.toBe(0);
      const stop = keepBackupTempDirectoryAlive(staging, identity);
      try {
        fsSync.writeFileSync(archive, "orphaned archive");
        ageStaging(staging);
        await vi.advanceTimersByTimeAsync(HOUR_MS);

        await sweepStaleBackupTempDirectories({
          directoryPath: root,
          entryPattern: STAGING_PATTERN,
        });

        expect(fsSync.readFileSync(archive, "utf8")).toBe("orphaned archive");
        expect(stop()).toBe(true);
        expect(fsSync.existsSync(marker)).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        stop();
      }
      fsSync.writeFileSync(marker, "", { mode: 0o600 });
      ageStaging(staging);

      await sweepStaleBackupTempDirectories({ directoryPath: root, entryPattern: STAGING_PATTERN });

      expect(fsSync.existsSync(staging)).toBe(false);
    });
  });
});
