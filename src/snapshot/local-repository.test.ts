import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as directoryDurability from "@openclaw/fs-safe/durability";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { runExec } from "../process/exec.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "../state/openclaw-agent-db.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import {
  createAgentDatabase,
  createGlobalDatabase,
  createUnsafeIndexDrift,
  DURABLE_PLUGIN_BLOB_MARKER,
  seedGlobalPluginBlobSnapshotFixtures,
  seedStateLease,
  STATE_LEASE_MARKER,
  TRANSIENT_PLUGIN_BLOB_MARKER,
} from "./local-repository.schema.test-support.js";
import {
  createGenericDatabase,
  createGenericSnapshot as createSnapshot,
  expectMissing,
  readGenericValues,
  useLocalRepositoryFixtures,
  withDatabase,
} from "./local-repository.test-support.js";
import { hashSnapshotArtifact, readSnapshotManifest } from "./manifest.js";
import {
  SNAPSHOT_MANIFEST_FILENAME,
  SNAPSHOT_SQLITE_FILENAME,
  type SnapshotManifest,
  type SnapshotResult,
} from "./snapshot-provider.js";

const durabilityTestState = vi.hoisted(() => ({
  beforePin: undefined as ((directoryPath: string) => void | Promise<void>) | undefined,
  beforeSync: undefined as ((directoryPath: string) => void | Promise<void>) | undefined,
  pinnedSyncOutcome: undefined as
    | { status: "synced" }
    | { status: "unsupported"; code?: string }
    | undefined,
}));

vi.mock("@openclaw/fs-safe/durability", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openclaw/fs-safe/durability")>();
  return {
    ...actual,
    pinDirectory: async (...args: Parameters<typeof actual.pinDirectory>) => {
      const directory = args[0];
      await durabilityTestState.beforePin?.(
        typeof directory === "string" ? path.resolve(directory) : directory.path,
      );
      const pinned = await actual.pinDirectory(...args);
      return {
        receipt: pinned.receipt,
        assertCurrent: async () => pinned.assertCurrent(),
        close: async () => pinned.close(),
        sync: async () => {
          await durabilityTestState.beforeSync?.(pinned.receipt.path);
          return durabilityTestState.pinnedSyncOutcome ?? (await pinned.sync());
        },
      };
    },
    syncDirectory: async (...args: Parameters<typeof actual.syncDirectory>) => {
      const directory = args[0];
      await durabilityTestState.beforeSync?.(
        typeof directory === "string" ? path.resolve(directory) : directory.path,
      );
      return await actual.syncDirectory(...args);
    },
  };
});

import { createLocalSqliteSnapshotProvider } from "./local-repository.js";

const success = ({ manifest }: SnapshotResult) => ({ ok: true, manifest });
type Publication = Parameters<typeof directoryDurability.publishFileExclusive>[0];
function interceptPublication(action: (options: Publication) => Promise<void>, after = false) {
  const publish = directoryDurability.publishFileExclusive;
  vi.spyOn(directoryDurability, "publishFileExclusive").mockImplementation(async (options) => {
    if (!after) {
      await action(options);
    }
    const published = await publish(options);
    if (after) {
      await action(options);
    }
    return published;
  });
}
function interceptOpen(
  action: (
    pathname: string,
    flags: Parameters<typeof fs.open>[1],
    handle: Awaited<ReturnType<typeof fs.open>>,
  ) => Promise<void>,
) {
  const open = fs.open.bind(fs);
  vi.spyOn(fs, "open").mockImplementation(async (pathname, flags, mode) => {
    const handle = await open(pathname, flags, mode);
    await action(String(pathname), flags, handle);
    return handle;
  });
}

// Restore filesystem spies before the fixture tracker removes their directories.
afterEach(() => vi.restoreAllMocks());
const { createTempDir, createGenericRepositoryFixture: makeRepository } =
  useLocalRepositoryFixtures(afterEach);

async function repositoryFixture(options: Parameters<typeof makeRepository>[0] = {}) {
  const fixture = await makeRepository(options);
  return {
    ...fixture,
    create: (id = "test") => createSnapshot(fixture.provider, fixture.sourcePath, id),
  };
}

async function snapshotFixture(options: Parameters<typeof makeRepository>[0] = {}) {
  const fixture = await repositoryFixture(options);
  const snapshot = await fixture.create();
  return {
    ...fixture,
    snapshot,
    file: (name = SNAPSHOT_SQLITE_FILENAME) => path.join(snapshot.ref.path, name),
    verify: () => fixture.provider.verify(snapshot.ref),
    restore: (target = fixture.restorePath) => fixture.provider.restoreFresh(snapshot.ref, target),
  };
}

afterEach(() => {
  durabilityTestState.beforePin = undefined;
  durabilityTestState.beforeSync = undefined;
  durabilityTestState.pinnedSyncOutcome = undefined;
});

async function refreshArtifactManifest(result: SnapshotResult): Promise<void> {
  const { sha256, sizeBytes } = await hashSnapshotArtifact(result.ref.path);
  const manifest = await readSnapshotManifest(result.ref.path);
  await fs.writeFile(
    path.join(result.ref.path, SNAPSHOT_MANIFEST_FILENAME),
    `${JSON.stringify({ ...manifest, artifact: { ...manifest.artifact, sha256, sizeBytes } }, null, 2)}\n`,
  );
}

async function pendingSnapshot() {
  const fixture = await snapshotFixture();
  const pendingPath = path.join(fixture.snapshot.ref.path, ".pending");
  await fs.writeFile(pendingPath, "");
  return { ...fixture, pendingPath };
}

async function stagingFixture(mode = 0o700, sharedMode?: number) {
  const { tempDir, sourcePath, repositoryPath } = await repositoryFixture();
  const sharedPath = path.join(tempDir, "shared");
  const validationRootPath = path.join(sharedPath, "validation");
  const restoreParentPath = path.join(sharedPath, "restore");
  for (const directory of [validationRootPath, restoreParentPath]) {
    await fs.mkdir(directory, { recursive: true, mode });
    await fs.chmod(directory, mode);
  }
  if (sharedMode !== undefined) {
    await fs.chmod(sharedPath, sharedMode);
  }
  const provider = createLocalSqliteSnapshotProvider({ repositoryPath, validationRootPath });
  const snapshot = await createSnapshot(provider, sourcePath, "test");
  return {
    provider,
    snapshot,
    sharedPath,
    validationRootPath,
    restorePath: path.join(restoreParentPath, "source.sqlite"),
  };
}

function readGlobalRows(file: string) {
  return withDatabase(
    file,
    (database) => ({
      queue: database.prepare("SELECT COUNT(*) AS count FROM delivery_queue_entries").get(),
      leases: database.prepare("SELECT COUNT(*) AS count FROM state_leases").get(),
      blobs: database
        .prepare(
          "SELECT plugin_id, entry_key FROM plugin_blob_entries ORDER BY plugin_id, entry_key",
        )
        .all(),
    }),
    { readOnly: true },
  );
}

describe("local SQLite snapshot repository", () => {
  it.runIf(process.platform !== "win32").each([
    { label: "000", mode: 0o000 },
    { label: "777", mode: 0o777 },
  ])(
    "repairs an existing private repository from mode $label before pinning it",
    async (testCase) => {
      const { repositoryPath, create } = await repositoryFixture();
      await fs.mkdir(repositoryPath, { mode: testCase.mode });
      await fs.chmod(repositoryPath, testCase.mode);

      try {
        await expect(create("repair-existing-repository")).resolves.toBeDefined();
        expect((await fs.stat(repositoryPath)).mode & 0o777).toBe(0o700);
      } finally {
        await fs.chmod(repositoryPath, 0o700).catch(() => undefined);
      }
    },
  );

  it("cleans a pending marker whose file sync fails", async () => {
    const { repositoryPath, create } = await repositoryFixture();
    let syncFailed = false;
    interceptOpen(async (filePath, flags, handle) => {
      if (!syncFailed && flags === "wx+" && path.basename(filePath) === ".pending") {
        vi.spyOn(handle, "sync").mockImplementation(async () => {
          syncFailed = true;
          throw Object.assign(new Error("pending sync failed"), { code: "EIO" });
        });
      }
    });

    await expect(create()).rejects.toThrow(/pending sync failed/u);
    expect(syncFailed).toBe(true);
    await expect(fs.readdir(repositoryPath)).resolves.toEqual([]);
  });

  it.runIf(process.platform !== "win32")("durably stages before publishing", async () => {
    const { repositoryPath, create } = await repositoryFixture({
      now: () => new Date("2026-07-24T16:00:00.000Z"),
    });
    await fs.mkdir(repositoryPath, { mode: 0o700 });
    const events: string[] = [];
    let snapshotDir: string | undefined;
    durabilityTestState.beforeSync = (directoryPath) => {
      if (snapshotDir && directoryPath === snapshotDir) {
        events.push("snapshot-sync");
      } else if (directoryPath === repositoryPath) {
        events.push("repository-sync");
      }
    };
    interceptOpen(async (filePath, flags, handle) => {
      const resolvedPath = path.resolve(filePath);
      if (flags === "wx+" && path.basename(resolvedPath) === ".pending") {
        snapshotDir = path.dirname(resolvedPath);
        const originalSync = handle.sync.bind(handle);
        vi.spyOn(handle, "sync").mockImplementation(async () => {
          events.push("pending-sync");
          await originalSync();
        });
      }
    });
    interceptPublication(async (options) => {
      if (snapshotDir && path.dirname(options.targetPath) === snapshotDir) {
        events.push(`publish:${path.basename(options.targetPath)}`);
      }
    });
    const originalUnlink = fsSync.unlinkSync.bind(fsSync);
    vi.spyOn(fsSync, "unlinkSync").mockImplementation((filePath) => {
      if (path.basename(String(filePath)) === ".pending") {
        events.push("pending-unlink");
      }
      originalUnlink(filePath);
    });

    await create();

    const snapshotSyncs = events
      .map((event, index) => (event === "snapshot-sync" ? index : -1))
      .filter((index) => index >= 0);
    expect(snapshotSyncs).toHaveLength(3);
    const ordered = [
      events.indexOf("pending-sync"),
      snapshotSyncs[0] ?? -1,
      events.indexOf("repository-sync"),
      events.indexOf(`publish:${SNAPSHOT_SQLITE_FILENAME}`),
      events.indexOf(`publish:${SNAPSHOT_MANIFEST_FILENAME}`),
      snapshotSyncs[1] ?? -1,
      events.indexOf("pending-unlink"),
      snapshotSyncs[2] ?? -1,
    ];
    for (let index = 1; index < ordered.length; index++) {
      expect(ordered[index - 1]).toBeLessThan(ordered[index] ?? -1);
    }
  });

  it("sorts snapshots newest first and ignores incomplete staging directories", async () => {
    const dates = [new Date("2026-07-12T14:00:00.000Z"), new Date("2026-07-12T14:01:00.000Z")];
    const { provider, repositoryPath, create } = await repositoryFixture({
      now: () => dates.shift() ?? new Date("invalid"),
    });
    const first = await create();
    const second = await create();
    await fs.mkdir(path.join(repositoryPath, ".tmp-interrupted"));
    await fs.mkdir(path.join(repositoryPath, "interrupted-final"));
    await fs.writeFile(path.join(repositoryPath, "interrupted-final", ".pending"), "");
    await fs.mkdir(path.join(repositoryPath, "empty-final"));

    await expect(provider.list()).resolves.toEqual([second, first]);
  });

  it.each(["before content inspection", "after content inspection"] as const)(
    "keeps a snapshot recovered while its creator is paused %s",
    async (phase) => {
      const { provider, repositoryPath, restorePath, create } = await repositoryFixture({
        database: { values: ["recovered"] },
      });
      await fs.mkdir(repositoryPath, { mode: 0o700 });
      const canonicalRepositoryPath = await fs.realpath(repositoryPath);
      const paused = createDeferred();
      const resume = createDeferred();
      let snapshotDir: string | undefined;
      let creatorPaused = false;
      durabilityTestState.beforePin = (directoryPath) => {
        if (
          path.dirname(directoryPath) === canonicalRepositoryPath &&
          !path.basename(directoryPath).startsWith(".tmp-")
        ) {
          snapshotDir ??= directoryPath;
        }
      };
      durabilityTestState.beforeSync = async (directoryPath) => {
        if (!snapshotDir || creatorPaused) {
          return;
        }
        const pausePath =
          phase === "before content inspection" ? snapshotDir : canonicalRepositoryPath;
        if (directoryPath !== pausePath) {
          return;
        }
        const entries = await fs.readdir(snapshotDir);
        if (
          !entries.includes(SNAPSHOT_MANIFEST_FILENAME) ||
          !entries.includes(SNAPSHOT_SQLITE_FILENAME)
        ) {
          return;
        }
        creatorPaused = true;
        paused.resolve();
        await resume.promise;
      };
      const creating = create();
      const creationOutcome = Promise.allSettled([creating]);
      try {
        await Promise.race([
          paused.promise,
          creating.then(() => {
            throw new Error("Snapshot creation finished before the recovery barrier.");
          }),
        ]);
        const recovered = await provider.list();
        const snapshot = recovered.at(0);
        if (!snapshot) {
          throw new Error("Expected a recovered snapshot while creation was paused.");
        }
        expect(recovered).toEqual([snapshot]);
        await expectMissing(path.join(snapshot.ref.path, ".pending"));

        resume.resolve();
        const outcome = await creationOutcome;
        expect({ creation: outcome, snapshots: await provider.list() }).toEqual({
          creation: [{ status: "fulfilled", value: snapshot }],
          snapshots: [snapshot],
        });
        await expect(provider.verify(snapshot.ref)).resolves.toEqual(success(snapshot));
        await expect(provider.restoreFresh(snapshot.ref, restorePath)).resolves.toEqual(
          success(snapshot),
        );
        expect(readGenericValues(restorePath)).toEqual([{ value: "recovered" }]);
      } finally {
        resume.resolve();
        await creationOutcome;
        durabilityTestState.beforePin = undefined;
        durabilityTestState.beforeSync = undefined;
      }
    },
  );

  it("recovers a complete pending snapshot through direct verify and restore", async () => {
    const { restorePath, snapshot, verify, restore } = await snapshotFixture({
      database: { values: ["durable"] },
    });
    const pendingPath = path.join(snapshot.ref.path, ".pending");

    await fs.writeFile(pendingPath, "");
    await expect(verify()).resolves.toEqual(success(snapshot));
    await expectMissing(pendingPath);

    await fs.writeFile(pendingPath, "");
    await expect(restore()).resolves.toEqual(success(snapshot));
    await expectMissing(pendingPath);
    expect(readGenericValues(restorePath)).toEqual([{ value: "durable" }]);
  });

  it("allows concurrent callers to recover the same complete pending snapshot", async () => {
    const { provider, snapshot, pendingPath } = await pendingSnapshot();

    let syncArrivals = 0;
    const syncBarrier = createDeferred();
    durabilityTestState.beforeSync = async (directoryPath) => {
      if (directoryPath !== snapshot.ref.path || syncArrivals >= 2) {
        return;
      }
      syncArrivals += 1;
      if (syncArrivals === 2) {
        syncBarrier.resolve();
      }
      await syncBarrier.promise;
    };

    await expect(Promise.all([provider.list(), provider.list()])).resolves.toEqual([
      [snapshot],
      [snapshot],
    ]);
    expect(syncArrivals).toBe(2);
    await expectMissing(pendingPath);
  });

  it("accepts a concurrent commit after classifying a complete pending snapshot", async () => {
    const { provider, snapshot, pendingPath, verify } = await pendingSnapshot();
    durabilityTestState.beforePin = async (directoryPath) => {
      if (directoryPath === snapshot.ref.path) {
        durabilityTestState.beforePin = undefined;
        await fs.unlink(pendingPath);
      }
    };

    await expect(provider.list()).resolves.toEqual([snapshot]);
    await expect(verify()).resolves.toMatchObject({ ok: true });
  });

  it("preserves the pending marker when recovery cannot guarantee directory durability", async () => {
    const { provider, snapshot, pendingPath } = await pendingSnapshot();
    durabilityTestState.pinnedSyncOutcome = { status: "unsupported", code: "ENOTSUP" };

    await expect(provider.list()).rejects.toThrow(/crash-durable directory synchronization/u);
    await fs.access(pendingPath);

    durabilityTestState.pinnedSyncOutcome = undefined;
    await expect(provider.list()).resolves.toEqual([snapshot]);
  });

  it.each([
    { defect: "hardlinked marker", error: /pending marker is unsafe/u },
    { defect: "corrupt artifact", error: /size mismatch|hash mismatch/u },
  ])("preserves a pending snapshot with a $defect", async ({ defect, error }) => {
    const { provider, snapshot, tempDir, file } = await snapshotFixture();
    const pendingPath = path.join(snapshot.ref.path, ".pending");
    if (defect === "hardlinked marker") {
      const markerSourcePath = path.join(tempDir, "pending-marker");
      await fs.writeFile(markerSourcePath, "");
      await fs.link(markerSourcePath, pendingPath);
    } else {
      await fs.writeFile(pendingPath, "");
      await fs.appendFile(file(), "corrupt");
    }

    await expect(provider.list()).rejects.toThrow(error);
    await fs.access(pendingPath);
  });

  it("rejects markerless partial snapshot directories containing only a manifest", async () => {
    const tempDir = await createTempDir();
    const repositoryPath = path.join(tempDir, "snapshots");
    const partialPath = path.join(repositoryPath, "markerless-partial");
    await fs.mkdir(partialPath, { recursive: true });
    await fs.writeFile(path.join(partialPath, SNAPSHOT_MANIFEST_FILENAME), "partial");
    const provider = createLocalSqliteSnapshotProvider({ repositoryPath });

    await expect(provider.list()).rejects.toThrow();
  });

  it.runIf(process.platform !== "win32")("rejects replaceable repository ancestors", async () => {
    const tempDir = await createTempDir();
    const sourcePath = path.join(tempDir, "source.sqlite");
    const sharedPath = path.join(tempDir, "shared");
    const repositoryPath = path.join(sharedPath, "snapshots");
    createGenericDatabase(sourcePath);
    await fs.mkdir(sharedPath, { mode: 0o777 });
    await fs.chmod(sharedPath, 0o777);
    const provider = createLocalSqliteSnapshotProvider({ repositoryPath });

    await expect(
      createSnapshot(provider, sourcePath, "replaceable-repository-ancestor"),
    ).rejects.toThrow(/ancestor must not allow another user/u);
    await expect(fs.readdir(repositoryPath)).resolves.toEqual([]);
  });

  it.runIf(process.platform === "win32")(
    "rejects snapshot repositories with inheritable Everyone access",
    async () => {
      const tempDir = await createTempDir();
      const sourcePath = path.join(tempDir, "source.sqlite");
      const sharedPath = path.join(tempDir, "shared");
      const repositoryPath = path.join(sharedPath, "snapshots");
      const icacls = path.join(
        process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows",
        "System32",
        "icacls.exe",
      );
      createGenericDatabase(sourcePath);
      await fs.mkdir(sharedPath);
      await runExec(icacls, [sharedPath, "/grant", "*S-1-1-0:(OI)(CI)(F)"]);
      const provider = createLocalSqliteSnapshotProvider({ repositoryPath });

      try {
        await expect(
          createSnapshot(provider, sourcePath, "windows-everyone-repository"),
        ).rejects.toThrow(/Windows ACL permits untrusted SQLite staging access/u);
        await expect(fs.readdir(repositoryPath)).resolves.toEqual([]);
      } finally {
        await runExec(icacls, [sharedPath, "/remove:g", "*S-1-1-0"]).catch(() => undefined);
      }
    },
  );

  it.runIf(process.platform !== "win32").each([
    { scope: "root", mode: 0o777, error: /not writable by other users/u },
    { scope: "ancestor", mode: 0o700, error: /ancestor must not allow another user/u },
  ])(
    "rejects verification and restore staging with an untrusted $scope",
    async ({ scope, mode, error }) => {
      const { provider, snapshot, restorePath } = await stagingFixture(
        mode,
        scope === "ancestor" ? 0o777 : undefined,
      );

      await expect(provider.verify(snapshot.ref)).rejects.toThrow(error);
      await expect(provider.restoreFresh(snapshot.ref, restorePath)).rejects.toThrow(error);
      await expectMissing(restorePath);
    },
  );

  it.runIf(process.platform !== "win32")("rejects foreign-owned staging ancestors", async () => {
    const { provider, snapshot, sharedPath } = await stagingFixture(0o700, 0o1777);
    const canonicalSharedPath = await fs.realpath(sharedPath);
    const originalLstat = fs.lstat.bind(fs);
    vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
      const stat = await originalLstat(...args);
      if (path.resolve(String(args[0])) !== canonicalSharedPath) {
        return stat;
      }
      return new Proxy(stat, {
        get(target, property, receiver) {
          if (property === "uid") {
            return typeof target.uid === "bigint" ? target.uid + 1n : target.uid + 1;
          }
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    });

    try {
      for (const mode of [0o1777, 0o755, 0o555]) {
        await fs.chmod(sharedPath, mode);
        await expect(provider.verify(snapshot.ref)).rejects.toThrow(
          /ancestor must not allow another user/u,
        );
      }
    } finally {
      await fs.chmod(sharedPath, 0o700);
    }
  });

  it.runIf(process.platform === "darwin")(
    "rejects granting macOS ACLs on private roots, ancestors, and staging directories",
    async () => {
      const { provider, snapshot, sharedPath, validationRootPath } = await stagingFixture();

      const aclError = /macOS ACL permits untrusted SQLite staging access/u;
      try {
        for (const [pathname, acl, allowed] of [
          [validationRootPath, `${os.userInfo().username} allow read,write,delete`, true],
          [validationRootPath, "everyone deny delete", true],
          [validationRootPath, "everyone allow read,write,delete", false],
          [sharedPath, "everyone allow add_file,delete_child", false],
        ] as const) {
          await runExec("/bin/chmod", ["+a", acl, pathname]);
          const verification = expect(provider.verify(snapshot.ref));
          if (allowed) {
            await verification.resolves.toMatchObject({ ok: true });
          } else {
            await verification.rejects.toThrow(aclError);
          }
          await runExec("/bin/chmod", ["-N", pathname]);
        }

        const originalMkdtemp = fs.mkdtemp.bind(fs);
        vi.spyOn(fs, "mkdtemp").mockImplementation(async (prefix, options) => {
          const directoryPath = await originalMkdtemp(prefix, options);
          if (path.basename(directoryPath).startsWith(".tmp-verify-")) {
            await runExec("/bin/chmod", ["+a", "everyone allow read,write,delete", directoryPath]);
          }
          return directoryPath;
        });
        await expect(provider.verify(snapshot.ref)).rejects.toThrow(aclError);
      } finally {
        await Promise.all(
          [validationRootPath, sharedPath].map(
            async (pathname) =>
              await runExec("/bin/chmod", ["-N", pathname]).catch(() => undefined),
          ),
        );
      }
    },
  );

  it.each([false, true])(
    "preserves restore state and errors when cleanup fails (publication failed=%s)",
    async (publicationFailed) => {
      const { provider, restorePath, snapshot, restore } = await snapshotFixture({
        database: { values: ["published-before-cleanup"] },
      });
      if (publicationFailed) {
        vi.spyOn(directoryDurability, "publishFileExclusive").mockRejectedValue(
          Object.assign(new Error("hard links unsupported"), { code: "ENOTSUP" }),
        );
      }
      const originalUnlink = fs.unlink.bind(fs);
      vi.spyOn(fs, "unlink").mockImplementation(async (filePath) => {
        if (path.basename(path.dirname(String(filePath))).startsWith(".tmp-restore-")) {
          throw Object.assign(new Error("cleanup denied"), { code: "EACCES" });
        }
        return await originalUnlink(filePath);
      });

      if (publicationFailed) {
        const error = await provider
          .restoreFresh(snapshot.ref, restorePath)
          .catch((cause: unknown) => cause);
        expect(error).toBeInstanceOf(AggregateError);
        expect((error as AggregateError).errors.map(String)).toEqual([
          expect.stringMatching(/requires hard-link support/u),
          expect.stringMatching(/cleanup denied/u),
        ]);
        await expectMissing(restorePath);
      } else {
        await expect(restore()).rejects.toThrow(
          /Failed to clean private SQLite staging directory/u,
        );
        expect(readGenericValues(restorePath)).toEqual([{ value: "published-before-cleanup" }]);
      }
    },
  );

  it("fails restore when the final cleanup directory sync fails", async () => {
    const { restorePath, restore } = await snapshotFixture();
    const restoreParentPath = path.dirname(restorePath);
    durabilityTestState.beforeSync = async (directoryPath) => {
      const canonicalRestoreParent = await fs.realpath(restoreParentPath).catch(() => undefined);
      if (directoryPath === canonicalRestoreParent) {
        const entries = await fs.readdir(restoreParentPath);
        if (
          entries.includes(path.basename(restorePath)) &&
          entries.every((entry) => !entry.startsWith(".tmp-restore-"))
        ) {
          throw Object.assign(new Error("directory sync unavailable"), { code: "EIO" });
        }
      }
    };

    await expect(restore()).rejects.toThrow(/directory sync unavailable/u);
    await fs.access(restorePath);
  });

  it.runIf(process.platform !== "win32")("preserves directories raced into place", async () => {
    const { repositoryPath, create } = await repositoryFixture({
      now: () => new Date("2026-07-12T14:00:00.000Z"),
    });
    const originalMkdir = fs.mkdir.bind(fs);
    let racedPath: string | undefined;
    vi.spyOn(fs, "mkdir").mockImplementation(async (directoryPath, options) => {
      const resolvedPath = path.resolve(String(directoryPath));
      if (
        path.basename(path.dirname(resolvedPath)) === path.basename(repositoryPath) &&
        !path.basename(resolvedPath).startsWith(".tmp-")
      ) {
        racedPath = resolvedPath;
        await originalMkdir(resolvedPath, options);
        await fs.writeFile(path.join(resolvedPath, "keep"), "racer");
      }
      return await originalMkdir(directoryPath, options);
    });

    await expect(create()).rejects.toThrow(/directory already exists/u);
    expect(racedPath).toBeDefined();
    await expect(fs.readFile(path.join(racedPath!, "keep"), "utf8")).resolves.toBe("racer");
  });

  it("rejects an artifact changed after entering the final directory", async () => {
    const { provider, create } = await repositoryFixture();
    interceptPublication(async (options) => {
      if (
        path.basename(options.targetPath) === SNAPSHOT_MANIFEST_FILENAME &&
        !path.basename(path.dirname(options.targetPath)).startsWith(".tmp-")
      ) {
        await fs.appendFile(
          path.join(path.dirname(options.targetPath), SNAPSHOT_SQLITE_FILENAME),
          "changed-after-final-move",
        );
      }
    }, true);

    await expect(create()).rejects.toThrow(/size mismatch/u);
    await expect(provider.list()).resolves.toEqual([]);
  });

  it("rejects an artifact changed after removing the commit marker", async () => {
    const { repositoryPath, create } = await repositoryFixture();
    const originalUnlink = fsSync.unlinkSync.bind(fsSync);
    let mutated = false;
    vi.spyOn(fsSync, "unlinkSync").mockImplementation((filePath) => {
      originalUnlink(filePath);
      if (!mutated && path.basename(String(filePath)) === ".pending") {
        fsSync.appendFileSync(
          path.join(path.dirname(String(filePath)), SNAPSHOT_SQLITE_FILENAME),
          "changed-after-commit-marker",
        );
        mutated = true;
      }
    });

    await expect(create()).rejects.toThrow(/size mismatch/u);
    expect(mutated).toBe(true);
    await expect(fs.readdir(repositoryPath)).resolves.toEqual([]);
  });

  it.runIf(process.platform !== "win32")("rejects directories replaced during commit", async () => {
    const { repositoryPath, create } = await repositoryFixture();
    const originalUnlink = fsSync.unlinkSync.bind(fsSync);
    let raced = false;
    vi.spyOn(fsSync, "unlinkSync").mockImplementation((filePath) => {
      if (raced || path.basename(String(filePath)) !== ".pending") {
        originalUnlink(filePath);
        return;
      }
      const snapshotDir = path.dirname(String(filePath));
      const displacedDir = `${snapshotDir}.displaced`;
      fsSync.renameSync(snapshotDir, displacedDir);
      fsSync.mkdirSync(snapshotDir, { mode: 0o700 });
      fsSync.writeFileSync(path.join(snapshotDir, ".pending"), "", { mode: 0o600 });
      originalUnlink(filePath);
      fsSync.rmdirSync(snapshotDir);
      fsSync.renameSync(displacedDir, snapshotDir);
      raced = true;
    });

    await expect(create()).rejects.toThrow(/unexpected entry/u);
    expect(raced).toBe(true);
    await expect(fs.readdir(repositoryPath)).resolves.toEqual([]);
  });

  it.each(["before", "after"] as const)(
    "cleans an entry when its staging pathname changes %s publication",
    async (phase) => {
      const { provider, repositoryPath, create } = await repositoryFixture();
      const publish = directoryDurability.publishFileExclusive;
      let raced = false;
      vi.spyOn(directoryDurability, "publishFileExclusive").mockImplementation(async (options) => {
        const replaceStaging = async () => {
          if (
            !raced &&
            path.basename(options.targetPath) === SNAPSHOT_SQLITE_FILENAME &&
            path.dirname(path.dirname(options.targetPath)) ===
              (await fs.realpath(repositoryPath)) &&
            !path.basename(path.dirname(options.targetPath)).startsWith(".tmp-")
          ) {
            await fs.unlink(options.sourcePath);
            await fs.writeFile(options.sourcePath, "raced staging bytes");
            raced = true;
          }
        };
        if (phase === "before") {
          // Keep the removed inode live so the replacement cannot reuse its identity.
          const stagingHandle = await fs.open(options.sourcePath, "r");
          try {
            await replaceStaging();
            return await publish(options);
          } finally {
            await stagingHandle.close();
          }
        }
        const published = await publish(options);
        await replaceStaging();
        return published;
      });

      await expect(create()).rejects.toThrow(/publication|staging|target/u);
      expect(raced).toBe(true);
      await expect(provider.list()).resolves.toEqual([]);
      await expect(fs.readdir(repositoryPath)).resolves.toEqual([]);
    },
  );

  it("never overwrites a file raced into the final snapshot directory", async () => {
    const { repositoryPath, create } = await repositoryFixture();
    let racedPath: string | undefined;
    interceptPublication(async (options) => {
      const targetPath = path.resolve(options.targetPath);
      if (
        path.basename(targetPath) === SNAPSHOT_SQLITE_FILENAME &&
        path.dirname(path.dirname(targetPath)) === (await fs.realpath(repositoryPath)) &&
        !path.basename(path.dirname(targetPath)).startsWith(".tmp-")
      ) {
        racedPath = targetPath;
        await fs.writeFile(targetPath, "racer", { flag: "wx" });
      }
    });

    await expect(create()).rejects.toMatchObject({
      code: "EEXIST",
    });
    expect(racedPath).toBeDefined();
    await expect(fs.readFile(racedPath!, "utf8")).resolves.toBe("racer");
  });

  it("sanitizes transient global rows and enforces the global owner", async () => {
    const tempDir = await createTempDir();
    const sourcePath = path.join(tempDir, "openclaw.sqlite");
    const repositoryPath = path.join(tempDir, "snapshots");
    createGlobalDatabase(sourcePath);
    seedGlobalPluginBlobSnapshotFixtures(sourcePath);
    seedStateLease(sourcePath);
    const provider = createLocalSqliteSnapshotProvider({ repositoryPath });
    const snapshot = await provider.create({
      path: sourcePath,
      identity: { role: "global" },
    });
    const artifactPath = path.join(snapshot.ref.path, SNAPSHOT_SQLITE_FILENAME);
    const artifactBytes = await fs.readFile(artifactPath);
    expect(artifactBytes.includes("do-not-restore")).toBe(false);
    expect(artifactBytes.includes(TRANSIENT_PLUGIN_BLOB_MARKER)).toBe(false);
    expect(artifactBytes.includes(DURABLE_PLUGIN_BLOB_MARKER)).toBe(true);
    expect(artifactBytes.includes(STATE_LEASE_MARKER)).toBe(false);
    expect(readGlobalRows(artifactPath)).toEqual({
      queue: { count: 0 },
      leases: { count: 0 },
      blobs: [{ plugin_id: "durable-plugin", entry_key: "durable" }],
    });
    expect(readGlobalRows(sourcePath)).toEqual({
      queue: { count: 1 },
      leases: { count: 1 },
      blobs: [
        { plugin_id: "diffs", entry_key: "transient" },
        { plugin_id: "durable-plugin", entry_key: "durable" },
      ],
    });

    const wrongRolePath = path.join(tempDir, "wrong-role.sqlite");
    createAgentDatabase(wrongRolePath, "main");
    withDatabase(wrongRolePath, (database) => {
      database.exec(`PRAGMA user_version = ${OPENCLAW_STATE_SCHEMA_VERSION};`);
    });
    await expect(
      provider.create({ path: wrongRolePath, identity: { role: "global" } }),
    ).rejects.toThrow(/expected global/u);
  });

  it("enforces the exact agent owner and canonical agent id", async () => {
    const tempDir = await createTempDir();
    const sourcePath = path.join(tempDir, "openclaw-agent.sqlite");
    const repositoryPath = path.join(tempDir, "snapshots");
    createAgentDatabase(sourcePath, "worker-1");
    const provider = createLocalSqliteSnapshotProvider({ repositoryPath });
    const create = (agentId: string) =>
      provider.create({ path: sourcePath, identity: { role: "agent", agentId } });
    await expect(create("worker-2")).rejects.toThrow(/belongs to agent worker-1/u);
    await expect(create("Worker-1")).rejects.toThrow(/must be canonical/u);
    await expect(create("worker-1")).resolves.toMatchObject({
      manifest: {
        database: {
          role: "agent",
          agentId: "worker-1",
          userVersion: OPENCLAW_AGENT_SCHEMA_VERSION,
        },
      },
    });
  });

  it("detects artifact hash, user_version, and unsafe-index drift after creation", async () => {
    const { provider, create } = await repositoryFixture();

    const hashSnapshot = await create();
    await fs.appendFile(path.join(hashSnapshot.ref.path, SNAPSHOT_SQLITE_FILENAME), "tamper");
    await expect(provider.verify(hashSnapshot.ref)).rejects.toThrow(/size mismatch/u);

    const versionSnapshot = await create();
    withDatabase(path.join(versionSnapshot.ref.path, SNAPSHOT_SQLITE_FILENAME), (database) => {
      database.exec("PRAGMA user_version = 99;");
    });
    await refreshArtifactManifest(versionSnapshot);
    await expect(provider.verify(versionSnapshot.ref)).rejects.toThrow(/user_version mismatch/u);

    const unsafeSnapshot = await create();
    const unsafePath = path.join(unsafeSnapshot.ref.path, SNAPSHOT_SQLITE_FILENAME);
    createUnsafeIndexDrift(unsafePath);
    await refreshArtifactManifest(unsafeSnapshot);
    await expect(provider.verify(unsafeSnapshot.ref)).rejects.toThrow(
      /integrity_check failed|malformed database schema/iu,
    );
  });

  it("never overwrites an existing target or orphan SQLite sidecar", async () => {
    const { restorePath, tempDir, restore } = await snapshotFixture();
    await fs.mkdir(path.dirname(restorePath), { recursive: true });
    for (const suffix of ["", "-wal"]) {
      const existingPath = `${restorePath}${suffix}`;
      await fs.writeFile(existingPath, `keep${suffix}`);
      await expect(restore()).rejects.toThrow(/restore path already exists/u);
      await expect(fs.readFile(existingPath, "utf8")).resolves.toBe(`keep${suffix}`);
      if (suffix) {
        await expectMissing(restorePath);
      }
      await fs.unlink(existingPath);
    }

    if (process.platform !== "win32") {
      const externalPath = path.join(tempDir, "external.sqlite");
      await fs.writeFile(externalPath, "external");
      await fs.symlink(externalPath, restorePath);
      await expect(restore()).rejects.toThrow(/restore path already exists/u);
      await expect(fs.readFile(externalPath, "utf8")).resolves.toBe("external");
      expect((await fs.lstat(restorePath)).isSymbolicLink()).toBe(true);
    }
  });

  it.runIf(process.platform !== "win32")("rejects redirected restore parents", async () => {
    const { snapshot, tempDir, restore } = await snapshotFixture();
    const restoreParentPath = path.join(tempDir, "redirected");
    const restorePath = path.join(restoreParentPath, "restored.sqlite");
    const canonicalRestoreParentPath = path.join(
      await fs.realpath(tempDir),
      path.basename(restoreParentPath),
    );
    const originalRealpath = fs.realpath.bind(fs);
    let redirected = false;
    vi.spyOn(fs, "realpath").mockImplementation(async (...args) => {
      const pathname = path.resolve(String(args[0]));
      if (!redirected && pathname === canonicalRestoreParentPath) {
        redirected = true;
        await fs.rmdir(canonicalRestoreParentPath);
        await fs.symlink(snapshot.ref.path, canonicalRestoreParentPath, "dir");
      }
      return await originalRealpath(...args);
    });

    await expect(restore(restorePath)).rejects.toThrow(
      /restore target changed|outside snapshot repository|must be a real directory|not a directory/u,
    );
    expect(redirected).toBe(true);
    await expectMissing(path.join(snapshot.ref.path, path.basename(restorePath)));
  });

  it.runIf(process.platform !== "win32")("restores only manifest-verified bytes", async () => {
    const { restorePath, restore, file } = await snapshotFixture();
    interceptOpen(async (filePath, flags) => {
      if (
        flags === "wx+" &&
        path.basename(filePath) === SNAPSHOT_SQLITE_FILENAME &&
        path.basename(path.dirname(filePath)).startsWith(".tmp-restore-")
      ) {
        withDatabase(file(), (database) => {
          database.prepare("INSERT INTO entries (value) VALUES (?)").run("raced");
        });
      }
    });

    await expect(restore()).rejects.toThrow(/hash mismatch|size mismatch/u);
    await expectMissing(restorePath);
  });

  it.runIf(process.platform !== "win32")("never restores replaced staging bytes", async () => {
    const { restorePath, restore } = await snapshotFixture({
      database: { values: ["original"] },
    });
    const originalOpen = fs.open.bind(fs);
    vi.spyOn(fs, "open").mockImplementation(async (filePath, flags, mode) => {
      if (
        flags === "wx+" &&
        path.basename(path.dirname(String(filePath))).startsWith(".sqlite-publish-")
      ) {
        const stagingEntry = (await fs.readdir(path.dirname(restorePath))).find((entry) =>
          entry.startsWith(".tmp-restore-"),
        );
        if (!stagingEntry) {
          throw new Error("restore staging directory was not created");
        }
        const stagedPath = path.join(
          path.dirname(restorePath),
          stagingEntry,
          SNAPSHOT_SQLITE_FILENAME,
        );
        await fs.unlink(stagedPath);
        createGenericDatabase(stagedPath, { values: ["replacement"] });
      }
      return await originalOpen(filePath, flags, mode);
    });

    await restore().then(
      () => expect(readGenericValues(restorePath)).toEqual([{ value: "original" }]),
      async (error: unknown) => {
        expect(String(error)).toMatch(/file changed while reading/u);
        await expectMissing(restorePath);
      },
    );
  });

  it.runIf(process.platform !== "win32")("keeps sidecars raced into publication", async () => {
    const { restorePath, tempDir, restore } = await snapshotFixture();
    const canonicalRestorePath = path.join(await fs.realpath(tempDir), "restore", "source.sqlite");
    interceptPublication(async (options) => {
      if (path.resolve(options.targetPath) === canonicalRestorePath) {
        await fs.writeFile(`${canonicalRestorePath}-wal`, "racer");
      }
    }, true);

    await expect(restore()).rejects.toThrow(/unexpected sidecar/u);
    await expectMissing(restorePath);
    await expect(fs.readFile(`${restorePath}-wal`, "utf8")).resolves.toBe("racer");
  });

  it("rejects snapshots outside the configured repository and unexpected contents", async () => {
    const { provider, snapshot, tempDir, verify } = await snapshotFixture();

    await expect(provider.verify({ path: tempDir })).rejects.toThrow(/immediate child/u);
    await fs.writeFile(path.join(snapshot.ref.path, `${SNAPSHOT_SQLITE_FILENAME}-wal`), "orphan");
    await expect(verify()).rejects.toThrow(/unexpected entry/u);
    await expect(provider.list()).rejects.toThrow(/unexpected (?:incomplete )?entry/u);
  });

  it("bounds manifest reads before parsing untrusted snapshot metadata", async () => {
    const { verify, file } = await snapshotFixture();
    await fs.writeFile(file(SNAPSHOT_MANIFEST_FILENAME), Buffer.alloc(1024 * 1024 + 1, 0x20));

    await expect(verify()).rejects.toThrow(/1048576 bytes/u);
  });

  it.runIf(process.platform !== "win32")("rejects repository and artifact links", async () => {
    const tempDir = await createTempDir();
    const sourcePath = path.join(tempDir, "source.sqlite");
    const realRepositoryPath = path.join(tempDir, "real-snapshots");
    const repositoryLink = path.join(tempDir, "snapshot-link");
    createGenericDatabase(sourcePath);
    await fs.mkdir(realRepositoryPath);
    await fs.symlink(realRepositoryPath, repositoryLink);
    const linkedProvider = createLocalSqliteSnapshotProvider({
      repositoryPath: repositoryLink,
    });
    await expect(createSnapshot(linkedProvider, sourcePath, "symlink-repository")).rejects.toThrow(
      /symlink|Invalid path|real directory/iu,
    );

    const provider = createLocalSqliteSnapshotProvider({
      repositoryPath: realRepositoryPath,
    });
    const snapshot = await createSnapshot(provider, sourcePath, "links");
    const artifactPath = path.join(snapshot.ref.path, SNAPSHOT_SQLITE_FILENAME);
    const externalArtifact = path.join(tempDir, "external.sqlite");
    await fs.link(artifactPath, externalArtifact);
    await expect(provider.verify(snapshot.ref)).rejects.toThrow(/hardlink/iu);
    await fs.unlink(externalArtifact);

    const manifestPath = path.join(snapshot.ref.path, SNAPSHOT_MANIFEST_FILENAME);
    const realManifest = path.join(tempDir, "manifest.json");
    await fs.rename(manifestPath, realManifest);
    await fs.symlink(realManifest, manifestPath);
    await expect(provider.verify(snapshot.ref)).rejects.toThrow(/regular file|symlink/iu);
  });

  it.runIf(process.platform !== "win32")("rejects aliased repository restore targets", async () => {
    const { repositoryPath, snapshot, tempDir, verify } = await snapshotFixture();
    const aliasRoot = path.join(tempDir, "alias");
    await fs.symlink(tempDir, aliasRoot);
    const aliasRepositoryPath = path.join(aliasRoot, "snapshots");
    const aliasProvider = createLocalSqliteSnapshotProvider({
      repositoryPath: aliasRepositoryPath,
    });
    const aliasSnapshot = {
      path: path.join(aliasRepositoryPath, path.basename(snapshot.ref.path)),
    };

    await expect(
      aliasProvider.restoreFresh(aliasSnapshot, path.join(repositoryPath, "restored.sqlite")),
    ).rejects.toThrow(/outside snapshot repository/u);
    await expect(verify()).resolves.toMatchObject({ ok: true });
  });
});

describe("snapshot manifest parser", () => {
  const snapshotId = "snapshot";
  const validManifest: SnapshotManifest = {
    schemaVersion: 1,
    snapshotId,
    createdAt: "2026-07-12T14:00:00.000Z",
    database: {
      role: "agent",
      agentId: "worker-1",
      basename: "openclaw-agent.sqlite",
      userVersion: OPENCLAW_AGENT_SCHEMA_VERSION,
    },
    artifact: {
      path: SNAPSHOT_SQLITE_FILENAME,
      sha256: "a".repeat(64),
      sizeBytes: 4096,
    },
  };
  function manifest(
    overrides: {
      createdAt?: string;
      extra?: boolean;
      database?: Partial<SnapshotManifest["database"]>;
      artifact?: Omit<Partial<SnapshotManifest["artifact"]>, "path"> & { path?: string };
    } = {},
  ) {
    return {
      ...validManifest,
      ...overrides,
      database: { ...validManifest.database, ...overrides.database },
      artifact: { ...validManifest.artifact, ...overrides.artifact },
    };
  }

  it.each([
    ["unknown top-level field", manifest({ extra: true }), /fields must be exactly/u],
    ["wrong directory id", validManifest, /does not match directory/u, "other"],
    ["timestamp", manifest({ createdAt: "2026-07-12T14:00:00Z" }), /not canonical/u],
    [
      "path traversal",
      manifest({ artifact: { path: "../database.sqlite" } }),
      /artifact\.path must be database\.sqlite/u,
    ],
    [
      "prefixed digest",
      manifest({ artifact: { sha256: `sha256:${"a".repeat(64)}` } }),
      /sha256 is invalid/u,
    ],
    ["agent id", manifest({ database: { agentId: "Worker-1" } }), /agentId is invalid/u],
    ["basename", manifest({ database: { basename: "../db.sqlite" } }), /basename is invalid/u],
    ["user version", manifest({ database: { userVersion: 2 ** 31 } }), /userVersion is invalid/u],
    ["empty artifact", manifest({ artifact: { sizeBytes: 0 } }), /sizeBytes is invalid/u],
  ])("rejects %s", async (_name, value, error, expectedId = snapshotId) => {
    const snapshotDir = path.join(await createTempDir(), snapshotId);
    await fs.mkdir(snapshotDir);
    await fs.writeFile(
      path.join(snapshotDir, SNAPSHOT_MANIFEST_FILENAME),
      JSON.stringify(value),
      "utf8",
    );

    await expect(readSnapshotManifest(snapshotDir, expectedId)).rejects.toThrow(error);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
