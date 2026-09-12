// Covers plugin peer linking for development installs.
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  auditOpenClawPeerDependenciesInManagedNpmRoot,
  linkOpenClawPeerDependencies,
  reconcileRegisteredOpenClawHostLinks,
  relinkOpenClawPeerDependenciesInManagedNpmRoot,
} from "./plugin-peer-link.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

const tempDirs: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  cleanupTrackedTempDirs(tempDirs);
});

function makeTempDir() {
  return makeTrackedTempDir("openclaw-plugin-peer-link", tempDirs);
}

describe("plugin peer links", () => {
  describe.each(["direct", "managed", "registered"] as const)("%s repair authority", (entry) => {
    it.each(["missing-modules", "missing-link", "stale-link", "package-copy"] as const)(
      "preserves %s on a one-shot authority refusal during preparation",
      async (layout) => {
        const root = makeTempDir();
        const extensionsDir = path.join(root, "extensions");
        const packageDir = path.join(
          entry === "registered" ? extensionsDir : path.join(root, "node_modules"),
          "peer-plugin",
        );
        const nodeModulesDir = path.join(packageDir, "node_modules");
        const linkPath = path.join(nodeModulesDir, "openclaw");
        const oldHost = path.join(root, "old-host");
        fs.mkdirSync(packageDir, { recursive: true });
        fs.writeFileSync(
          path.join(packageDir, "package.json"),
          JSON.stringify({ name: "peer-plugin", peerDependencies: { openclaw: "*" } }),
        );
        const siblingDir = path.join(path.dirname(packageDir), "z-peer-plugin");
        fs.mkdirSync(siblingDir);
        fs.writeFileSync(
          path.join(siblingDir, "package.json"),
          JSON.stringify({ name: "z-peer-plugin", peerDependencies: { openclaw: "*" } }),
        );
        if (layout !== "missing-modules") {
          fs.mkdirSync(nodeModulesDir);
        }
        if (layout === "stale-link") {
          fs.mkdirSync(oldHost);
          fs.symlinkSync(oldHost, linkPath, "junction");
        } else if (layout === "package-copy") {
          fs.mkdirSync(linkPath);
          fs.writeFileSync(path.join(linkPath, "package.json"), '{"name":"openclaw"}');
        }
        const failure = new Error("update authority revoked");
        let current = true;
        const warnings: string[] = [];
        const guarded = {
          logger: { warn: (message: string) => warnings.push(message) },
          beforePersistentEffect: () => {
            if (!current) {
              current = true;
              throw failure;
            }
          },
        };
        const operation =
          entry === "managed"
            ? relinkOpenClawPeerDependenciesInManagedNpmRoot({ npmRoot: root, ...guarded })
            : entry === "registered"
              ? reconcileRegisteredOpenClawHostLinks({
                  extensionsDir,
                  installRecords: {
                    "peer-plugin": { source: "npm", installPath: packageDir },
                    "z-peer-plugin": { source: "npm", installPath: siblingDir },
                  },
                  mode: "repair",
                  ...guarded,
                })
              : linkOpenClawPeerDependencies({
                  installedDir: packageDir,
                  peerDependencies: { openclaw: "*" },
                  ...guarded,
                });
        // Each entry has started asynchronous filesystem preparation but has not mutated yet.
        current = false;
        await expect(operation).rejects.toBe(failure);
        expect(warnings).toEqual([]);
        expect(fs.existsSync(path.join(siblingDir, "node_modules"))).toBe(false);
        if (layout === "stale-link") {
          expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);
          expect(fs.realpathSync(linkPath)).toBe(fs.realpathSync(oldHost));
        } else if (layout === "package-copy") {
          expect(fs.lstatSync(linkPath).isDirectory()).toBe(true);
          expect(fs.readFileSync(path.join(linkPath, "package.json"), "utf8")).toBe(
            '{"name":"openclaw"}',
          );
        } else {
          expect(fs.existsSync(linkPath)).toBe(false);
          expect(fs.existsSync(nodeModulesDir)).toBe(layout === "missing-link");
        }
      },
    );
  });

  it.each(["symlink", "directory"] as const)(
    "stops before replacement on a one-shot refusal after removing the old %s",
    async (existingKind) => {
      const root = makeTempDir();
      const packageDir = path.join(root, "peer-plugin");
      const linkPath = path.join(packageDir, "node_modules", "openclaw");
      fs.mkdirSync(path.dirname(linkPath), { recursive: true });
      let current = true;
      if (existingKind === "symlink") {
        const oldHost = path.join(root, "old-host");
        fs.mkdirSync(oldHost);
        fs.symlinkSync(oldHost, linkPath, "junction");
        const unlink = fsPromises.unlink.bind(fsPromises);
        vi.spyOn(fsPromises, "unlink").mockImplementation(async (target) => {
          await unlink(target);
          current = false;
        });
      } else {
        fs.mkdirSync(linkPath);
        fs.writeFileSync(path.join(linkPath, "package.json"), '{"name":"openclaw"}');
        const rm = fsPromises.rm.bind(fsPromises);
        vi.spyOn(fsPromises, "rm").mockImplementation(async (target, options) => {
          await rm(target, options);
          current = false;
        });
      }
      const failure = new Error("update authority revoked after removal");
      const warnings: string[] = [];
      await expect(
        linkOpenClawPeerDependencies({
          installedDir: packageDir,
          peerDependencies: { openclaw: "*" },
          logger: { warn: (message) => warnings.push(message) },
          beforePersistentEffect: () => {
            if (!current) {
              current = true;
              throw failure;
            }
          },
        }),
      ).rejects.toBe(failure);
      expect(current).toBe(true);
      expect(fs.existsSync(linkPath)).toBe(false);
      expect(warnings).toEqual([]);
    },
  );

  it("preserves filesystem failure reporting while caller authority remains current", async () => {
    const packageDir = makeTempDir();
    fs.mkdirSync(path.join(packageDir, "node_modules"));
    const failure = new Error("peer link write denied");
    vi.spyOn(fsPromises, "symlink").mockRejectedValueOnce(failure);
    const warnings: string[] = [];

    const result = await linkOpenClawPeerDependencies({
      installedDir: packageDir,
      peerDependencies: { openclaw: "*" },
      beforePersistentEffect: () => {},
      logger: { warn: (message) => warnings.push(message) },
    });

    expect(result).toEqual({ repaired: 0, skipped: 1 });
    expect(warnings).toEqual([expect.stringContaining(failure.message)]);
    expect(fs.existsSync(path.join(packageDir, "node_modules", "openclaw"))).toBe(false);
  });

  it("relinks openclaw peers in the managed npm root", async () => {
    const npmRoot = makeTempDir();
    const packageDir = path.join(npmRoot, "node_modules", "peer-plugin");
    fs.mkdirSync(packageDir, { recursive: true });
    fs.writeFileSync(
      path.join(packageDir, "package.json"),
      JSON.stringify({
        name: "peer-plugin",
        version: "1.0.0",
        peerDependencies: {
          openclaw: ">=2026.0.0",
        },
      }),
      "utf8",
    );

    const messages: string[] = [];
    const result = await relinkOpenClawPeerDependenciesInManagedNpmRoot({
      npmRoot,
      logger: {
        info: (message) => messages.push(message),
        warn: (message) => messages.push(message),
      },
    });

    const linkPath = path.join(packageDir, "node_modules", "openclaw");
    expect(result).toEqual({ checked: 1, attempted: 1, repaired: 1, skipped: 0 });
    expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(linkPath)).toBe(fs.realpathSync(process.cwd()));
    expect(messages.join("\n")).toContain('Linked peerDependency "openclaw"');
  });

  it("relinks openclaw runtime dependencies in the managed npm root", async () => {
    const npmRoot = makeTempDir();
    const packageDir = path.join(npmRoot, "node_modules", "runtime-plugin");
    fs.mkdirSync(packageDir, { recursive: true });
    fs.writeFileSync(
      path.join(packageDir, "package.json"),
      JSON.stringify({
        name: "runtime-plugin",
        version: "1.0.0",
        dependencies: {
          openclaw: "2026.7.1",
        },
      }),
      "utf8",
    );

    const result = await relinkOpenClawPeerDependenciesInManagedNpmRoot({
      npmRoot,
      logger: {},
    });

    const linkPath = path.join(packageDir, "node_modules", "openclaw");
    expect(result).toEqual({ checked: 1, attempted: 1, repaired: 1, skipped: 0 });
    expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(linkPath)).toBe(fs.realpathSync(process.cwd()));
  });

  it("reports one unreadable package and continues repairing its sibling", async () => {
    const npmRoot = makeTempDir();
    const unreadableDir = path.join(npmRoot, "node_modules", "bad-plugin");
    const peerDir = path.join(npmRoot, "node_modules", "peer-plugin");
    fs.mkdirSync(unreadableDir, { recursive: true });
    fs.mkdirSync(peerDir, { recursive: true });
    fs.writeFileSync(path.join(unreadableDir, "package.json"), "{", "utf8");
    fs.writeFileSync(
      path.join(peerDir, "package.json"),
      JSON.stringify({
        name: "peer-plugin",
        peerDependencies: { openclaw: ">=2026.0.0" },
      }),
      "utf8",
    );
    const failures: Array<{ error: unknown; packageDir: string }> = [];

    const result = await relinkOpenClawPeerDependenciesInManagedNpmRoot({
      npmRoot,
      logger: {},
      onPackageReadError: (error, packageDir) => failures.push({ error, packageDir }),
    });

    expect(result).toEqual({ checked: 1, attempted: 1, repaired: 1, skipped: 1 });
    expect(failures).toHaveLength(1);
    expect(failures[0]?.packageDir).toBe(unreadableDir);
    expect(failures[0]?.error).toBeInstanceOf(SyntaxError);
    expect(fs.lstatSync(path.join(peerDir, "node_modules", "openclaw")).isSymbolicLink()).toBe(
      true,
    );
  });

  it("reports one unreadable package and continues auditing its sibling", async () => {
    const npmRoot = makeTempDir();
    const unreadableDir = path.join(npmRoot, "node_modules", "bad-plugin");
    const peerDir = path.join(npmRoot, "node_modules", "peer-plugin");
    fs.mkdirSync(unreadableDir, { recursive: true });
    fs.mkdirSync(peerDir, { recursive: true });
    fs.writeFileSync(path.join(unreadableDir, "package.json"), "{", "utf8");
    fs.writeFileSync(
      path.join(peerDir, "package.json"),
      JSON.stringify({
        name: "peer-plugin",
        peerDependencies: { openclaw: ">=2026.0.0" },
      }),
      "utf8",
    );
    const failures: Array<{ error: unknown; packageDir: string }> = [];

    const result = await auditOpenClawPeerDependenciesInManagedNpmRoot({
      npmRoot,
      onPackageReadError: (error, packageDir) => failures.push({ error, packageDir }),
    });

    expect(result.checked).toBe(1);
    expect(result.broken).toBe(1);
    expect(result.issues[0]?.packageName).toBe("peer-plugin");
    expect(failures).toHaveLength(1);
    expect(failures[0]?.packageDir).toBe(unreadableDir);
  });

  it("audits missing managed npm openclaw peer links without relinking", async () => {
    const npmRoot = makeTempDir();
    const packageDir = path.join(npmRoot, "node_modules", "peer-plugin");
    fs.mkdirSync(packageDir, { recursive: true });
    fs.writeFileSync(
      path.join(packageDir, "package.json"),
      JSON.stringify({
        name: "peer-plugin",
        version: "1.0.0",
        peerDependencies: {
          openclaw: ">=2026.0.0",
        },
      }),
      "utf8",
    );

    const result = await auditOpenClawPeerDependenciesInManagedNpmRoot({ npmRoot });

    const linkPath = path.join(packageDir, "node_modules", "openclaw");
    expect(result.checked).toBe(1);
    expect(result.broken).toBe(1);
    expect(result.issues[0]?.packageName).toBe("peer-plugin");
    expect(result.issues[0]?.reason).toContain(linkPath);
    expect(fs.existsSync(linkPath)).toBe(false);
  });

  it.runIf(process.platform !== "win32")(
    "does not follow a package-local node_modules symlink while linking openclaw peers",
    async () => {
      const root = makeTempDir();
      const packageDir = path.join(root, "peer-plugin");
      const outsideDir = path.join(root, "outside-node-modules");
      fs.mkdirSync(packageDir, { recursive: true });
      fs.mkdirSync(outsideDir, { recursive: true });
      fs.symlinkSync(outsideDir, path.join(packageDir, "node_modules"), "dir");

      const warnings: string[] = [];
      const result = await linkOpenClawPeerDependencies({
        installedDir: packageDir,
        peerDependencies: {
          openclaw: ">=2026.0.0",
        },
        logger: {
          warn: (message) => warnings.push(message),
        },
      });

      expect(result).toEqual({ repaired: 0, skipped: 1 });
      expect(fs.existsSync(path.join(outsideDir, "openclaw"))).toBe(false);
      expect(warnings.join("\n")).toContain("is not a real directory");
    },
  );

  it("replaces an existing real openclaw package directory", async () => {
    const root = makeTempDir();
    const packageDir = path.join(root, "peer-plugin");
    const existingOpenClawDir = path.join(packageDir, "node_modules", "openclaw");
    fs.mkdirSync(existingOpenClawDir, { recursive: true });
    fs.writeFileSync(path.join(existingOpenClawDir, "package.json"), '{"name":"openclaw"}', "utf8");

    const messages: string[] = [];
    const result = await linkOpenClawPeerDependencies({
      installedDir: packageDir,
      peerDependencies: {
        openclaw: ">=2026.0.0",
      },
      logger: {
        info: (message) => messages.push(message),
      },
    });

    expect(result).toEqual({ repaired: 1, skipped: 0 });
    expect(fs.lstatSync(existingOpenClawDir).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(existingOpenClawDir)).toBe(fs.realpathSync(process.cwd()));
    expect(messages.join("\n")).toContain('Linked peerDependency "openclaw"');
  });

  it("does not delete an unrelated existing package directory", async () => {
    const root = makeTempDir();
    const packageDir = path.join(root, "peer-plugin");
    const existingOpenClawDir = path.join(packageDir, "node_modules", "openclaw");
    fs.mkdirSync(existingOpenClawDir, { recursive: true });
    fs.writeFileSync(
      path.join(existingOpenClawDir, "package.json"),
      '{"name":"not-openclaw"}',
      "utf8",
    );

    const warnings: string[] = [];
    const result = await linkOpenClawPeerDependencies({
      installedDir: packageDir,
      peerDependencies: {
        openclaw: ">=2026.0.0",
      },
      logger: {
        warn: (message) => warnings.push(message),
      },
    });

    expect(result).toEqual({ repaired: 0, skipped: 1 });
    expect(fs.existsSync(path.join(existingOpenClawDir, "package.json"))).toBe(true);
    expect(warnings.join("\n")).toContain("already exists and is not a symlink");
  });

  it.runIf(process.platform !== "win32")(
    "does not follow a registered plugin manifest symlink outside its package root",
    async () => {
      const root = makeTempDir();
      const extensionsDir = path.join(root, "extensions");
      const packageDir = path.join(extensionsDir, "email");
      const staleHostDir = path.join(packageDir, "node_modules", "openclaw");
      const outsideManifest = path.join(root, "outside-package.json");
      fs.mkdirSync(staleHostDir, { recursive: true });
      fs.writeFileSync(
        outsideManifest,
        JSON.stringify({ name: "email", peerDependencies: { openclaw: "*" } }),
      );
      fs.symlinkSync(outsideManifest, path.join(packageDir, "package.json"), "file");
      fs.writeFileSync(path.join(staleHostDir, "package.json"), '{"name":"openclaw"}');
      const failures: Array<{ error: unknown; packageDir: string }> = [];

      const result = await reconcileRegisteredOpenClawHostLinks({
        extensionsDir,
        installRecords: { email: { source: "npm", installPath: packageDir } },
        mode: "repair",
        onPackageReadError: (error, failedPackageDir) => {
          failures.push({ error, packageDir: failedPackageDir });
        },
      });

      expect(result.repaired).toBe(0);
      expect(result.skipped).toBe(1);
      expect(failures[0]?.packageDir).toBe(packageDir);
      expect(fs.lstatSync(staleHostDir).isDirectory()).toBe(true);
    },
  );

  it.runIf(process.platform !== "win32")(
    "repairs a registered npm plugin when the operator-owned extensions root is a symlink",
    async () => {
      const root = makeTempDir();
      const realExtensionsDir = path.join(root, "real-extensions");
      const extensionsDir = path.join(root, "extensions");
      fs.mkdirSync(realExtensionsDir, { recursive: true });
      fs.symlinkSync(realExtensionsDir, extensionsDir, "dir");
      const packageDir = path.join(extensionsDir, "email");
      const staleHostDir = path.join(packageDir, "node_modules", "openclaw");
      fs.mkdirSync(staleHostDir, { recursive: true });
      fs.writeFileSync(
        path.join(packageDir, "package.json"),
        JSON.stringify({ name: "email", dependencies: { openclaw: "2026.7.1" } }),
      );
      fs.writeFileSync(path.join(staleHostDir, "package.json"), '{"name":"openclaw"}');

      const result = await reconcileRegisteredOpenClawHostLinks({
        extensionsDir,
        installRecords: { email: { source: "npm", installPath: packageDir } },
        mode: "repair",
      });

      expect(result.repaired).toBe(1);
      expect(fs.lstatSync(staleHostDir).isSymbolicLink()).toBe(true);
      expect(fs.realpathSync(staleHostDir)).toBe(fs.realpathSync(process.cwd()));
    },
  );

  it.runIf(process.platform !== "win32")(
    "does not follow a registered plugin node_modules symlink outside its package root",
    async () => {
      const root = makeTempDir();
      const extensionsDir = path.join(root, "extensions");
      const packageDir = path.join(extensionsDir, "email");
      const outsideModules = path.join(root, "outside-node-modules");
      const outsideHost = path.join(outsideModules, "openclaw");
      fs.mkdirSync(packageDir, { recursive: true });
      fs.mkdirSync(outsideHost, { recursive: true });
      fs.writeFileSync(
        path.join(packageDir, "package.json"),
        JSON.stringify({ name: "email", peerDependencies: { openclaw: "*" } }),
      );
      fs.writeFileSync(path.join(outsideHost, "package.json"), '{"name":"openclaw"}');
      fs.symlinkSync(outsideModules, path.join(packageDir, "node_modules"), "dir");
      const warnings: string[] = [];

      const result = await reconcileRegisteredOpenClawHostLinks({
        extensionsDir,
        installRecords: { email: { source: "npm", installPath: packageDir } },
        mode: "repair",
        logger: { warn: (message) => warnings.push(message) },
      });

      expect(result.repaired).toBe(0);
      expect(result.skipped).toBe(1);
      expect(fs.lstatSync(outsideHost).isDirectory()).toBe(true);
      expect(warnings.join("\n")).toContain("is not a real directory");
    },
  );
});
