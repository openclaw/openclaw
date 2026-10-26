import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { json } from "node:stream/consumers";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { claimBackupNamespace } from "../../commands/backup-namespace.js";
import type { OffsiteBackupResult } from "../../commands/backup-remote.js";
import { getRuntimeConfig } from "../../config/config.js";
import { createBackupScratchDirectory, finishBackupScratch } from "../../infra/backup-scratch.js";
import * as deviceIdentity from "../../infra/device-identity-async.js";
import { loadDeviceIdentityIfPresentAsync } from "../../infra/device-identity-async.js";
import { defaultRuntime } from "../../runtime.js";
import { readBackupRuns } from "../../state/backup-run-records.js";
import {
  openOpenClawStateDatabase,
  closeOpenClawStateDatabaseAsync,
} from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { filesystemStorageProvider } from "../../storage/filesystem.js";
import { openStorageLocation } from "../../storage/locations.js";
import type { StorageBackend } from "../../storage/types.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { registerBackupCommand } from "./register.backup.js";
import { registerStorageCommand } from "./register.storage.js";

afterEach(() => vi.restoreAllMocks());

async function scratchDirectories(root: string) {
  return (await fs.readdir(root)).filter((name) => name.startsWith("openclaw-backup-"));
}

async function expectRun(status: "ok" | "failed", fields: object = {}) {
  expect((await readBackupRuns(process.env))[0]).toMatchObject({ status, ...fields });
}

async function expectAbsent(file: string) {
  await expect(fs.stat(file)).rejects.toMatchObject({ code: "ENOENT" });
}

async function expectListing(directory: string, entries: string[], partial = false) {
  expect(await fs.readdir(directory)).toEqual(partial ? expect.arrayContaining(entries) : entries);
}

async function expectFile(file: string, content: string) {
  await expect(fs.readFile(file, "utf8")).resolves.toBe(content);
}

async function prepareStorage(state: OpenClawTestState, scratchRoot: string) {
  const destination = state.path("offsite");
  await fs.mkdir(destination);
  await fs.mkdir(scratchRoot, { recursive: true });
  vi.spyOn(os, "tmpdir").mockReturnValue(scratchRoot);
  await state.writeConfig(archiveConfig(destination));
  const harness = createCliHarness();
  await harness.run("storage", "init", "archive");
  return { destination, ...harness };
}

function archiveConfig(destination: string) {
  return {
    storage: {
      locations: {
        archive: {
          provider: "filesystem",
          settings: { path: destination },
          encryption: { passphrase: "synthetic-backup-test-passphrase" },
        },
      },
    },
  };
}

function createCliHarness() {
  const writeJson = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
  vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
  const errors = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
  vi.spyOn(defaultRuntime, "exit").mockImplementation((code) => {
    throw new Error(`CLI exit ${code}`);
  });
  const run = async (...argv: string[]) => {
    writeJson.mockClear();
    const program = new Command().exitOverride();
    registerBackupCommand(program);
    registerStorageCommand(program);
    await program.parseAsync([...argv, "--json"], { from: "user" });
    return writeJson.mock.calls.at(-1)?.[0];
  };
  const create = async (namespace: string, ...args: string[]): Promise<OffsiteBackupResult> =>
    (await run(
      "backup",
      "create",
      "--to",
      "archive",
      "--namespace",
      namespace,
      ...args,
    )) as OffsiteBackupResult;
  const from = (operation: string, namespace: string, ...args: string[]) =>
    run("backup", operation, ...args, "--from", "archive", "--namespace", namespace);
  const reject = async (operation: Promise<unknown>, message: string, fields: object) => {
    await expect(operation).rejects.toThrow();
    expect(errors.mock.calls.flat().join(" ")).toContain(message);
    await expectRun("failed", { target: "archive", error: message, ...fields });
    errors.mockClear();
  };
  return { run, create, from, errors, reject };
}

describe("offsite backup CLI", () => {
  async function withNamespaceRace(
    exercise: (fixture: {
      errors: ReturnType<typeof createCliHarness>["errors"];
      create: ReturnType<typeof createCliHarness>["create"];
      namespaceDir: string;
      scratchRoot: string;
      takeOver: () => Promise<void>;
      useNewOwner: () => void;
      intercept: (configure: (backend: StorageBackend) => void) => void;
    }) => Promise<void>,
  ) {
    await withOpenClawTestState({ layout: "state-only" }, async (state) => {
      const scratchRoot = state.path("scratch");
      const { destination, create, errors } = await prepareStorage(state, scratchRoot);
      const identity = await deviceIdentity.loadOrCreateProcessDeviceIdentityAsync();
      const nextIdentity = { ...identity, deviceId: "replacement-installation-device-id" };
      const location = await openStorageLocation({ name: "archive", config: getRuntimeConfig() });
      const scoped = location.scope("backups/test-host");
      try {
        await claimBackupNamespace(scoped, "test-host", identity.deviceId, false);
        const open = filesystemStorageProvider.open;
        await exercise({
          create,
          errors,
          namespaceDir: path.join(destination, "backups", "test-host"),
          scratchRoot,
          takeOver: () => claimBackupNamespace(scoped, "test-host", nextIdentity.deviceId, true),
          useNewOwner: () => {
            vi.spyOn(deviceIdentity, "loadOrCreateProcessDeviceIdentityAsync").mockResolvedValue(
              nextIdentity,
            );
          },
          intercept: (configure) => {
            vi.spyOn(filesystemStorageProvider, "open").mockImplementation(async (params) => {
              const backend = await open(params);
              configure(backend);
              return backend;
            });
          },
        });
      } finally {
        await location.close();
      }
    });
  }

  it("rejects publication after namespace takeover during streaming and lets the new owner create", async () => {
    await withNamespaceRace(async (fixture) => {
      const before = await fs.readdir(fixture.namespaceDir);
      let displaced = false;
      fixture.intercept((backend) => {
        const put = backend.putObject;
        backend.putObject = (key, body, opts) =>
          put(
            key,
            (async function* () {
              for await (const chunk of body) {
                yield chunk;
                if (key.endsWith(".tar.gz") && !displaced) {
                  displaced = true;
                  await fixture.takeOver();
                }
              }
            })(),
            opts,
          );
      });
      const create = () => fixture.create("test-host", "--only-config");
      await expect(create()).rejects.toThrow("CLI exit 1");
      expect(displaced).toBe(true);
      await expectListing(fixture.namespaceDir, before);
      await expectListing(fixture.scratchRoot, []);
      await expectRun("failed", {
        target: "archive",
        namespace: "test-host",
        error: expect.stringContaining("belongs to another OpenClaw installation"),
      });
      expect(fixture.errors.mock.calls.flat().join(" ")).toContain(
        "belongs to another OpenClaw installation",
      );
      fixture.useNewOwner();
      const created = await create();
      expect(created.verified).toBe(true);
      await expectListing(fixture.namespaceDir, [...before, created.location!.key], true);
      await expectRun("ok");
      await expectListing(fixture.scratchRoot, []);
    });
  });

  it("stops retention deletion after namespace takeover", async () => {
    await withNamespaceRace(async (fixture) => {
      const expired = [
        "20260101T000000Z-11111111.tar.gz",
        "20260102T000000Z-22222222.tar.gz",
        "20260103T000000Z-33333333.tar.gz",
      ];
      for (const key of expired) {
        await fs.writeFile(path.join(fixture.namespaceDir, key), Buffer.alloc(200));
      }
      const deleted: string[] = [];
      fixture.intercept((backend) => {
        const remove = backend.deleteObject;
        backend.deleteObject = async (key, opts) => {
          await remove(key, opts);
          if (key.endsWith(".tar.gz")) {
            deleted.push(path.basename(key));
            if (deleted.length === 1) {
              await fixture.takeOver();
            }
          }
        };
      });
      await expect(
        fixture.create("test-host", "--only-config", "--keep-daily", "0"),
      ).rejects.toThrow("CLI exit 1");
      expect(deleted).toHaveLength(1);
      await expectListing(
        fixture.namespaceDir,
        expired.filter((key) => !deleted.includes(key)),
        true,
      );
      await expectRun("failed", {
        namespace: "test-host",
        error: expect.stringContaining("belongs to another OpenClaw installation"),
      });
      await expectListing(fixture.scratchRoot, []);
    });
  });

  it("refuses uninitialized storage, then uploads, lists, verifies and stages an encrypted archive", async () => {
    await withOpenClawTestState({ layout: "state-only" }, async (state) => {
      const destination = state.path("offsite");
      const scratchRoot = state.path("scratch");
      await fs.mkdir(scratchRoot);
      vi.spyOn(os, "tmpdir").mockReturnValue(scratchRoot);
      vi.spyOn(os, "hostname").mockReturnValue("default-host");
      await state.writeConfig({
        agents: { entries: { main: { workspace: state.workspaceDir } } },
        ...archiveConfig(destination),
      });
      await fs.writeFile(state.statePath("operator-note.txt"), "preserved state\n");
      await fs.writeFile(
        path.join(state.workspaceDir, "workspace-note.txt"),
        "excluded workspace\n",
      );
      const { run, create, from, reject } = createCliHarness();
      openOpenClawStateDatabase();
      await closeOpenClawStateDatabaseAsync();
      expect((await fs.stat(resolveOpenClawStateSqlitePath())).isFile()).toBe(true);
      const localCopy = state.path("retained.tar.gz");
      const unavailableMessage =
        "Storage directory is unavailable. Reconnect the disk and check the configured path; storage init requires an existing directory.";
      const createLocal = () => run("backup", "create", "--to", "archive", "--output", localCopy);
      await reject(createLocal(), unavailableMessage, {
        kind: "archive",
        namespace: "default-host",
      });
      await fs.mkdir(destination);
      await reject(createLocal(), "openclaw storage init archive", {
        kind: "archive",
        error: expect.stringContaining("storage init archive"),
      });
      await expectAbsent(localCopy);
      await expectListing(scratchRoot, []);

      await run("storage", "init", "archive");
      const namespaceDir = path.join(destination, "backups", "test-host");
      const otherDir = path.join(destination, "backups", "test-host-other");
      await fs.mkdir(namespaceDir, { recursive: true });
      await fs.mkdir(otherDir, { recursive: true });
      const oldKey = "20260101T000000Z-11111111.tar.gz";
      await fs.writeFile(path.join(namespaceDir, oldKey), Buffer.alloc(200));
      await fs.writeFile(path.join(namespaceDir, "foreign.txt"), "foreign");
      await fs.writeFile(path.join(otherDir, oldKey), Buffer.alloc(200));
      const location = await openStorageLocation({ name: "archive", config: getRuntimeConfig() });
      const scoped = location.scope("backups/test-host");
      const foreignClaim = {
        version: 1,
        deviceId: "another-installation-device-id",
        hostname: "test-host",
        claimedAt: 1,
      };
      const writeClaim = async (claim: typeof foreignClaim) => {
        const bytes = Buffer.from(JSON.stringify(claim));
        await scoped.putObject(
          "owner.json",
          (async function* () {
            yield bytes;
          })(),
          { sizeBytes: bytes.length },
        );
      };
      await writeClaim(foreignClaim);
      const collisionMessage =
        'Backup namespace "test-host" in archive belongs to another OpenClaw installation (test-host, device another-inst). Pass --namespace <name> to use a separate namespace, or --claim-namespace to take it over deliberately (for example after moving to new hardware).';
      await reject(
        create("test-host", "--output", localCopy, "--keep-daily", "0"),
        collisionMessage,
        { namespace: "test-host" },
      );
      await expectAbsent(localCopy);
      await expectListing(scratchRoot, []);
      expect(await fs.readdir(namespaceDir)).toContain(oldKey);
      const created = await create(
        "test-host",
        "--claim-namespace",
        "--no-include-workspace",
        "--keep-daily",
        "0",
      );
      expect(created).toMatchObject({
        verified: true,
        localArchiveRetained: false,
        retention: { kept: 1, deleted: 1 },
      });
      expect(created.location?.storedBytes).toBeGreaterThan(created.location!.plaintextBytes);
      await expectListing(scratchRoot, []);
      await expectListing(namespaceDir, ["foreign.txt", created.location!.key], true);
      await expectAbsent(path.join(namespaceDir, oldKey));
      await expectListing(otherDir, [oldKey]);
      for (const key of [created.location!.key, "owner.json"]) {
        expect((await fs.readFile(path.join(namespaceDir, key))).subarray(0, 8).toString()).toBe(
          "OCSTOR1\n",
        );
      }
      expect(await json((await scoped.getObject("owner.json"))!)).toMatchObject({
        version: 1,
        deviceId: (await loadDeviceIdentityIfPresentAsync())!.deviceId,
        hostname: os.hostname(),
        claimedAt: expect.any(Number),
      });
      // Recovery must work without this installation owning the namespace.
      await scoped.delete("owner.json");
      await writeClaim(foreignClaim);
      await location.close();
      await fs.writeFile(path.join(otherDir, "owner.json"), "x");
      expect(await run("backup", "list", "--from", "archive")).toMatchObject({
        namespaces: expect.arrayContaining([
          { namespace: "test-host", hostname: "test-host" },
          { namespace: "test-host-other" },
        ]),
      });
      expect(await from("list", "test-host")).toMatchObject({
        backups: [{ key: created.location!.key, sizeBytes: created.location!.plaintextBytes }],
      });
      expect(await from("verify", "test-host", "latest")).toMatchObject({ ok: true });
      const target = state.path("staged");
      await from("restore", "test-host", "latest", "--target", target);
      const capturedState = created.assets.find((asset) => asset.kind === "state");
      expect(capturedState).toBeDefined();
      const restoredState = path.join(target, capturedState!.archivePath);
      await expectFile(path.join(restoredState, "operator-note.txt"), "preserved state\n");
      await expectFile(
        path.join(restoredState, "openclaw.json"),
        await fs.readFile(state.configPath, "utf8"),
      );
      expect(created.assets.some((asset) => asset.kind === "workspace")).toBe(false);
      await expect(from("restore", "test-host", "latest", "--target", target)).rejects.toThrow();
      const configOnly = await create("config", "--only-config", "--output", localCopy);
      expect(configOnly).toMatchObject({
        onlyConfig: true,
        verified: true,
        localArchiveRetained: true,
        assets: [{ kind: "config" }],
      });
      expect((await fs.stat(localCopy)).size).toBe(configOnly.location?.plaintextBytes);
      await fs.writeFile(path.join(destination, "backups", "config", "owner.json"), "x");
      expect(await create("config", "--claim-namespace", "--only-config")).toMatchObject({
        verified: true,
      });
      const reopened = await openStorageLocation({ name: "archive", config: getRuntimeConfig() });
      try {
        expect(
          await json((await reopened.scope("backups/config").getObject("owner.json"))!),
        ).toMatchObject({ deviceId: (await loadDeviceIdentityIfPresentAsync())!.deviceId });
      } finally {
        await reopened.close();
      }
    });
  });

  it("creates nested-TMPDIR backups, reclaims abandoned scratch, preserves active scratch and reports strays", async () => {
    await withOpenClawTestState({ layout: "state-only" }, async (state) => {
      const nestedTmp = state.statePath("tmp");
      vi.spyOn(os, "hostname").mockReturnValue("nested-tmp-host");
      const { destination, create } = await prepareStorage(state, nestedTmp);
      await fs.writeFile(state.statePath("operator-note.txt"), "preserved state\n");
      // Nested TMPDIR uses the state parent, outside Doctor's scanned roots.
      const fallbackRoot = path.dirname(state.stateDir);

      // A hard-killed earlier upload leaves its plaintext scratch archive behind
      // with no live lifetime token; a concurrent run still holds its token.
      const abandoned = await createBackupScratchDirectory(fallbackRoot);
      const active = await createBackupScratchDirectory(fallbackRoot);
      const stray = path.join(fallbackRoot, "openclaw-backup-strayf");
      await fs.writeFile(stray, "not a scratch directory");
      for (const scratch of [abandoned, active]) {
        await fs.writeFile(path.join(scratch.directory, "archive.tar.gz"), "synthetic archive");
      }
      abandoned.release();
      try {
        const created = await create("nested-tmp-host", "--no-include-workspace");
        expect(created).toMatchObject({
          verified: true,
          localArchiveRetained: false,
          warnings: expect.arrayContaining([expect.stringContaining(`${stray}: not a directory`)]),
          location: {
            name: "archive",
            namespace: "nested-tmp-host",
            key: expect.stringMatching(/\.tar\.gz$/),
          },
          archivePath: expect.stringMatching(
            /^storage:\/\/archive\/backups\/nested-tmp-host\/.+\.tar\.gz$/,
          ),
        });
        await expectListing(
          path.join(destination, "backups", "nested-tmp-host"),
          [created.location!.key, "owner.json"],
          true,
        );
        await expectAbsent(abandoned.directory);
        await expectFile(path.join(active.directory, "archive.tar.gz"), "synthetic archive");
        await expectFile(stray, "not a scratch directory");
        expect((await scratchDirectories(fallbackRoot)).toSorted()).toEqual(
          [path.basename(active.directory), path.basename(stray)].toSorted(),
        );
        expect(await scratchDirectories(nestedTmp)).toEqual([]);
      } finally {
        await expect(finishBackupScratch(active, () => {})).resolves.toBeUndefined();
        await fs.rm(stray, { force: true });
      }
      expect(await scratchDirectories(fallbackRoot)).toEqual([]);
    });
  });
});
