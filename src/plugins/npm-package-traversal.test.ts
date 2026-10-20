import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listManagedNpmRootPackageNames } from "./install-managed-npm-state.js";
import {
  auditOpenClawPeerDependenciesInManagedNpmRoot as auditPeers,
  relinkOpenClawPeerDependenciesInManagedNpmRoot as repairPeers,
} from "./plugin-peer-link.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

const tempDirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  cleanupTrackedTempDirs(tempDirs);
});

function makeRoot() {
  return makeTrackedTempDir("openclaw-npm-traversal", tempDirs);
}

function writePackage(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: path.basename(dir), peerDependencies: { openclaw: "*" } }),
  );
}

async function expectRepair(npmRoot: string, packageNames: string[]) {
  const before = await auditPeers({ npmRoot });
  expect(before.issues.map((issue) => issue.packageName)).toEqual(packageNames);
  expect(await repairPeers({ npmRoot, logger: {} })).toEqual({
    repaired: packageNames.length,
  });
}

async function expectEmptyAudit(npmRoot: string) {
  expect(await auditPeers({ npmRoot })).toEqual({ issues: [] });
}

describe("managed npm package traversal", () => {
  it("preserves scan order and repairs only real package directories", async () => {
    const npmRoot = makeRoot();
    const modules = path.join(npmRoot, "node_modules");
    const realNames = [
      "zeta",
      "@scope/zeta",
      "@scope/alpha",
      "alpha",
      "openclaw",
      ".hidden",
      ".bin",
    ];
    for (const name of realNames) {
      writePackage(path.join(modules, name));
    }
    fs.writeFileSync(path.join(modules, "plain-file"), "not a package");
    fs.writeFileSync(path.join(modules, "@scope", "plain-file"), "not a package");

    expect([...(await listManagedNpmRootPackageNames(npmRoot))]).toEqual([
      ".hidden",
      "@scope/alpha",
      "@scope/zeta",
      "alpha",
      "zeta",
    ]);
    const repairNames = ["@scope/alpha", "@scope/zeta", "alpha", "openclaw", "zeta"];
    await expectRepair(npmRoot, repairNames);
    for (const name of repairNames) {
      expect(fs.realpathSync(path.join(modules, name, "node_modules", "openclaw"))).toBe(
        fs.realpathSync(process.cwd()),
      );
    }
    expect(fs.existsSync(path.join(modules, ".hidden", "node_modules"))).toBe(false);
    expect(fs.existsSync(path.join(modules, ".bin", "node_modules"))).toBe(false);
    await expectEmptyAudit(npmRoot);
  });

  it.runIf(process.platform !== "win32")(
    "scans linked packages and scopes without repairing their targets",
    async () => {
      const npmRoot = makeRoot();
      const modules = path.join(npmRoot, "node_modules");
      const outside = makeRoot();
      writePackage(path.join(outside, "package"));
      writePackage(path.join(modules, "@scope", "real"));
      fs.writeFileSync(path.join(outside, "file"), "not a directory");
      for (const name of ["linked", "@scope/linked"]) {
        fs.symlinkSync(path.join(outside, "package"), path.join(modules, name), "dir");
      }
      for (const name of ["broken", "@scope/broken"]) {
        fs.symlinkSync(path.join(outside, "missing"), path.join(modules, name), "dir");
      }
      fs.symlinkSync(path.join(outside, "file"), path.join(modules, "file-link"), "file");
      fs.symlinkSync(outside, path.join(modules, "@linked"), "dir");
      fs.symlinkSync(path.join(outside, "missing-scope"), path.join(modules, "@missing"), "dir");
      expect([...(await listManagedNpmRootPackageNames(npmRoot))]).toEqual([
        "@linked/package",
        "@scope/broken",
        "@scope/linked",
        "@scope/real",
        "broken",
        "file-link",
        "linked",
      ]);
      await expectRepair(npmRoot, ["@scope/real"]);
      expect(fs.existsSync(path.join(outside, "package", "node_modules"))).toBe(false);
      await expectEmptyAudit(npmRoot);
    },
  );

  it("reports an invalid installer scope while peer repair skips non-directories", async () => {
    const npmRoot = makeRoot();
    const modules = path.join(npmRoot, "node_modules");
    fs.mkdirSync(modules);
    fs.writeFileSync(path.join(modules, "@scope"), "not a directory");
    await expect(listManagedNpmRootPackageNames(npmRoot)).rejects.toMatchObject({
      code: "ENOTDIR",
    });
    await expectRepair(npmRoot, []);
  });

  for (const [owner, read, empty] of [
    ["installer", listManagedNpmRootPackageNames, new Set()],
    ["peer audit", (npmRoot: string) => auditPeers({ npmRoot }), { issues: [] }],
    ["peer repair", (npmRoot: string) => repairPeers({ npmRoot, logger: {} }), { repaired: 0 }],
  ] as const) {
    it.each([
      ["missing", false],
      ["file", false],
      ["missing", true],
      ["file", true],
    ] as const)(
      `${owner} preserves %s errors (scope replaced after enumeration: %s)`,
      async (kind, scoped) => {
        const npmRoot = makeRoot();
        const modules = path.join(npmRoot, "node_modules");
        if (scoped) {
          const scope = path.join(modules, "@scope");
          fs.mkdirSync(scope, { recursive: true });
          const readdir = fs.promises.readdir;
          vi.spyOn(fs.promises, "readdir").mockImplementationOnce(async (dir, options) => {
            const entries = await readdir(dir, options);
            fs.rmdirSync(scope);
            if (kind === "file") {
              fs.writeFileSync(scope, "replaced after enumeration");
            }
            return entries;
          });
        } else if (kind === "file") {
          fs.writeFileSync(modules, "not a directory");
        }
        if (kind === "file") {
          await expect(read(npmRoot)).rejects.toMatchObject({ code: "ENOTDIR" });
        } else {
          await expect(read(npmRoot)).resolves.toEqual(empty);
        }
      },
    );
  }
});
