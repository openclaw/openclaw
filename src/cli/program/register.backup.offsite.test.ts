import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { json } from "node:stream/consumers";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { claimBackupNamespace } from "../../commands/backup-namespace.js";
import type { OffsiteBackupResult } from "../../commands/backup-remote.js";
import { getRuntimeConfig } from "../../config/config.js";
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
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { registerBackupCommand } from "./register.backup.js";
import { registerStorageCommand } from "./register.storage.js";

afterEach(() => vi.restoreAllMocks());

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
  return { run, errors };
}

describe("offsite backup CLI", () => {
  async function withNamespaceRace(
    exercise: (fixture: {
      run: ReturnType<typeof createCliHarness>["run"];
      errors: ReturnType<typeof createCliHarness>["errors"];
      namespaceDir: string;
      scratchRoot: string;
      takeOver: () => Promise<void>;
      useNewOwner: () => void;
      intercept: (configure: (backend: StorageBackend) => void) => void;
    }) => Promise<void>,
  ) {
    await withOpenClawTestState({ layout: "state-only" }, async (state) => {
      const destination = state.path("offsite");
      const scratchRoot = state.path("scratch");
      await fs.mkdir(destination);
      await fs.mkdir(scratchRoot);
      vi.spyOn(os, "tmpdir").mockReturnValue(scratchRoot);
      await state.writeConfig({
        storage: {
          locations: {
            archive: {
              provider: "filesystem",
              settings: { path: destination },
              encryption: { passphrase: "synthetic-backup-test-passphrase" },
            },
          },
        },
      });
      const { run, errors } = createCliHarness();
      await run("storage", "init", "archive");
      const identity = await deviceIdentity.loadOrCreateProcessDeviceIdentityAsync();
      const nextIdentity = { ...identity, deviceId: "replacement-installation-device-id" };
      const location = await openStorageLocation({ name: "archive", config: getRuntimeConfig() });
      const scoped = location.scope("backups/test-host");
      try {
        await claimBackupNamespace(scoped, "test-host", identity.deviceId, false);
        const open = filesystemStorageProvider.open;
        await exercise({
          run,
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
      const create = () =>
        fixture.run(
          "backup",
          "create",
          "--to",
          "archive",
          "--namespace",
          "test-host",
          "--only-config",
        );
      await expect(create()).rejects.toThrow("CLI exit 1");
      expect(displaced).toBe(true);
      expect(await fs.readdir(fixture.namespaceDir)).toEqual(before);
      expect(await fs.readdir(fixture.scratchRoot)).toEqual([]);
      expect((await readBackupRuns(process.env))[0]).toMatchObject({
        status: "failed",
        target: "archive",
        namespace: "test-host",
        error: expect.stringContaining("belongs to another OpenClaw installation"),
      });
      expect(fixture.errors.mock.calls.flat().join(" ")).toContain(
        "belongs to another OpenClaw installation",
      );
      fixture.useNewOwner();
      const created = (await create()) as OffsiteBackupResult;
      expect(created.verified).toBe(true);
      expect(await fs.readdir(fixture.namespaceDir)).toEqual(
        expect.arrayContaining([...before, created.location!.key]),
      );
      expect((await readBackupRuns(process.env))[0]).toMatchObject({ status: "ok" });
      expect(await fs.readdir(fixture.scratchRoot)).toEqual([]);
    });
  });

  it("stops retention when namespace takeover follows the first delete's ownership check", async () => {
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
      let nextMarker = false;
      let displaced = false;
      fixture.intercept((backend) => {
        const get = backend.getObject;
        const remove = backend.deleteObject;
        backend.getObject = async (key, opts) => {
          if (key === "openclaw-storage.json" && nextMarker) {
            nextMarker = false;
            displaced = true;
            await fixture.takeOver();
          }
          const body = await get(key, opts);
          if (key.endsWith("/owner.json") && deleted.length === 1 && !displaced) {
            // Let the early claim read finish, then take over during the delete's marker check.
            nextMarker = true;
          }
          return body;
        };
        backend.deleteObject = async (key, opts) => {
          await remove(key, opts);
          if (key.endsWith(".tar.gz")) {
            deleted.push(path.basename(key));
          }
        };
      });
      await expect(
        fixture.run(
          "backup",
          "create",
          "--to",
          "archive",
          "--namespace",
          "test-host",
          "--only-config",
          "--keep-daily",
          "0",
        ),
      ).rejects.toThrow("CLI exit 1");
      expect(displaced).toBe(true);
      expect(deleted).toHaveLength(1);
      expect(await fs.readdir(fixture.namespaceDir)).toEqual(
        expect.arrayContaining(expired.filter((key) => !deleted.includes(key))),
      );
      expect((await readBackupRuns(process.env))[0]).toMatchObject({
        status: "failed",
        namespace: "test-host",
        error: expect.stringContaining("belongs to another OpenClaw installation"),
      });
      expect(await fs.readdir(fixture.scratchRoot)).toEqual([]);
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
        storage: {
          locations: {
            archive: {
              provider: "filesystem",
              settings: { path: destination },
              encryption: { passphrase: "synthetic-backup-test-passphrase" },
            },
          },
        },
      });
      await fs.writeFile(state.statePath("operator-note.txt"), "preserved state\n");
      await fs.writeFile(
        path.join(state.workspaceDir, "workspace-note.txt"),
        "excluded workspace\n",
      );
      const { run, errors } = createCliHarness();
      openOpenClawStateDatabase();
      await closeOpenClawStateDatabaseAsync();
      expect((await fs.stat(resolveOpenClawStateSqlitePath())).isFile()).toBe(true);
      const localCopy = state.path("retained.tar.gz");
      await expect(
        run("backup", "create", "--to", "archive", "--output", localCopy),
      ).rejects.toThrow();
      const unavailableMessage =
        "Storage directory is unavailable. Reconnect the disk and check the configured path; storage init requires an existing directory.";
      expect(errors.mock.calls.flat().join(" ")).toContain(unavailableMessage);
      expect((await readBackupRuns(process.env))[0]).toMatchObject({
        kind: "archive",
        target: "archive",
        namespace: "default-host",
        status: "failed",
        error: unavailableMessage,
      });
      errors.mockClear();
      await fs.mkdir(destination);
      await expect(
        run("backup", "create", "--to", "archive", "--output", localCopy),
      ).rejects.toThrow();
      expect(errors.mock.calls.flat().join(" ")).toContain("openclaw storage init archive");
      await expect(fs.stat(localCopy)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await fs.readdir(scratchRoot)).toEqual([]);
      expect(
        (await readBackupRuns(process.env))[0],
        errors.mock.calls.flat().join("\n"),
      ).toMatchObject({
        kind: "archive",
        target: "archive",
        status: "failed",
        error: expect.stringContaining("storage init archive"),
      });

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
          {
            sizeBytes: bytes.length,
          },
        );
      };
      await writeClaim(foreignClaim);
      errors.mockClear();
      await expect(
        run(
          "backup",
          "create",
          "--to",
          "archive",
          "--namespace",
          "test-host",
          "--output",
          localCopy,
          "--keep-daily",
          "0",
        ),
      ).rejects.toThrow();
      const collisionMessage =
        'Backup namespace "test-host" in archive belongs to another OpenClaw installation (test-host, device another-inst). Pass --namespace <name> to use a separate namespace, or --claim-namespace to take it over deliberately (for example after moving to new hardware).';
      expect(errors.mock.calls.flat().join(" ")).toContain(collisionMessage);
      expect((await readBackupRuns(process.env))[0]).toMatchObject({
        status: "failed",
        target: "archive",
        namespace: "test-host",
        error: collisionMessage,
      });
      await expect(fs.stat(localCopy)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await fs.readdir(scratchRoot)).toEqual([]);
      expect(await fs.readdir(namespaceDir)).toContain(oldKey);
      const created = (await run(
        "backup",
        "create",
        "--to",
        "archive",
        "--namespace",
        "test-host",
        "--claim-namespace",
        "--no-include-workspace",
        "--keep-daily",
        "0",
      )) as OffsiteBackupResult;
      expect(created).toMatchObject({
        verified: true,
        localArchiveRetained: false,
        retention: { kept: 1, deleted: 1 },
      });
      expect(created.location?.storedBytes).toBeGreaterThan(created.location!.plaintextBytes);
      expect(await fs.readdir(scratchRoot)).toEqual([]);
      expect(await fs.readdir(namespaceDir)).toEqual(
        expect.arrayContaining(["foreign.txt", created.location!.key]),
      );
      await expect(fs.stat(path.join(namespaceDir, oldKey))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await fs.readdir(otherDir)).toEqual([oldKey]);
      const stored = await fs.readFile(path.join(namespaceDir, created.location!.key));
      expect(stored.subarray(0, 8).toString()).toBe("OCSTOR1\n");
      expect(
        (await fs.readFile(path.join(namespaceDir, "owner.json"))).subarray(0, 8).toString(),
      ).toBe("OCSTOR1\n");
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
      const listed = await run("backup", "list", "--from", "archive", "--namespace", "test-host");
      expect(listed).toMatchObject({
        backups: [{ key: created.location!.key, sizeBytes: created.location!.plaintextBytes }],
      });
      const verified = await run(
        "backup",
        "verify",
        "latest",
        "--from",
        "archive",
        "--namespace",
        "test-host",
      );
      expect(verified).toMatchObject({ ok: true });
      const target = state.path("staged");
      await run(
        "backup",
        "restore",
        "latest",
        "--from",
        "archive",
        "--namespace",
        "test-host",
        "--target",
        target,
      );
      const capturedState = created.assets.find((asset) => asset.kind === "state");
      expect(capturedState).toBeDefined();
      const restoredState = path.join(target, capturedState!.archivePath);
      expect(await fs.readFile(path.join(restoredState, "operator-note.txt"), "utf8")).toBe(
        "preserved state\n",
      );
      expect(await fs.readFile(path.join(restoredState, "openclaw.json"), "utf8")).toBe(
        await fs.readFile(state.configPath, "utf8"),
      );
      expect(created.assets.some((asset) => asset.kind === "workspace")).toBe(false);
      await expect(
        run(
          "backup",
          "restore",
          "latest",
          "--from",
          "archive",
          "--namespace",
          "test-host",
          "--target",
          target,
        ),
      ).rejects.toThrow();
      const configOnly = (await run(
        "backup",
        "create",
        "--to",
        "archive",
        "--namespace",
        "config",
        "--only-config",
        "--output",
        localCopy,
      )) as OffsiteBackupResult;
      expect(configOnly).toMatchObject({
        onlyConfig: true,
        verified: true,
        localArchiveRetained: true,
        assets: [{ kind: "config" }],
      });
      expect((await fs.stat(localCopy)).size).toBe(configOnly.location?.plaintextBytes);
      await fs.writeFile(path.join(destination, "backups", "config", "owner.json"), "x");
      expect(
        await run(
          "backup",
          "create",
          "--to",
          "archive",
          "--namespace",
          "config",
          "--claim-namespace",
          "--only-config",
        ),
      ).toMatchObject({ verified: true });
      const reopened = await openStorageLocation({ name: "archive", config: getRuntimeConfig() });
      try {
        expect(
          await json((await reopened.scope("backups/config").getObject("owner.json"))!),
        ).toMatchObject({
          deviceId: (await loadDeviceIdentityIfPresentAsync())!.deviceId,
        });
      } finally {
        await reopened.close();
      }
    });
  });
});
