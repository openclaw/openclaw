// Managed npm dependency fixtures share the installer suite's subprocess boundary.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi, type Mock } from "vitest";
import { resolvePluginNpmProjectDir } from "./install-paths.js";

export function readTextFileTree(dir: string, rootDir = dir): Record<string, string> {
  return Object.fromEntries(
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        return Object.entries(readTextFileTree(entryPath, rootDir));
      }
      if (!entry.isFile()) {
        return [];
      }
      return [[path.relative(rootDir, entryPath), fs.readFileSync(entryPath, "utf8")]];
    }),
  );
}

export function prunePluginLocalOpenClawPeerLinks(npmRoot: string) {
  const nodeModulesDir = path.join(npmRoot, "node_modules");
  if (!fs.existsSync(nodeModulesDir)) {
    return;
  }
  for (const entry of fs.readdirSync(nodeModulesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const entryPath = path.join(nodeModulesDir, entry.name);
    const packageDirs = entry.name.startsWith("@")
      ? fs
          .readdirSync(entryPath, { withFileTypes: true })
          .filter((scopedEntry) => scopedEntry.isDirectory())
          .map((scopedEntry) => path.join(entryPath, scopedEntry.name))
      : [entryPath];
    for (const packageDir of packageDirs) {
      const packageNodeModulesDir = path.join(packageDir, "node_modules");
      const packageNodeModules = fs.existsSync(packageNodeModulesDir)
        ? fs.lstatSync(packageNodeModulesDir)
        : null;
      if (packageNodeModules && !packageNodeModules.isDirectory()) {
        continue;
      }
      fs.rmSync(path.join(packageNodeModulesDir, "openclaw"), {
        recursive: true,
        force: true,
      });
    }
  }
}

export function registerManagedNpmDependencyTests({
  makeTempDir,
  writeInstalledNpmPlugin,
  mockNpmViewAndInstall,
  runCommandWithTimeoutMock,
  resolveOpenClawPackageRootSyncMock,
  installPluginFromNpmSpec,
  resolveTestPluginPackageDir,
  isManagedNpmInstallCommand,
}: {
  makeTempDir: () => string;
  writeInstalledNpmPlugin: (params: {
    npmRoot: string;
    packageName: string;
    version: string;
    indexJs?: string;
  }) => void;
  mockNpmViewAndInstall: (params: {
    spec: string;
    packageName: string;
    version: string;
    npmRoot: string;
    dependency?: { name: string; version: string };
    peerDependencies?: Record<string, string>;
  }) => void;
  runCommandWithTimeoutMock: Mock;
  resolveOpenClawPackageRootSyncMock: Mock;
  installPluginFromNpmSpec: typeof import("./install.js").installPluginFromNpmSpec;
  resolveTestPluginPackageDir: (npmRoot: string, packageName: string) => string;
  isManagedNpmInstallCommand: (argv: unknown) => argv is string[];
}) {
  const dependencyCases = [
    { payload: "missing", mode: "install", existingProject: false },
    { payload: "empty", mode: "install", existingProject: false },
    { payload: "missing", mode: "install", existingProject: true },
    { payload: "empty", mode: "install", existingProject: true },
    { payload: "ancestor", mode: "install", existingProject: false },
    { payload: "ancestor", mode: "install", existingProject: true },
    { payload: "outside-symlink", mode: "install", existingProject: false },
    { payload: "outside-symlink", mode: "install", existingProject: true },
    { payload: "hoisted", mode: "install", existingProject: false },
    { payload: "optional", mode: "install", existingProject: false },
    { payload: "missing", mode: "update", existingProject: true },
    { payload: "empty", mode: "update", existingProject: true },
    { payload: "ancestor", mode: "update", existingProject: true },
    { payload: "outside-symlink", mode: "update", existingProject: true },
    { payload: "hoisted", mode: "update", existingProject: true },
    { payload: "optional", mode: "update", existingProject: true },
  ] as const;
  it.each([
    ...dependencyCases.map(({ payload, mode, existingProject }) => ({
      payload,
      mode,
      existingProject,
      budgetCase: "legacy",
      workTimeoutMs: undefined as number | null | undefined,
      expectedTimeoutMs: undefined as number | undefined,
    })),
    {
      payload: "missing",
      mode: "install",
      existingProject: true,
      budgetCase: "install-default",
      workTimeoutMs: undefined,
      expectedTimeoutMs: 300_000,
    },
    {
      payload: "missing",
      mode: "update",
      existingProject: true,
      budgetCase: "update-default",
      workTimeoutMs: undefined,
      expectedTimeoutMs: undefined,
    },
    {
      payload: "missing",
      mode: "update",
      existingProject: true,
      budgetCase: "finite",
      workTimeoutMs: 45_000,
      expectedTimeoutMs: 45_000,
    },
    {
      payload: "missing",
      mode: "update",
      existingProject: true,
      budgetCase: "unbounded",
      workTimeoutMs: null,
      expectedTimeoutMs: undefined,
    },
  ] as const)(
    "verifies $payload dependency payload after npm success during $mode (existing project: $existingProject; work budget: $budgetCase)",
    async ({ payload, mode, existingProject, budgetCase, workTimeoutMs, expectedTimeoutMs }) => {
      const npmRoot = path.join(makeTempDir(), "npm");
      const packageName = "dependency-payload-plugin";
      const spec = `${packageName}@1.0.0`;
      const npmProjectRoot = resolvePluginNpmProjectDir({ npmDir: npmRoot, packageName });
      if (existingProject) {
        writeInstalledNpmPlugin({
          npmRoot: npmProjectRoot,
          packageName: "existing-package",
          version: "1.0.0",
          indexJs: "export const preserved = true;",
        });
        fs.writeFileSync(path.join(npmProjectRoot, "package.json"), '{"private":true}\n');
        fs.writeFileSync(path.join(npmProjectRoot, "package-lock.json"), '{"lockfileVersion":3}\n');
      }
      if (mode === "update") {
        writeInstalledNpmPlugin({
          npmRoot: npmProjectRoot,
          packageName,
          version: "0.9.0",
          indexJs: "export const previousVersion = true;",
        });
      }
      const projectBefore = existingProject ? readTextFileTree(npmProjectRoot) : undefined;
      mockNpmViewAndInstall({
        spec,
        packageName,
        version: "1.0.0",
        npmRoot,
        dependency: { name: "required-runtime", version: "1.0.0" },
      });
      const delegate = runCommandWithTimeoutMock.getMockImplementation();
      runCommandWithTimeoutMock.mockImplementation(
        async (argv: string[], options?: { cwd?: string }) => {
          const result = await delegate?.(argv, options);
          if (isManagedNpmInstallCommand(argv)) {
            const attemptRoot = options?.cwd;
            if (!attemptRoot) {
              throw new Error("Expected the managed npm installation directory");
            }
            const pluginDir = path.join(attemptRoot, "node_modules", packageName);
            expect(fs.existsSync(path.join(pluginDir, "package.json"))).toBe(true);
            const dependencyDir = path.join(pluginDir, "node_modules", "required-runtime");
            fs.rmSync(dependencyDir, { recursive: true, force: true });
            if (payload === "empty") {
              fs.mkdirSync(dependencyDir);
            } else if (payload === "ancestor" || payload === "outside-symlink") {
              const outsideDir = path.join(npmRoot, "node_modules", "required-runtime");
              fs.mkdirSync(outsideDir, { recursive: true });
              fs.writeFileSync(
                path.join(outsideDir, "package.json"),
                JSON.stringify({ name: "required-runtime", version: "1.0.0" }),
              );
              if (payload === "outside-symlink") {
                fs.symlinkSync(outsideDir, dependencyDir, "junction");
              }
            } else if (payload === "hoisted") {
              const hoistedDir = path.join(attemptRoot, "node_modules", "required-runtime");
              fs.mkdirSync(hoistedDir, { recursive: true });
              fs.writeFileSync(
                path.join(hoistedDir, "package.json"),
                JSON.stringify({ name: "required-runtime", version: "1.0.0" }),
              );
            } else if (payload === "optional") {
              const manifestPath = path.join(pluginDir, "package.json");
              const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
                optionalDependencies?: Record<string, string>;
              };
              manifest.optionalDependencies = { "required-runtime": "2.0.0" };
              fs.writeFileSync(manifestPath, JSON.stringify(manifest));
            }
          }
          return result;
        },
      );
      const onBeforePluginArtifactCommit = vi.fn(async () => {});

      const result = await installPluginFromNpmSpec({
        spec,
        npmDir: npmRoot,
        mode,
        workTimeoutMs,
        onBeforePluginArtifactCommit,
        logger: { info: () => {}, warn: () => {} },
      });

      if (budgetCase !== "legacy") {
        const installs = runCommandWithTimeoutMock.mock.calls.filter(([argv]) =>
          isManagedNpmInstallCommand(argv),
        );
        expect(installs).toHaveLength(1);
        expect(installs[0]?.[1]?.timeoutMs).toBe(expectedTimeoutMs);
      }

      const shouldInstall = payload === "hoisted" || payload === "optional";
      expect(result, JSON.stringify(result)).toMatchObject({ ok: shouldInstall });
      if (shouldInstall) {
        expect(onBeforePluginArtifactCommit).toHaveBeenCalledOnce();
        expect(fs.existsSync(resolveTestPluginPackageDir(npmRoot, packageName))).toBe(true);
      } else {
        expect(result).toMatchObject({
          ok: false,
          error: expect.stringContaining("required-runtime"),
        });
        expect(onBeforePluginArtifactCommit).not.toHaveBeenCalled();
        expect(
          runCommandWithTimeoutMock.mock.calls.filter(([argv]) => isManagedNpmInstallCommand(argv)),
        ).toHaveLength(1);
        if (existingProject) {
          expect(readTextFileTree(npmProjectRoot)).toEqual(projectBefore);
        } else {
          expect(fs.existsSync(npmProjectRoot)).toBe(false);
        }
      }
    },
  );

  describe.each(["install", "update"] as const)("host dependency during %s", (mode) => {
    it.each(["direct", "peer", "both"] as const)(
      "preserves the canonical host for a %s declaration",
      async (declaration) => {
        const npmRoot = path.join(makeTempDir(), "npm");
        const packageName = "host-dependency-plugin";
        const npmProjectRoot = resolvePluginNpmProjectDir({ npmDir: npmRoot, packageName });
        if (mode === "update") {
          writeInstalledNpmPlugin({
            npmRoot: npmProjectRoot,
            packageName,
            version: "0.9.0",
          });
          fs.writeFileSync(path.join(npmProjectRoot, "package.json"), '{"private":true}\n');
        }
        mockNpmViewAndInstall({
          spec: `${packageName}@1.0.0`,
          packageName,
          version: "1.0.0",
          npmRoot,
          ...(declaration !== "peer" ? { dependency: { name: "openclaw", version: "*" } } : {}),
          ...(declaration !== "direct" ? { peerDependencies: { openclaw: "*" } } : {}),
        });
        const onBeforePluginArtifactCommit = vi.fn(async () => {});

        const result = await installPluginFromNpmSpec({
          spec: `${packageName}@1.0.0`,
          npmDir: npmRoot,
          mode,
          onBeforePluginArtifactCommit,
          logger: { info: () => {}, warn: () => {} },
        });

        expect(result, JSON.stringify(result)).toMatchObject({ ok: true, pluginId: packageName });
        if (!result.ok) {
          return;
        }
        expect(onBeforePluginArtifactCommit).toHaveBeenCalledOnce();
        const hostLink = path.join(result.targetDir, "node_modules", "openclaw");
        expect(fs.lstatSync(hostLink).isSymbolicLink()).toBe(true);
        expect(fs.realpathSync(hostLink)).toBe(
          fs.realpathSync(resolveOpenClawPackageRootSyncMock.mock.results[0]?.value),
        );
        expect(
          runCommandWithTimeoutMock.mock.calls.filter(([argv]) => isManagedNpmInstallCommand(argv)),
        ).toHaveLength(1);
      },
    );
  });
}
