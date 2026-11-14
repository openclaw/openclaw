import fs, { renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import {
  readDatabasePathIdentity,
  readDatabasePathIdentitySync as readIdentity,
  assertExistingDatabaseIdentity as assertExisting,
} from "./sqlite-worker-identity.js";

vi.hoisted(() => vi.resetModules());
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, realpath: vi.fn(original.realpath) };
});

const dirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(fsPromises.realpath).mockRestore();
    syncBuiltinESMExports();
    vi.resetModules();
    cleanup();
  }),
);

function replaceFile(pathname: string) {
  const replacement = `${pathname}.replacement`;
  writeFileSync(replacement, "replacement");
  renameSync(replacement, pathname);
}

it("shares prospective and existing file identities between sync capture and async admission", async () => {
  const pathname = path.join(dirs.make("openclaw-worker-identity-"), "state.sqlite");
  const nativePath = path.toNamespacedPath(pathname);
  const prospective = readIdentity(nativePath);
  expect(prospective.key).toBe(`path:${prospective.canonicalPath}`);
  expect(await readDatabasePathIdentity(pathname)).toEqual(prospective);
  writeFileSync(pathname, "");
  const existing = readIdentity(nativePath);
  expect(await readDatabasePathIdentity(pathname)).toEqual(existing);
  const birthtime =
    process.platform === "linux" || process.platform === "android"
      ? "0"
      : statSync(pathname, { bigint: true }).birthtimeNs.toString();
  expect(existing).toMatchObject({
    key: expect.stringMatching(/^file:/),
    canonicalPath: prospective.canonicalPath,
    birthtime,
  });
  expect(() => assertExisting(pathname, existing.key, birthtime)).not.toThrow();
  expect(() => assertExisting(pathname, existing.key, (BigInt(birthtime) + 1n).toString())).toThrow(
    /identity changed/,
  );
  replaceFile(pathname);
  expect(readIdentity(pathname).key).not.toBe(existing.key);
  expect(() => assertExisting(pathname, existing.key, birthtime)).toThrow(/identity changed/);
});

it.each(["linux", "android"] as const)(
  "keeps the %s database identity when Node reports ctime as birthtime",
  async (platform) => {
    const pathname = path.join(dirs.make("openclaw-worker-identity-ctime-"), "state.sqlite");
    writeFileSync(pathname, "");
    const paths = new Set([pathname, fs.realpathSync.native(pathname)]);
    const stat = fs.statSync;
    let ctimeAdvanceNs = 0n;
    mockProcessPlatform(platform);
    // libuv fills birthtime from ctime when statx is unavailable, as on Termux.
    vi.spyOn(fs, "statSync").mockImplementation((...args) => {
      const result = stat(...args);
      const file = args[0];
      if (result && typeof file === "string" && paths.has(file) && "ctimeNs" in result) {
        const ctimeNs = result.ctimeNs + ctimeAdvanceNs;
        Object.assign(result, { ctimeNs, birthtimeNs: ctimeNs });
      }
      return result;
    });
    syncBuiltinESMExports();
    // The birthtime policy is fixed when the module loads.
    vi.resetModules();
    const identity = await import("./sqlite-worker-identity.js");
    const existing = identity.readDatabasePathIdentitySync(pathname);
    writeFileSync(pathname, "committed");
    ctimeAdvanceNs += 1n;
    expect(() => identity.assertDatabasePathIdentity(pathname, existing)).not.toThrow();
    replaceFile(pathname);
    expect(() => identity.assertDatabasePathIdentity(pathname, existing)).toThrow(
      /identity changed/,
    );
  },
);

it.each(["before", "after"] as const)(
  "refuses a database removed %s canonical path resolution during admission",
  async (removal) => {
    const pathname = path.join(dirs.make("openclaw-worker-identity-race-"), "state.sqlite");
    writeFileSync(pathname, "");
    const { realpath } = fs.promises;
    vi.mocked(fsPromises.realpath).mockImplementationOnce(async () => {
      if (removal === "before") {
        unlinkSync(pathname);
      }
      const canonicalPath = await realpath(pathname);
      if (removal === "after") {
        unlinkSync(pathname);
      }
      return canonicalPath;
    });
    await expect(readDatabasePathIdentity(pathname)).rejects.toMatchObject({
      message: "SQLite database pathname changed during admission",
      cause: expect.objectContaining({ code: "ENOENT" }),
    });
  },
);
