import fs, { renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import {
  readDatabasePathIdentity,
  readDatabasePathIdentitySync,
  assertExistingDatabaseIdentity,
} from "./sqlite-worker-identity.js";

vi.hoisted(() => vi.resetModules());
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return { ...original, realpath: vi.fn(original.realpath) };
});

const dirs = useAutoCleanupTempDirTracker(afterEach);

it("shares prospective and existing file identities between sync capture and async admission", async () => {
  const pathname = path.join(dirs.make("openclaw-worker-identity-"), "state.sqlite");
  const nativePath = path.toNamespacedPath(pathname);
  const prospective = readDatabasePathIdentitySync(nativePath);
  expect(prospective.key).toBe(`path:${prospective.canonicalPath}`);
  expect(await readDatabasePathIdentity(pathname)).toEqual(prospective);
  writeFileSync(pathname, "");
  const existing = readDatabasePathIdentitySync(nativePath);
  expect(existing.key).toMatch(/^file:/);
  expect(existing.canonicalPath).toBe(prospective.canonicalPath);
  expect(await readDatabasePathIdentity(pathname)).toEqual(existing);
  const birthtime =
    process.platform === "linux" || process.platform === "android"
      ? "0"
      : statSync(pathname, { bigint: true }).birthtimeNs.toString();
  expect(existing.birthtime).toBe(birthtime);
  expect(() => assertExistingDatabaseIdentity(pathname, existing.key, birthtime)).not.toThrow();
  expect(() =>
    assertExistingDatabaseIdentity(pathname, existing.key, (BigInt(birthtime) + 1n).toString()),
  ).toThrow(/identity changed/);
  const replacement = path.join(path.dirname(pathname), "replacement.sqlite");
  writeFileSync(replacement, "replacement");
  renameSync(replacement, pathname);
  expect(readDatabasePathIdentitySync(pathname).key).not.toBe(existing.key);
  expect(() => assertExistingDatabaseIdentity(pathname, existing.key, birthtime)).toThrow(
    /identity changed/,
  );
});

it.each(["linux", "android"] as const)(
  "keeps the %s database identity when Node reports ctime as birthtime",
  async (platform) => {
    const pathname = path.join(dirs.make("openclaw-worker-identity-ctime-"), "state.sqlite");
    writeFileSync(pathname, "");
    const databasePaths = new Set([pathname, fs.realpathSync.native(pathname)]);
    const stat = fs.statSync;
    let ctimeAdvanceNs = 0n;
    const platformSpy = mockProcessPlatform(platform);
    // libuv fills birthtime from ctime when statx is unavailable, as on Termux.
    const statSpy = vi.spyOn(fs, "statSync").mockImplementation((...args) => {
      const result = stat(...args);
      if (
        result &&
        typeof args[0] === "string" &&
        databasePaths.has(args[0]) &&
        "ctimeNs" in result
      ) {
        const ctimeNs = result.ctimeNs + ctimeAdvanceNs;
        Object.defineProperties(result, {
          ctimeNs: { value: ctimeNs },
          birthtimeNs: { value: ctimeNs },
        });
      }
      return result;
    });
    try {
      syncBuiltinESMExports();
      // The birthtime policy is fixed when the module loads.
      vi.resetModules();
      const identity = await import("./sqlite-worker-identity.js");
      const existing = identity.readDatabasePathIdentitySync(pathname);
      writeFileSync(pathname, "committed");
      ctimeAdvanceNs += 1n;
      expect(() => identity.assertDatabasePathIdentity(pathname, existing)).not.toThrow();
      const replacement = path.join(path.dirname(pathname), "replacement.sqlite");
      writeFileSync(replacement, "replacement");
      renameSync(replacement, pathname);
      expect(() => identity.assertDatabasePathIdentity(pathname, existing)).toThrow(
        /identity changed/,
      );
    } finally {
      statSpy.mockRestore();
      platformSpy.mockRestore();
      syncBuiltinESMExports();
      vi.resetModules();
    }
  },
);

it.each(["before", "after"] as const)(
  "refuses a database removed %s canonical path resolution during admission",
  async (removal) => {
    const pathname = path.join(dirs.make("openclaw-worker-identity-race-"), "state.sqlite");
    writeFileSync(pathname, "");
    const { realpath } =
      await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const resolving = vi.mocked(fsPromises.realpath).mockImplementationOnce(async () => {
      if (removal === "before") {
        unlinkSync(pathname);
      }
      const canonicalPath = await realpath(pathname);
      if (removal === "after") {
        unlinkSync(pathname);
      }
      return canonicalPath;
    });
    try {
      await expect(readDatabasePathIdentity(pathname)).rejects.toMatchObject({
        message: "SQLite database pathname changed during admission",
        cause: expect.objectContaining({ code: "ENOENT" }),
      });
    } finally {
      resolving.mockRestore();
    }
  },
);
