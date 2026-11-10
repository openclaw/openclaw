import fs from "node:fs";
import path from "node:path";
import { expect, it, vi, type Mock } from "vitest";
import { resolvePluginNpmProjectDir } from "./install-paths.js";

export function readTextFileTree(dir: string, rootDir = dir): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      Object.assign(files, readTextFileTree(entryPath, rootDir));
    } else if (entry.isFile()) {
      files[path.relative(rootDir, entryPath)] = fs.readFileSync(entryPath, "utf8");
    }
  }
  return files;
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
      fs.rmSync(path.join(packageNodeModulesDir, "openclaw"), { recursive: true, force: true });
    }
  }
}

function writeDependency(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "required-runtime", version: "1.0.0" }),
  );
}

type PackageFixture = { npmRoot: string; packageName: string; version: string };

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
  writeInstalledNpmPlugin: (params: PackageFixture & { indexJs?: string }) => void;
  mockNpmViewAndInstall: (
    params: PackageFixture & {
      spec: string;
      dependency?: { name: string; version: string };
    },
  ) => void;
  runCommandWithTimeoutMock: Mock;
  resolveOpenClawPackageRootSyncMock: Mock;
  installPluginFromNpmSpec: typeof import("./install.js").installPluginFromNpmSpec;
  resolveTestPluginPackageDir: (npmRoot: string, packageName: string) => string;
  isManagedNpmInstallCommand: (argv: unknown) => argv is string[];
}) {
  function fixture(packageName: string, dependency: { name: string; version: string }) {
    const npmRoot = path.join(makeTempDir(), "npm");
    const spec = packageName + "@1.0.0";
    const npmProjectRoot = resolvePluginNpmProjectDir({ npmDir: npmRoot, packageName });
    const onBeforePluginArtifactCommit = vi.fn(async () => {});
    const install = (options: Partial<Parameters<typeof installPluginFromNpmSpec>[0]> = {}) =>
      installPluginFromNpmSpec({
        spec,
        npmDir: npmRoot,
        onBeforePluginArtifactCommit,
        logger: { info: () => {}, warn: () => {} },
        ...options,
      });
    const seed = (name: string, version: string, indexJs?: string) =>
      writeInstalledNpmPlugin({ npmRoot: npmProjectRoot, packageName: name, version, indexJs });
    mockNpmViewAndInstall({ spec, packageName, version: "1.0.0", npmRoot, dependency });
    return { npmRoot, npmProjectRoot, onBeforePluginArtifactCommit, seed, install };
  }

  it.each([
    ["ancestor", "update", true, 45_000, 45_000],
    ["outside-symlink", "update", true, null, undefined],
    ["hoisted", "install", false, undefined, 300_000],
    ["optional", "update", true, undefined, undefined],
  ] as const)(
    "verifies %s dependency payload during %s (existing project: %s, timeout: %s -> %s)",
    async (payload, mode, existingProject, workTimeoutMs, expectedTimeoutMs) => {
      const packageName = "dependency-payload-plugin";
      const { npmRoot, npmProjectRoot, onBeforePluginArtifactCommit, seed, install } = fixture(
        packageName,
        { name: "required-runtime", version: "1.0.0" },
      );
      if (existingProject) {
        seed("existing-package", "1.0.0", "export const preserved = true;");
        fs.writeFileSync(path.join(npmProjectRoot, "package.json"), '{"private":true}\n');
        fs.writeFileSync(path.join(npmProjectRoot, "package-lock.json"), '{"lockfileVersion":3}\n');
      }
      if (mode === "update") {
        seed(packageName, "0.9.0", "export const previousVersion = true;");
      }
      const projectBefore = existingProject ? readTextFileTree(npmProjectRoot) : undefined;

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
            if (payload === "ancestor" || payload === "outside-symlink") {
              const outsideDir = path.join(npmRoot, "node_modules", "required-runtime");
              writeDependency(outsideDir);
              if (payload === "outside-symlink") {
                fs.symlinkSync(outsideDir, dependencyDir, "junction");
              }
            } else if (payload === "hoisted") {
              writeDependency(path.join(attemptRoot, "node_modules", "required-runtime"));
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
      const result = await install({ mode, workTimeoutMs });

      const installs = runCommandWithTimeoutMock.mock.calls.filter(([argv]) =>
        isManagedNpmInstallCommand(argv),
      );
      expect(installs).toHaveLength(1);
      expect(installs[0]?.[1]?.timeoutMs).toBe(expectedTimeoutMs);

      const shouldInstall = payload === "hoisted" || payload === "optional";
      expect(result, JSON.stringify(result)).toMatchObject(
        shouldInstall
          ? { ok: true }
          : { ok: false, error: expect.stringContaining("required-runtime") },
      );
      if (shouldInstall) {
        expect(onBeforePluginArtifactCommit).toHaveBeenCalledOnce();
        expect(fs.existsSync(resolveTestPluginPackageDir(npmRoot, packageName))).toBe(true);
      } else {
        expect(result).toMatchObject({ error: expect.stringContaining("required-runtime") });
        expect(onBeforePluginArtifactCommit).not.toHaveBeenCalled();
        expect(readTextFileTree(npmProjectRoot)).toEqual(projectBefore);
      }
    },
  );

  it("preserves the canonical host for a direct declaration during update", async () => {
    const packageName = "host-dependency-plugin";
    const { npmProjectRoot, onBeforePluginArtifactCommit, seed, install } = fixture(packageName, {
      name: "openclaw",
      version: "*",
    });
    seed(packageName, "0.9.0");
    fs.writeFileSync(path.join(npmProjectRoot, "package.json"), '{"private":true}\n');
    const result = await install({ mode: "update" });

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
  });
}
