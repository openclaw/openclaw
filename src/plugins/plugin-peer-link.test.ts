import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  auditDeclaredOpenClawHostDependency,
  auditOpenClawPeerDependenciesInManagedNpmRoot,
  auditOpenClawPeerDependencyLinkSync,
  linkOpenClawPeerDependencies,
  reconcileRegisteredOpenClawHostLinks,
  relinkOpenClawPeerDependenciesInManagedNpmRoot,
} from "./plugin-peer-link.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

const tempDirs: string[] = [];

function writeJson(filePath: string, data: unknown) {
  fs.writeFileSync(filePath, JSON.stringify(data), "utf8");
}

function writePackage(packageDir: string, manifest: Record<string, unknown>) {
  fs.mkdirSync(packageDir, { recursive: true });
  writeJson(path.join(packageDir, "package.json"), manifest);
}

function peerPackage(packageDir: string) {
  writePackage(packageDir, {
    name: path.basename(packageDir),
    peerDependencies: { openclaw: "*" },
  });
}

function peerInstall(installedDir: string) {
  return { installedDir, peerDependencies: { openclaw: "*" }, logger: {} };
}

function peerFixture(layout = "missing-modules", registered = false, root = makeTempDir()) {
  const extensionsDir = path.join(root, "extensions");
  const parent = registered ? extensionsDir : path.join(root, "node_modules");
  const packageDir = path.join(parent, "peer-plugin");
  const nodeModulesDir = path.join(packageDir, "node_modules");
  const linkPath = path.join(nodeModulesDir, "openclaw");
  const oldHost = path.join(root, "old-host");
  peerPackage(packageDir);
  if (layout !== "missing-modules") {
    fs.mkdirSync(nodeModulesDir);
  }
  if (layout === "stale-link") {
    fs.mkdirSync(oldHost);
    fs.symlinkSync(oldHost, linkPath, "junction");
  } else if (layout === "package-copy") {
    writePackage(linkPath, { name: "openclaw" });
  }
  return { root, extensionsDir, packageDir, nodeModulesDir, linkPath, oldHost };
}

function registeredRepair(packageDir: string, ...siblings: string[]) {
  return {
    extensionsDir: path.dirname(packageDir),
    installRecords: Object.fromEntries(
      [packageDir, ...siblings].map((installPath) => [
        path.basename(installPath),
        { source: "npm" as const, installPath },
      ]),
    ),
    mode: "repair" as const,
  };
}

function oneShotAuthority() {
  const failure = new Error("update authority revoked");
  const guard = {
    current: true,
    beforePersistentApply: () => {
      if (!guard.current) {
        guard.current = true;
        throw failure;
      }
    },
  };
  return { guard, failure };
}

function expectHostLink(linkPath: string, hostRoot = process.cwd()) {
  expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true);
  expect(fs.realpathSync(linkPath)).toBe(fs.realpathSync(hostRoot));
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  syncBuiltinESMExports();
  cleanupTrackedTempDirs(tempDirs);
});

function makeTempDir() {
  return makeTrackedTempDir("openclaw-plugin-peer-link", tempDirs);
}

describe("plugin peer links", () => {
  function standalone(root: string, overrides: Record<string, unknown> = {}) {
    const runtime = path.join(root, "runtime");
    writePackage(runtime, { name: "openclaw" });
    writeJson(path.join(root, "manifest.json"), {
      schemaVersion: 1,
      mode: "jit",
      executable: { path: "renamed-host", sha256: "a".repeat(64) },
      runtime: { path: "runtime", sha256: "b".repeat(64) },
      openclaw: { version: "2026.10.4", commit: "c".repeat(40) },
      bun: { version: "1.4.3" },
      ...overrides,
    });
    return runtime;
  }

  it("admits a peer installed by another copy of the same standalone build and rebinds on repair", async () => {
    const { root, packageDir, linkPath: peer } = peerFixture();
    const bundle = standalone(path.join(root, "bundle"));
    const seed = standalone(path.join(root, "seed"));
    vi.stubGlobal("__openclawStandaloneRootUrl", new URL(`file://${bundle}/`).href);
    const install = peerInstall(packageDir);
    const linked = await linkOpenClawPeerDependencies({ ...install, hostRoot: bundle });
    expect(linked).toEqual({ repaired: 1, skipped: 0 });
    expect(fs.realpathSync(peer)).toBe(fs.realpathSync(bundle));

    vi.stubGlobal("__openclawStandaloneRootUrl", new URL(`file://${seed}/`).href);
    expect(auditOpenClawPeerDependencyLinkSync({ packageDir })).toBeNull();
    // Metadata admission is read-only; explicit installation/repair owns rebinding.
    expect(fs.realpathSync(peer)).toBe(fs.realpathSync(bundle));
    expect(await linkOpenClawPeerDependencies(install)).toEqual({ repaired: 1, skipped: 0 });
    expect(fs.realpathSync(peer)).toBe(fs.realpathSync(seed));
  });

  it.each([
    ["new commit", { openclaw: { version: "2026.10.4", commit: "d".repeat(40) } }],
    ["rebuilt executable", { executable: { path: "renamed-host", sha256: "d".repeat(64) } }],
    ["changed sidecar", { runtime: { path: "runtime", sha256: "d".repeat(64) } }],
    ["unrelated sidecar", { runtime: { path: "other-runtime", sha256: "b".repeat(64) } }],
    ["version only", { openclaw: { version: "2026.10.4" } }],
  ])("rejects %s and lets an explicit install re-resolve its host", async (_label, overrides) => {
    const { root, packageDir, linkPath: peer } = peerFixture("missing-link");
    const previous = standalone(path.join(root, "previous"));
    const current = standalone(path.join(root, "current"), overrides);
    fs.symlinkSync(previous, peer, "junction");
    vi.stubGlobal("__openclawStandaloneRootUrl", new URL(`file://${current}/`).href);
    const issue = auditOpenClawPeerDependencyLinkSync({ packageDir });
    expect(issue?.reason).toContain("instead of");
    expect(issue?.reason).toContain("openclaw doctor --fix");
    expect(fs.realpathSync(peer)).toBe(fs.realpathSync(previous));
    const linked = await linkOpenClawPeerDependencies(peerInstall(packageDir));
    expect(linked).toEqual({ repaired: 1, skipped: 0 });
    expect(auditOpenClawPeerDependencyLinkSync({ packageDir })).toBeNull();
    expect(fs.realpathSync(peer)).toBe(fs.realpathSync(current));
  });

  describe.each(["direct", "managed", "registered"] as const)("%s repair authority", (entry) => {
    it.each(["missing-modules", "missing-link", "stale-link", "package-copy"] as const)(
      "preserves %s on a one-shot authority refusal during preparation",
      async (layout) => {
        const { root, packageDir, nodeModulesDir, linkPath, oldHost } = peerFixture(
          layout,
          entry === "registered",
        );
        const siblingDir = path.join(path.dirname(packageDir), "z-peer-plugin");
        peerPackage(siblingDir);
        const { guard, failure } = oneShotAuthority();
        const warnings: string[] = [];
        const guarded = {
          logger: { warn: (message: string) => warnings.push(message) },
          beforePersistentApply: guard.beforePersistentApply,
        };
        const operation =
          entry === "managed"
            ? relinkOpenClawPeerDependenciesInManagedNpmRoot({ npmRoot: root, ...guarded })
            : entry === "registered"
              ? reconcileRegisteredOpenClawHostLinks({
                  ...registeredRepair(packageDir, siblingDir),
                  ...guarded,
                })
              : linkOpenClawPeerDependencies({ ...peerInstall(packageDir), ...guarded });
        // Each entry has started asynchronous filesystem preparation but has not mutated yet.
        guard.current = false;
        await expect(operation).rejects.toBe(failure);
        expect(warnings).toEqual([]);
        expect(fs.existsSync(path.join(siblingDir, "node_modules"))).toBe(false);
        if (layout === "stale-link") {
          expectHostLink(linkPath, oldHost);
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

  it("awaits registered peer preparation before checking synchronous apply authority", async () => {
    const { packageDir, linkPath, oldHost } = peerFixture("stale-link", true);
    const prepared = createDeferred();
    const release = createDeferred();
    let preparationEntered = false;
    const refusal = new Error("registered peer apply authority revoked");
    const beforePersistentApply = vi.fn(() => {
      throw refusal;
    });
    const operation = reconcileRegisteredOpenClawHostLinks({
      ...registeredRepair(packageDir),
      beforePersistentEffect: async () => {
        preparationEntered = true;
        prepared.resolve();
        await release.promise;
      },
      beforePersistentApply,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    try {
      await Promise.race([prepared.promise, operation]);
      expect(preparationEntered).toBe(true);
      expect(beforePersistentApply).not.toHaveBeenCalled();
      expect(fs.readlinkSync(linkPath)).toBe(oldHost);
    } finally {
      release.resolve();
      await operation;
    }
    expect(await operation).toBe(refusal);
    expect(beforePersistentApply).toHaveBeenCalledOnce();
    expect(fs.readlinkSync(linkPath)).toBe(oldHost);
  });

  it.each(["symlink", "directory"] as const)(
    "stops before replacement on a one-shot refusal after removing the old %s",
    async (existingKind) => {
      const { packageDir, linkPath } = peerFixture(
        existingKind === "symlink" ? "stale-link" : "package-copy",
      );
      const { guard, failure } = oneShotAuthority();
      if (existingKind === "symlink") {
        const unlink = fs.unlinkSync.bind(fs);
        vi.spyOn(fs, "unlinkSync").mockImplementation((target) => {
          unlink(target);
          guard.current = false;
        });
        syncBuiltinESMExports();
      } else {
        const rm = fsPromises.rm.bind(fsPromises);
        vi.spyOn(fsPromises, "rm").mockImplementation(async (target, options) => {
          await rm(target, options);
          guard.current = false;
        });
      }
      const warnings: string[] = [];
      await expect(
        linkOpenClawPeerDependencies({
          ...peerInstall(packageDir),
          logger: { warn: (message) => warnings.push(message) },
          beforePersistentApply: guard.beforePersistentApply,
        }),
      ).rejects.toBe(failure);
      expect(guard.current).toBe(true);
      expect(fs.existsSync(linkPath)).toBe(false);
      expect(warnings).toEqual([]);
    },
  );

  it("preserves filesystem failure reporting while caller authority remains current", async () => {
    const { packageDir, linkPath } = peerFixture("missing-link");
    const failure = new Error("peer link write denied");
    vi.spyOn(fs, "symlinkSync").mockImplementationOnce(() => {
      throw failure;
    });
    syncBuiltinESMExports();
    const warnings: string[] = [];

    const result = await linkOpenClawPeerDependencies({
      ...peerInstall(packageDir),
      beforePersistentApply: () => {},
      logger: { warn: (message) => warnings.push(message) },
    });

    expect(result).toEqual({ repaired: 0, skipped: 1 });
    expect(warnings).toEqual([expect.stringContaining(failure.message)]);
    expect(fs.existsSync(linkPath)).toBe(false);
  });

  it.each(["managed", "registered"] as const)(
    "ignores packages without a host declaration during %s audit and repair",
    async (entry) => {
      const { root, packageDir, linkPath } = peerFixture("missing-modules", entry === "registered");
      const unrelatedDir = path.join(path.dirname(packageDir), "aaa-unrelated-plugin");
      const manifest = { name: "aaa-unrelated-plugin", dependencies: { other: "*" } };
      writePackage(unrelatedDir, manifest);
      const onPackageReadError = vi.fn();
      expect(await auditDeclaredOpenClawHostDependency({ packageDir: unrelatedDir })).toBeNull();
      const options = registeredRepair(packageDir, unrelatedDir);
      const audit =
        entry === "registered"
          ? await reconcileRegisteredOpenClawHostLinks({
              ...options,
              mode: "audit",
              onPackageReadError,
            })
          : await auditOpenClawPeerDependenciesInManagedNpmRoot({
              npmRoot: root,
              onPackageReadError,
            });
      expect(audit.issues.map((issue) => issue.packageName)).toEqual(["peer-plugin"]);
      const repaired =
        entry === "registered"
          ? await reconcileRegisteredOpenClawHostLinks({ ...options, onPackageReadError })
          : await relinkOpenClawPeerDependenciesInManagedNpmRoot({
              npmRoot: root,
              logger: {},
              onPackageReadError,
            });
      expect(repaired.repaired).toBe(1);
      expectHostLink(linkPath);
      expect(fs.existsSync(path.join(unrelatedDir, "node_modules"))).toBe(false);
      expect(fs.readFileSync(path.join(unrelatedDir, "package.json"), "utf8")).toBe(
        JSON.stringify(manifest),
      );
      expect(onPackageReadError).not.toHaveBeenCalled();
    },
  );

  it("does not replace a foreign package occupying the host link", async () => {
    const { packageDir, linkPath } = peerFixture("package-copy");
    writePackage(linkPath, { name: "not-openclaw" });
    const warnings: string[] = [];
    const result = await linkOpenClawPeerDependencies({
      ...peerInstall(packageDir),
      peerDependencies: { openclaw: ">=2026.0.0" },
      logger: {
        warn: (message) => warnings.push(message),
      },
    });
    expect(result).toEqual({ repaired: 0, skipped: 1 });
    expect(fs.existsSync(path.join(linkPath, "package.json"))).toBe(true);
    expect(warnings.join("\n")).toContain("already exists and is not a symlink");
  });

  it.runIf(process.platform !== "win32").each(["manifest", "node_modules"])(
    "does not follow a registered plugin %s symlink outside its package root",
    async (boundary) => {
      const { root, packageDir, linkPath } = peerFixture(
        boundary === "manifest" ? "package-copy" : "missing-modules",
        true,
      );
      const outsideModules = path.join(root, "outside-node-modules");
      const outsideHost = path.join(outsideModules, "openclaw");
      writePackage(outsideHost, { name: "openclaw", peerDependencies: { openclaw: "*" } });
      if (boundary === "manifest") {
        fs.unlinkSync(path.join(packageDir, "package.json"));
        fs.symlinkSync(
          path.join(outsideHost, "package.json"),
          path.join(packageDir, "package.json"),
          "file",
        );
      } else {
        fs.symlinkSync(outsideModules, path.join(packageDir, "node_modules"), "dir");
      }
      const onPackageReadError = vi.fn((_error: unknown, _failedDir: string) => {});
      const warnings: string[] = [];
      const result = await reconcileRegisteredOpenClawHostLinks({
        ...registeredRepair(packageDir),
        ...(boundary === "manifest"
          ? { onPackageReadError }
          : { logger: { warn: (message: string) => warnings.push(message) } }),
      });
      expect(result.repaired).toBe(0);
      if (boundary === "manifest") {
        expect(onPackageReadError.mock.calls[0]?.[1]).toBe(packageDir);
        expect(fs.lstatSync(linkPath).isDirectory()).toBe(true);
      } else {
        expect(fs.lstatSync(outsideHost).isDirectory()).toBe(true);
        expect(warnings.join("\n")).toContain("is not a real directory");
      }
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
      const { packageDir, linkPath } = peerFixture("package-copy", true, root);
      writeJson(path.join(packageDir, "package.json"), {
        name: "email",
        dependencies: { openclaw: "2026.7.1" },
      });
      const result = await reconcileRegisteredOpenClawHostLinks(registeredRepair(packageDir));

      expect(result.repaired).toBe(1);
      expectHostLink(linkPath);
    },
  );
});
