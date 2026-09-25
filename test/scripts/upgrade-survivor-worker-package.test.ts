import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertWorkerCellPackageIdentity,
  readWorkerCellPackageIdentity,
} from "../../scripts/e2e/lib/upgrade-survivor/worker-cell-package.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function packageFixture() {
  const root = tempDirs.make("worker-package-identity-");
  fs.mkdirSync(path.join(root, "dist"));
  fs.writeFileSync(path.join(root, "package.json"), '{"name":"openclaw","version":"2026.9.4"}');
  fs.writeFileSync(path.join(root, "openclaw.mjs"), "export {};\n");
  fs.writeFileSync(
    path.join(root, "dist/build-info.json"),
    JSON.stringify({ version: "2026.9.4", commit: "a".repeat(40) }),
  );
  fs.writeFileSync(path.join(root, "dist/entry.mjs"), "export const answer = 1;\n");
  fs.symlinkSync("entry.mjs", path.join(root, "dist/alias.mjs"));
  return root;
}

describe("worker survivor installed payload identity", () => {
  it.each(["changed", "extra", "missing", "symlink"])(
    "rejects a %s dist entry even when package version and build commit agree",
    (mutation) => {
      const root = packageFixture();
      const expected = readWorkerCellPackageIdentity(root);
      if (mutation === "changed") {
        fs.writeFileSync(path.join(root, "dist/entry.mjs"), "export const answer = 2;\n");
      } else if (mutation === "extra") {
        fs.writeFileSync(path.join(root, "dist/stale.mjs"), "export {};\n");
      } else if (mutation === "missing") {
        fs.unlinkSync(path.join(root, "dist/entry.mjs"));
      } else {
        fs.unlinkSync(path.join(root, "dist/alias.mjs"));
        fs.symlinkSync("build-info.json", path.join(root, "dist/alias.mjs"));
      }
      expect(() =>
        assertWorkerCellPackageIdentity(readWorkerCellPackageIdentity(root), expected),
      ).toThrow("Installed application payload differs");
    },
  );

  it("compares application bytes while npm reifies its installed dependency tree", () => {
    const root = packageFixture();
    const expected = readWorkerCellPackageIdentity(root);
    fs.mkdirSync(path.join(root, "node_modules"));
    fs.writeFileSync(path.join(root, "node_modules/.package-lock.json"), "{}");
    expect(() =>
      assertWorkerCellPackageIdentity(readWorkerCellPackageIdentity(root), expected),
    ).not.toThrow();
  });
});
