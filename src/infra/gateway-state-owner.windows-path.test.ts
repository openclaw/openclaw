import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withTempDir } from "../test-utils/temp-dir.js";
import { resolveStateOwnerIdentity } from "./gateway-state-owner-directory.js";
import {
  acquireStateDatabaseSchemaLease,
  assertStateDatabaseAccessAllowed,
} from "./gateway-state-owner.js";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(process, "platform", platform);
});

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
