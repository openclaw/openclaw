import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as tempRoot from "../../infra/tmp-openclaw-dir.js";
import {
  captureManagedUpdateLeaseDatabaseIdentity,
  createManagedHandoffLeaseDatabase,
} from "../../infra/update-managed-service-handoff-database.js";
import { createManagedHandoffLeaseStore } from "../../infra/update-managed-service-handoff-lease.js";
import * as legacyStore from "../../infra/update-managed-service-handoff-legacy-store.js";
import {
  captureUpdateCommandExecutorAuthority,
  withUpdateCommandExecutor,
} from "./update-command-executor.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it
  .skipIf(process.platform === "win32")
  .each([
    "legacy ancestor",
    "current ancestor",
    "current ordinary alias",
    "same spelling",
    "distinct stores",
  ])("standalone admission preserves custody with %s", async (spelling) => {
  const root = fs.realpathSync(dirs.make("standalone-lease-path-"));
  const directory = path.join(root, "control");
  fs.mkdirSync(directory, { mode: 0o700 });
  const alias = path.join(root, "alias");
  fs.symlinkSync(root, alias, "dir");
  const databasePath = path.join(directory, "managed-update-handoffs.sqlite");
  const aliasedDirectory = path.join(alias, "control");
  vi.spyOn(tempRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(
    spelling.startsWith("current ") ? aliasedDirectory : directory,
  );
  if (spelling === "current ordinary alias") {
    const ordinaryRealpath = fs.realpathSync;
    const aliasPath = path.join(aliasedDirectory, path.basename(databasePath));
    // Windows ordinary resolution can retain an 8.3 spelling; Root expands it.
    vi.spyOn(fs, "realpathSync").mockImplementation((...args) => {
      const resolved = ordinaryRealpath(...args);
      return args[0] === aliasPath && typeof resolved === "string" ? aliasPath : resolved;
    });
    fs.realpathSync.native = ordinaryRealpath.native;
  }
  const legacyDatabasePath =
    spelling === "legacy ancestor"
      ? path.join(aliasedDirectory, path.basename(databasePath))
      : spelling === "distinct stores"
        ? path.join(root, "earlier", path.basename(databasePath))
        : databasePath;
  vi.spyOn(legacyStore, "resolveLegacyGatewayManagedUpdateLeaseDatabasePath").mockReturnValue(
    legacyDatabasePath,
  );
  const earlier = createManagedHandoffLeaseStore({
    databasePath: legacyDatabasePath,
    serviceManagerEnv: process.env,
  });
  createManagedHandoffLeaseDatabase(legacyDatabasePath)(true, () => undefined);
  const held = earlier.acquire(root, "unrelated-live-owner", { kind: "update" });
  expect(held.kind).toBe("acquired");
  if (held.kind !== "acquired") {
    throw new Error("Missing live-owner control");
  }
  const files = [databasePath, legacyDatabasePath];
  const snapshot = () => files.map((file) => (fs.existsSync(file) ? fs.readFileSync(file) : null));
  const originals = snapshot();
  try {
    await expect(
      withUpdateCommandExecutor(randomUUID(), (executor) => executor.enter(root)),
    ).rejects.toThrow("Another update executor owns this installation");
    expect(snapshot()).toEqual(originals);
    expect(earlier.current(held.lease)).toBe(true);
  } finally {
    expect(earlier.release(held.lease)).toBe(true);
  }

  createManagedHandoffLeaseDatabase(databasePath)(true, () => undefined);
  const identity = captureManagedUpdateLeaseDatabaseIdentity(databasePath);
  const store = createManagedHandoffLeaseStore({ databasePath, serviceManagerEnv: process.env });
  const fence = await withUpdateCommandExecutor(randomUUID(), async (executor) => {
    const admitted = await executor.enter(root);
    admitted.assertCurrent();
    expect(captureUpdateCommandExecutorAuthority(admitted)).toMatchObject(identity);
    expect(store.acquire(root, "unrelated-owner", { kind: "update" }).kind).toBe("busy");
    return admitted;
  });
  expect(fence.assertCurrent).toThrow("no longer current");
  expect(captureManagedUpdateLeaseDatabaseIdentity(databasePath)).toEqual(identity);
  expect(fs.existsSync(databasePath + ".lock")).toBe(false);
  expect([store.read(root), earlier.read(root)]).toEqual([{ kind: "absent" }, { kind: "absent" }]);
});

it.skipIf(process.platform === "win32").each(["hardlink", "replacement"])(
  "refuses a shared store %s after legacy discovery without changing either original",
  async (change) => {
    const root = fs.realpathSync(dirs.make("standalone-lease-replaced-"));
    const directory = path.join(root, "control");
    fs.mkdirSync(directory, { mode: 0o700 });
    const alias = path.join(root, "alias");
    fs.symlinkSync(root, alias, "dir");
    const databasePath = path.join(directory, "managed-update-handoffs.sqlite");
    vi.spyOn(tempRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(directory);
    vi.spyOn(legacyStore, "resolveLegacyGatewayManagedUpdateLeaseDatabasePath").mockReturnValue(
      path.join(alias, "control", path.basename(databasePath)),
    );
    createManagedHandoffLeaseDatabase(databasePath)(true, () => undefined);
    const original = fs.readFileSync(databasePath);
    const retained = path.join(root, "retained.sqlite");
    const fenceLegacy = legacyStore.fenceLegacyGatewayCustody;
    vi.spyOn(legacyStore, "fenceLegacyGatewayCustody").mockImplementation(async (...args) => {
      const fence = await fenceLegacy(...args);
      if (change === "hardlink") {
        fs.linkSync(databasePath, retained);
      } else {
        fs.renameSync(databasePath, retained);
        fs.writeFileSync(databasePath, original, { mode: 0o600 });
      }
      return fence;
    });
    await expect(
      withUpdateCommandExecutor(randomUUID(), (executor) => executor.enter(root)),
    ).rejects.toThrow(change === "hardlink" ? "file is unsafe" : "file identity");
    expect([databasePath, retained].map((file) => fs.readFileSync(file))).toEqual([
      original,
      original,
    ]);
    expect(fs.readdirSync(directory)).toEqual([path.basename(databasePath)]);
  },
);

it.skipIf(process.platform === "win32")(
  "admits a legacy parent through an aliased lease path without changing its row",
  async () => {
    const root = fs.realpathSync(dirs.make("legacy-lease-path-"));
    const temporary = path.join(root, "private-tmp");
    fs.mkdirSync(temporary, { mode: 0o700 });
    const location = vi
      .spyOn(tempRoot, "resolvePreferredOpenClawTmpDir")
      .mockReturnValue(temporary);
    const parent = createManagedHandoffLeaseStore().processIdentity(process.ppid);
    const databasePath = path.join(temporary, "managed-update-handoffs.sqlite");
    const original = {
      install_root: root,
      owner: randomUUID(),
      payload_json: JSON.stringify({ version: 1, ...parent }),
      updated_at: 7,
      recovery_json: null,
    };
    createManagedHandoffLeaseDatabase(databasePath)(true, (db) => {
      db.prepare(
        "INSERT INTO managed_update_handoffs (install_root, owner, payload_json, updated_at) VALUES (?, ?, ?, ?)",
      ).run(original.install_root, original.owner, original.payload_json, original.updated_at);
    });
    const identity = captureManagedUpdateLeaseDatabaseIdentity(databasePath);
    const alias = path.join(dirs.make("legacy-lease-alias-"), "root");
    fs.symlinkSync(root, alias, "dir");
    location.mockReturnValue(path.join(alias, "private-tmp"));
    const readRows = () => {
      const db = new DatabaseSync(databasePath, { readOnly: true });
      try {
        return db.prepare("SELECT * FROM managed_update_handoffs ORDER BY install_root").all();
      } finally {
        db.close();
      }
    };
    const fence = await withUpdateCommandExecutor(
      randomUUID(),
      async (executor) => {
        const admitted = await executor.enter(root);
        admitted.assertCurrent();
        expect(captureUpdateCommandExecutorAuthority(admitted)).toMatchObject(identity);
        expect(readRows()).toEqual([
          original,
          expect.objectContaining({
            install_root: expect.stringContaining(`${root}/.openclaw-update-child-`),
          }),
        ]);
        return admitted;
      },
      { legacyPackageParent: parent, legacyPackageHandoff: { handoffId: original.owner, root } },
    );
    expect(readRows()).toEqual([original]);
    expect(fence.assertCurrent).toThrow("no longer current");
  },
);
