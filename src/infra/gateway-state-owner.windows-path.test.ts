import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withTempDir } from "../test-utils/temp-dir.js";
import { resolveStateOwnerIdentity } from "./gateway-state-owner-directory.js";
import {
  acquireGatewayStateOwner,
  acquireStateDatabaseSchemaLease,
  assertStateDatabaseAccessAllowed,
  assertStateDatabaseReadAllowed,
  getStateDatabaseSchemaLease,
  hasActiveGatewayStateOwner,
  resolveGatewayStateOwnerPath,
  tryAcquireGatewayStateOwner,
  tryBorrowGatewayStateOwner,
} from "./gateway-state-owner.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", platform);
});

it.each(["process", "schema"] as const)(
  "preserves Windows %s ownership when native database spelling changes after creation",
  (kind) => {
    const root = tempDirs.make("openclaw-owner-windows-");
    const databasePath = path.join(root, "state", "openclaw.sqlite");
    Object.defineProperty(process, "platform", { value: "win32" });
    vi.spyOn(os, "homedir").mockReturnValue(root);
    const native = fs.realpathSync.native;
    let created = false;
    vi.spyOn(fs.realpathSync, "native").mockImplementation((input, options) => {
      if (created && String(input).toLowerCase() === databasePath.toLowerCase()) {
        return databasePath.toUpperCase();
      }
      return native(input, options);
    });
    const owner =
      kind === "schema"
        ? acquireStateDatabaseSchemaLease(databasePath)
        : acquireGatewayStateOwner({
            databasePath,
            projectionPath: path.join(root, "gateway.state.lock"),
          });
    const persisted = fs.readFileSync(owner.path, "utf8");
    try {
      fs.mkdirSync(path.dirname(databasePath), { recursive: true });
      fs.writeFileSync(databasePath, "");
      created = true;
      // Persisted lock names retain their historical, case-preserving hash.
      expect(resolveGatewayStateOwnerPath(databasePath)).not.toBe(owner.path);
      const competing = tryAcquireGatewayStateOwner(databasePath);
      try {
        expect(competing).toBeNull();
      } finally {
        competing?.release();
      }
      expect(getStateDatabaseSchemaLease(databasePath)).toBeUndefined();
      expect(() => assertStateDatabaseAccessAllowed(databasePath)).toThrow("offline maintenance");
      owner.run(() => {
        expect(getStateDatabaseSchemaLease(databasePath)).toBeDefined();
        expect(() => owner.assertDatabaseAccess(databasePath)).not.toThrow();
        expect(() => assertStateDatabaseAccessAllowed(databasePath)).not.toThrow();
        expect(() => assertStateDatabaseReadAllowed(databasePath)).not.toThrow();
        expect(() => owner.assertDatabaseAccess(path.join(root, "other.sqlite"))).toThrow(
          "does not own this database",
        );
        const retained = acquireStateDatabaseSchemaLease(databasePath);
        try {
          expect(retained.path).toBe(owner.path);
          expect(() => retained.assertDatabaseAccess(databasePath)).not.toThrow();
          expect(hasActiveGatewayStateOwner(databasePath)).toBe(false);
          const borrowed = tryBorrowGatewayStateOwner(databasePath);
          expect(Boolean(borrowed)).toBe(kind === "process");
          borrowed?.release();
        } finally {
          retained.release();
        }
      });
      expect(getStateDatabaseSchemaLease(databasePath)).toBeUndefined();
      expect(() => assertStateDatabaseReadAllowed(databasePath)).toThrow("offline maintenance");
      expect(fs.readFileSync(owner.path, "utf8")).toBe(persisted);
    } finally {
      owner.release();
    }
    expect(fs.existsSync(owner.path)).toBe(false);
  },
);

it("initializes fresh state when native realpath changes the owner directory spelling", async () => {
  await withTempDir("openclaw-owner-path-", async (root) => {
    const databasePath = path.join(root, "state", "openclaw.sqlite");
    const lease = acquireStateDatabaseSchemaLease(databasePath);
    const directory = path.dirname(lease.path);
    const alias = path.join(root, "owner-alias");
    fs.symlinkSync(directory, alias, process.platform === "win32" ? "junction" : "dir");
    const native = fs.realpathSync.native;
    const realpath = vi
      .spyOn(fs.realpathSync, "native")
      .mockImplementation((input, options) =>
        String(input) === directory ? alias : native(input, options),
      );
    try {
      lease.run(() => {
        assertStateDatabaseAccessAllowed(databasePath);
        const database = openOpenClawStateDatabase({ path: databasePath });
        expect(
          database.db.prepare("SELECT role FROM schema_meta WHERE meta_key = 'primary'").get(),
        ).toEqual({ role: "global" });
        closeOpenClawStateDatabaseForTest();
      });
    } finally {
      realpath.mockRestore();
      lease.run(() => closeOpenClawStateDatabaseForTest());
      lease.release();
      fs.unlinkSync(alias);
    }
  });
});

it.each([
  "c:\\users\\tester\\.openclaw\\state\\openclaw.sqlite",
  "C:/Users/Tester/.openclaw/state/openclaw.sqlite",
  "\\\\?\\C:\\Users\\Tester\\.openclaw\\state\\openclaw.sqlite",
  "C:\\Users\\TESTER~1\\.openclaw\\state\\openclaw.sqlite",
])("keeps one Windows schema owner across first creation and alias %s", (alias) => {
  Object.defineProperty(process, "platform", { value: "win32" });
  for (const name of ["resolve", "dirname", "basename", "join"] as const) {
    const windows = path.win32[name];
    vi.spyOn(path, name).mockImplementation(windows);
  }
  let created = false;
  vi.spyOn(fs.realpathSync, "native").mockImplementation((input) => {
    const candidate = path.win32
      .normalize(String(input))
      .replace(/^\\\\\?\\/u, "")
      .replace(/TESTER~1/iu, "Tester")
      .toLowerCase();
    if (candidate === "c:\\users\\tester") {
      return "C:\\Users\\Tester";
    }
    if (created && candidate.startsWith("c:\\users\\tester\\")) {
      // Native realpath can expose different casing and a namespace after mkdir/open.
      return `\\\\?\\${candidate}`;
    }
    throw Object.assign(new Error("not created yet"), { code: "ENOENT" });
  });

  const registered = resolveStateOwnerIdentity(
    "C:\\Users\\Tester\\.openclaw\\state\\openclaw.sqlite",
  ).key;
  created = true;
  expect(resolveStateOwnerIdentity(alias).key).toBe(registered);
  expect(
    resolveStateOwnerIdentity("C:\\Users\\Tester\\.openclaw-fresh\\state\\openclaw.sqlite").key,
  ).not.toBe(registered);
});
