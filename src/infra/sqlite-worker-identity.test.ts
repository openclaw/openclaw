import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  readDatabasePathIdentity,
  readDatabasePathIdentitySync,
} from "./sqlite-worker-identity.js";

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
});
