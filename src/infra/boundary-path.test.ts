import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  resolveIdentityPathViaExistingAncestorSync,
  resolveRealpathOrAbsolute,
} from "./boundary-path.js";

afterEach(() => vi.restoreAllMocks());
const dirs = useAutoCleanupTempDirTracker(afterEach);

it("keeps missing paths lexical and falls back on non-missing errors", async () => {
  const base = dirs.make("openclaw-boundary-path-");
  const alias = path.join(base, "alias");
  await fs.symlink(path.join(base, "target"), alias);
  const missing = path.join(alias, "missing");
  expect(resolveRealpathOrAbsolute(missing)).toBe(path.resolve(missing));
  vi.spyOn(fsSync, "realpathSync").mockImplementation(() => {
    throw Object.assign(new Error("denied"), { code: "EACCES" });
  });
  expect(resolveRealpathOrAbsolute("denied")).toBe(path.resolve("denied"));
});

it.each([true, false])("resolves ancestor identity with a reachable ancestor: %s", (reachable) => {
  const aliasRoot = path.resolve("identity-alias");
  const targetPath = path.join(aliasRoot, "locked", "leaf");
  const canonicalRoot = path.resolve("identity-real");
  vi.spyOn(fsSync.realpathSync, "native").mockImplementation((candidate) => {
    const resolved = path.resolve(String(candidate));
    if (reachable && resolved === aliasRoot) {
      return canonicalRoot;
    }
    throw new Error("simulated realpath failure");
  });

  expect(resolveIdentityPathViaExistingAncestorSync(targetPath)).toBe(
    reachable ? path.join(canonicalRoot, "locked", "leaf") : targetPath,
  );
});
