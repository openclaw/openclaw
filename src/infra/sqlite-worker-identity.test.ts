import { statSync, unlinkSync, writeFileSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
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
  const birthtime = statSync(pathname, { bigint: true }).birthtimeNs;
  expect(() =>
    assertExistingDatabaseIdentity(pathname, existing.key, birthtime.toString()),
  ).not.toThrow();
  expect(() =>
    assertExistingDatabaseIdentity(pathname, existing.key, (birthtime + 1n).toString()),
  ).toThrow(/identity changed/);
});

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
