// Covers package dist inventory collection and validation.
import fs from "node:fs/promises";
import path from "node:path";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import {
  isLegacyPluginDependencyInstallStagePath,
  LOCAL_BUILD_METADATA_DIST_PATHS,
  PACKAGE_INSTALL_GUARD_RELATIVE_PATH,
  writePackageDistInventory,
  writePackageDistInventoryForPublish,
} from "../../scripts/lib/package-dist-inventory.ts";
import { withTempDir } from "../test-helpers/temp-dir.js";
import {
  collectPackageDistContentInventory,
  collectPackageDistContentInventoryErrors,
  collectPackageDistInventory,
  readPackageDistContentInventoryIfPresent,
  readPackageDistInventoryIfPresent,
} from "./package-dist-inventory.js";

describe("package dist inventory", () => {
  it("tracks missing and stale dist files", async () => {
    await withTempDir({ prefix: "openclaw-dist-inventory-" }, async (packageRoot) => {
      const currentFile = path.join(packageRoot, "dist", "current-BR6xv1a1.js");
      await fs.mkdir(path.dirname(currentFile), { recursive: true });
      await fs.writeFile(currentFile, "export {};\n", "utf8");

      await expect(writePackageDistInventory(packageRoot)).resolves.toEqual([
        "dist/current-BR6xv1a1.js",
      ]);
      await expect(readPackageDistInventoryIfPresent(packageRoot)).resolves.toStrictEqual([
        "dist/current-BR6xv1a1.js",
      ]);

      await fs.rm(currentFile);
      await fs.writeFile(
        path.join(packageRoot, "dist", "stale-CJUAgRQR.js"),
        "export {};\n",
        "utf8",
      );

      await expect(collectPackageDistInventory(packageRoot)).resolves.toEqual([
        "dist/stale-CJUAgRQR.js",
      ]);
    });
  });

  it("writes content hashes beside the path inventory", async () => {
    await withTempDir({ prefix: "openclaw-dist-content-inventory-" }, async (packageRoot) => {
      const currentFile = path.join(packageRoot, "dist", "current.js");
      await fs.mkdir(path.dirname(currentFile), { recursive: true });
      await fs.writeFile(currentFile, "export const value = 1;\n", "utf8");

      await writePackageDistInventory(packageRoot);

      const contentInventory = await readPackageDistContentInventoryIfPresent(packageRoot);
      expect(contentInventory).toHaveLength(1);
      expect(contentInventory?.[0]?.path).toBe("dist/current.js");
      expect(contentInventory?.[0]?.sha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(contentInventory?.[0]?.size).toBe("export const value = 1;\n".length);
    });
  });

  it.runIf(process.platform !== "win32")(
    "rejects content inventories through symlinked dist roots",
    async () => {
      await withTempDir(
        { prefix: "openclaw-dist-content-inventory-symlink-root-" },
        async (base) => {
          const packageRoot = path.join(base, "package");
          const outsideDist = path.join(base, "outside-dist");
          await fs.mkdir(packageRoot);
          await fs.mkdir(outsideDist);
          await fs.writeFile(
            path.join(outsideDist, "postinstall-content-inventory.json"),
            "[]\n",
            "utf8",
          );
          await fs.symlink(outsideDist, path.join(packageRoot, "dist"), "dir");

          await expect(readPackageDistContentInventoryIfPresent(packageRoot)).rejects.toThrow(
            "Unsafe package dist path: dist",
          );
        },
      );
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects content hash reads after the dist root swaps outside the package",
    async () => {
      await withTempDir({ prefix: "openclaw-dist-content-inventory-swap-root-" }, async (base) => {
        const packageRoot = path.join(base, "package");
        const distDir = path.join(packageRoot, "dist");
        const preservedDistDir = path.join(packageRoot, "preserved-dist");
        const currentFile = path.join(distDir, "current.js");
        const outsideDist = path.join(base, "outside-dist");
        await fs.mkdir(distDir, { recursive: true });
        await fs.writeFile(currentFile, "export const value = 1;\n", "utf8");
        await writePackageDistInventory(packageRoot);
        await fs.mkdir(outsideDist);
        await fs.writeFile(
          path.join(outsideDist, "current.js"),
          "export const value = 1;\n",
          "utf8",
        );

        const realLstat = fs.lstat.bind(fs);
        let distRootChanged = false;
        const currentFileSuffix = path.join("dist", "current.js");
        const replaceDistRoot = async () => {
          if (distRootChanged) {
            return;
          }
          distRootChanged = true;
          await fs.rename(distDir, preservedDistDir);
          await fs.symlink(outsideDist, distDir, "dir");
        };
        const lstatSpy = vi.spyOn(fs, "lstat").mockImplementation(async (...args) => {
          const result = await realLstat(...args);
          if (!distRootChanged && String(args[0]).endsWith(currentFileSuffix)) {
            await replaceDistRoot();
          }
          return result;
        });
        __setFsSafeTestHooksForTest({
          afterPreOpenLstat: async (filePath) => {
            if (filePath.endsWith(currentFileSuffix)) {
              await replaceDistRoot();
            }
          },
        });

        try {
          await expect(collectPackageDistContentInventoryErrors(packageRoot)).rejects.toThrow();
          expect(distRootChanged).toBe(true);
        } finally {
          __setFsSafeTestHooksForTest(undefined);
          lstatSpy.mockRestore();
        }
      });
    },
  );

  it("rejects duplicate normalized content inventory paths", async () => {
    await withTempDir(
      { prefix: "openclaw-dist-content-inventory-duplicate-" },
      async (packageRoot) => {
        const currentFile = path.join(packageRoot, "dist", "current.js");
        await fs.mkdir(path.dirname(currentFile), { recursive: true });
        await fs.writeFile(currentFile, "export const value = 1;\n", "utf8");
        await writePackageDistInventory(packageRoot);

        const contentInventory = await readPackageDistContentInventoryIfPresent(packageRoot);
        const entry = contentInventory?.[0];
        if (!entry) {
          throw new Error("expected content inventory entry");
        }
        await fs.writeFile(
          path.join(packageRoot, "dist", "postinstall-content-inventory.json"),
          `${JSON.stringify([entry, { ...entry, path: "dist\\current.js" }], null, 2)}\n`,
          "utf8",
        );

        await expect(readPackageDistContentInventoryIfPresent(packageRoot)).rejects.toThrow(
          "Invalid package dist content inventory",
        );
      },
    );
  });

  it("bounds concurrent content inventory hash reads", async () => {
    await withTempDir(
      { prefix: "openclaw-dist-content-inventory-concurrency-" },
      async (packageRoot) => {
        const inventory = Array.from(
          { length: 40 },
          (_, index) => `dist/file-${String(index).padStart(2, "0")}.js`,
        );
        await fs.mkdir(path.join(packageRoot, "dist"), { recursive: true });
        await Promise.all(
          inventory.map((relativePath) =>
            fs.writeFile(path.join(packageRoot, relativePath), "export {};\n", "utf8"),
          ),
        );

        let activeReads = 0;
        let maxActiveReads = 0;
        __setFsSafeTestHooksForTest({
          beforeOpen: async (filePath) => {
            if (!filePath.includes(`${path.sep}dist${path.sep}file-`)) {
              return;
            }
            activeReads += 1;
            maxActiveReads = Math.max(maxActiveReads, activeReads);
            await new Promise<void>((resolve) => {
              setTimeout(resolve, 5);
            });
            activeReads -= 1;
          },
        });

        try {
          await expect(
            collectPackageDistContentInventory(packageRoot, inventory),
          ).resolves.toHaveLength(inventory.length);
        } finally {
          __setFsSafeTestHooksForTest(undefined);
        }
        expect(maxActiveReads).toBeGreaterThan(1);
        expect(maxActiveReads).toBeLessThanOrEqual(32);
      },
    );
  });

  it("reports stale content hashes", async () => {
    await withTempDir({ prefix: "openclaw-dist-content-inventory-stale-" }, async (packageRoot) => {
      const currentFile = path.join(packageRoot, "dist", "current.js");
      await fs.mkdir(path.dirname(currentFile), { recursive: true });
      await fs.writeFile(currentFile, "export const value = 1;\n", "utf8");

      await writePackageDistInventory(packageRoot);
      await fs.writeFile(currentFile, "export const value = 2;\n", "utf8");

      await expect(collectPackageDistContentInventoryErrors(packageRoot)).resolves.toEqual([
        expect.stringContaining("Invalid package dist content inventory"),
      ]);
    });
  });

  it("does not treat mode-only content inventory differences as stale content", async () => {
    await withTempDir({ prefix: "openclaw-dist-content-inventory-mode-" }, async (packageRoot) => {
      const currentFile = path.join(packageRoot, "dist", "current.js");
      await fs.mkdir(path.dirname(currentFile), { recursive: true });
      await fs.writeFile(currentFile, "export const value = 1;\n", "utf8");

      await writePackageDistInventory(packageRoot);
      const contentInventory = await readPackageDistContentInventoryIfPresent(packageRoot);
      expect(contentInventory).toHaveLength(1);
      const contentInventoryPath = path.join(
        packageRoot,
        "dist",
        "postinstall-content-inventory.json",
      );
      await fs.writeFile(
        contentInventoryPath,
        `${JSON.stringify([{ ...contentInventory?.[0], mode: 0 }], null, 2)}\n`,
        "utf8",
      );

      await expect(collectPackageDistContentInventoryErrors(packageRoot)).resolves.toStrictEqual(
        [],
      );
    });
  });

  it.runIf(process.platform !== "win32")(
    "reports executable-bit content inventory differences",
    async () => {
      await withTempDir(
        { prefix: "openclaw-dist-content-inventory-executable-" },
        async (packageRoot) => {
          const currentFile = path.join(packageRoot, "dist", "current.js");
          await fs.mkdir(path.dirname(currentFile), { recursive: true });
          await fs.writeFile(currentFile, "export const value = 1;\n", "utf8");

          await writePackageDistInventory(packageRoot);
          const contentInventory = await readPackageDistContentInventoryIfPresent(packageRoot);
          expect(contentInventory).toHaveLength(1);
          const contentInventoryPath = path.join(
            packageRoot,
            "dist",
            "postinstall-content-inventory.json",
          );
          await fs.writeFile(
            contentInventoryPath,
            `${JSON.stringify([{ ...contentInventory?.[0], mode: 0o755 }], null, 2)}\n`,
            "utf8",
          );

          await expect(collectPackageDistContentInventoryErrors(packageRoot)).resolves.toEqual([
            expect.stringContaining("executable bits"),
          ]);
        },
      );
    },
  );

  it.runIf(process.platform !== "win32")(
    "reports distinct executable-bit content inventory masks",
    async () => {
      await withTempDir(
        { prefix: "openclaw-dist-content-inventory-executable-mask-" },
        async (packageRoot) => {
          const currentFile = path.join(packageRoot, "dist", "current.js");
          await fs.mkdir(path.dirname(currentFile), { recursive: true });
          await fs.writeFile(currentFile, "export const value = 1;\n", "utf8");
          await fs.chmod(currentFile, 0o700);

          await writePackageDistInventory(packageRoot);
          const contentInventory = await readPackageDistContentInventoryIfPresent(packageRoot);
          expect(contentInventory).toHaveLength(1);
          const contentInventoryPath = path.join(
            packageRoot,
            "dist",
            "postinstall-content-inventory.json",
          );
          await fs.writeFile(
            contentInventoryPath,
            `${JSON.stringify([{ ...contentInventory?.[0], mode: 0o755 }], null, 2)}\n`,
            "utf8",
          );

          await expect(collectPackageDistContentInventoryErrors(packageRoot)).resolves.toEqual([
            expect.stringContaining("executable bits"),
          ]);
        },
      );
    },
  );

  it.runIf(process.platform !== "win32")(
    "ignores executable-bit content inventory differences on Windows",
    async () => {
      await withTempDir(
        { prefix: "openclaw-dist-content-inventory-windows-mode-" },
        async (packageRoot) => {
          const currentFile = path.join(packageRoot, "dist", "current.js");
          await fs.mkdir(path.dirname(currentFile), { recursive: true });
          await fs.writeFile(currentFile, "export const value = 1;\n", "utf8");

          await writePackageDistInventory(packageRoot);
          const contentInventory = await readPackageDistContentInventoryIfPresent(packageRoot);
          expect(contentInventory).toHaveLength(1);
          const contentInventoryPath = path.join(
            packageRoot,
            "dist",
            "postinstall-content-inventory.json",
          );
          await fs.writeFile(
            contentInventoryPath,
            `${JSON.stringify([{ ...contentInventory?.[0], mode: 0o755 }], null, 2)}\n`,
            "utf8",
          );

          const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
          try {
            await expect(
              collectPackageDistContentInventoryErrors(packageRoot),
            ).resolves.toStrictEqual([]);
          } finally {
            platformSpy.mockRestore();
          }
        },
      );
    },
  );

  it.each([
    "1000.1.1",
    "2025.12.31",
    "2026.1.28",
    "2026.2.30",
    "2026.6.7",
    "2026.6.8-beta.3",
    "2026.6.10-alpha.3",
    "2026.7.1",
  ])("requires content inventory for post-cutover package version %s", async (version) => {
    await withTempDir(
      { prefix: "openclaw-dist-content-inventory-required-" },
      async (packageRoot) => {
        const currentFile = path.join(packageRoot, "dist", "current.js");
        await fs.mkdir(path.dirname(currentFile), { recursive: true });
        await fs.writeFile(currentFile, "export const value = 1;\n", "utf8");
        await fs.writeFile(
          path.join(packageRoot, "package.json"),
          JSON.stringify({ name: "openclaw", version }),
          "utf8",
        );
        await writePackageDistInventory(packageRoot);
        await fs.rm(path.join(packageRoot, "dist", "postinstall-content-inventory.json"));

        await expect(collectPackageDistContentInventoryErrors(packageRoot)).resolves.toStrictEqual([
          "missing package dist content inventory dist/postinstall-content-inventory.json",
        ]);
      },
    );
  });

  it.each([
    "2026.6.6",
    "2026.6.6-beta.2",
    "2026.6.7-alpha.6",
    "2026.6.7-beta.1",
    "2026.6.8-alpha.2",
    "2026.6.8-beta.1",
    "2026.6.8-beta.2",
    "2026.6.8",
    "2026.6.9-alpha.4",
    "2026.6.9-alpha.5",
    "2026.6.9-beta.1",
    "2026.6.9",
    "2026.6.10-alpha.2",
    "2026.6.10-beta.1",
    "2026.6.10-beta.2",
    "2026.6.10",
    "2026.6.11-beta.1",
    "2026.6.11-beta.2",
    "2026.6.11",
    "2026.6.15-alpha.1",
    "2026.7.1-beta.1",
    "2026.7.1-beta.2",
    "2026.7.1-beta.4",
    "2026.7.1-beta.5",
  ])("allows already-published package version %s without content inventory", async (version) => {
    await withTempDir(
      { prefix: "openclaw-dist-content-inventory-legacy-" },
      async (packageRoot) => {
        const currentFile = path.join(packageRoot, "dist", "current.js");
        await fs.mkdir(path.dirname(currentFile), { recursive: true });
        await fs.writeFile(currentFile, "export const value = 1;\n", "utf8");
        await fs.writeFile(
          path.join(packageRoot, "package.json"),
          JSON.stringify({ name: "openclaw", version }),
          "utf8",
        );
        await writePackageDistInventory(packageRoot);
        await fs.rm(path.join(packageRoot, "dist", "postinstall-content-inventory.json"));

        await expect(collectPackageDistContentInventoryErrors(packageRoot)).resolves.toStrictEqual(
          [],
        );
      },
    );
  });

  it("keeps the pending install guard outside the expected inventory", async () => {
    await withTempDir({ prefix: "openclaw-dist-install-guard-" }, async (packageRoot) => {
      const currentFile = path.join(packageRoot, "dist", "current.js");
      await fs.mkdir(path.dirname(currentFile), { recursive: true });
      await fs.writeFile(currentFile, "export {};\n", "utf8");

      await expect(writePackageDistInventoryForPublish(packageRoot)).resolves.toEqual([
        "dist/current.js",
      ]);
      await expect(collectPackageDistInventory(packageRoot)).resolves.toEqual([
        "dist/current.js",
        PACKAGE_INSTALL_GUARD_RELATIVE_PATH,
      ]);
      await expect(readPackageDistInventoryIfPresent(packageRoot)).resolves.toEqual([
        "dist/current.js",
      ]);
      await expect(
        fs.readFile(path.join(packageRoot, PACKAGE_INSTALL_GUARD_RELATIVE_PATH), "utf8"),
      ).resolves.toContain("preinstall has not completed");
    });
  });

  it("keeps npm-omitted dist artifacts out of the inventory", async () => {
    await withTempDir({ prefix: "openclaw-dist-inventory-pack-" }, async (packageRoot) => {
      const packagedQaChannelRuntime = path.join(
        packageRoot,
        "dist",
        "extensions",
        "qa-channel",
        "runtime-api.js",
      );
      const packagedQaLabRuntime = path.join(
        packageRoot,
        "dist",
        "extensions",
        "qa-lab",
        "runtime-api.js",
      );
      const omittedQaChunk = path.join(packageRoot, "dist", "extensions", "qa-channel", "cli.js");
      const omittedQaLabChunk = path.join(packageRoot, "dist", "extensions", "qa-lab", "cli.js");
      const omittedQaLabPluginSdk = path.join(packageRoot, "dist", "plugin-sdk", "qa-lab.js");
      const omittedQaChannelPluginSdk = path.join(
        packageRoot,
        "dist",
        "plugin-sdk",
        "qa-channel.js",
      );
      const omittedQaChannelProtocolPluginSdk = path.join(
        packageRoot,
        "dist",
        "plugin-sdk",
        "qa-channel-protocol.js",
      );
      const omittedQaLabTypes = path.join(
        packageRoot,
        "dist",
        "plugin-sdk",
        "extensions",
        "qa-lab",
        "cli.d.ts",
      );
      const omittedDeepPluginSdkDeclaration = path.join(
        packageRoot,
        "dist",
        "plugin-sdk",
        "src",
        "plugin-sdk",
        "provider-entry.d.ts",
      );
      const flatPluginSdkDeclaration = path.join(
        packageRoot,
        "dist",
        "plugin-sdk",
        "provider-entry.d.ts",
      );
      const omittedQaRuntimeChunk = path.join(packageRoot, "dist", "qa-runtime-B9LDtssJ.js");
      const [omittedBuildStamp, omittedRuntimePostBuildStamp] = LOCAL_BUILD_METADATA_DIST_PATHS.map(
        (relativePath) => path.join(packageRoot, relativePath),
      );
      const packagedMap = path.join(packageRoot, "dist", "feature.runtime.js.map");
      await fs.mkdir(path.dirname(packagedQaChannelRuntime), { recursive: true });
      await fs.mkdir(path.dirname(packagedQaLabRuntime), { recursive: true });
      await fs.mkdir(path.dirname(omittedQaLabTypes), { recursive: true });
      await fs.mkdir(path.join(packageRoot, "dist", "plugin-sdk"), { recursive: true });
      await fs.mkdir(path.dirname(omittedDeepPluginSdkDeclaration), { recursive: true });
      await fs.writeFile(packagedQaChannelRuntime, "export {};\n", "utf8");
      await fs.writeFile(packagedQaLabRuntime, "export {};\n", "utf8");
      await fs.writeFile(omittedQaChunk, "export {};\n", "utf8");
      await fs.writeFile(omittedQaLabChunk, "export {};\n", "utf8");
      await fs.writeFile(omittedQaLabPluginSdk, "export {};\n", "utf8");
      await fs.writeFile(omittedQaChannelPluginSdk, "export {};\n", "utf8");
      await fs.writeFile(omittedQaChannelProtocolPluginSdk, "export {};\n", "utf8");
      await fs.writeFile(omittedQaLabTypes, "export {};\n", "utf8");
      await fs.writeFile(omittedDeepPluginSdkDeclaration, "export {};\n", "utf8");
      await fs.writeFile(flatPluginSdkDeclaration, "export {};\n", "utf8");
      await fs.writeFile(omittedQaRuntimeChunk, "export {};\n", "utf8");
      await fs.writeFile(
        expectDefined(omittedBuildStamp, "omittedBuildStamp test invariant"),
        "{}\n",
        "utf8",
      );
      await fs.writeFile(
        expectDefined(omittedRuntimePostBuildStamp, "omittedRuntimePostBuildStamp test invariant"),
        "{}\n",
        "utf8",
      );
      await fs.writeFile(packagedMap, "{}", "utf8");

      await expect(writePackageDistInventory(packageRoot)).resolves.toStrictEqual([
        "dist/feature.runtime.js.map",
        "dist/plugin-sdk/provider-entry.d.ts",
      ]);
    });
  });

  it("honors package files exclusions when writing the dist inventory", async () => {
    await withTempDir({ prefix: "openclaw-dist-inventory-package-files-" }, async (packageRoot) => {
      const packagedRuntime = path.join(packageRoot, "dist", "plugin-sdk", "runtime.js");
      const omittedTestRuntime = path.join(
        packageRoot,
        "dist",
        "plugin-sdk",
        "plugin-test-runtime.js",
      );
      const omittedTestTypes = path.join(
        packageRoot,
        "dist",
        "plugin-sdk",
        "plugin-test-runtime.d.ts",
      );
      const omittedNestedHelper = path.join(
        packageRoot,
        "dist",
        "plugin-sdk",
        "src",
        "test-utils",
        "helpers.d.ts",
      );
      const omittedQaCompat = path.join(packageRoot, "dist", "plugin-sdk", "qa-channel.js");
      const omittedRuntimeChunk = path.join(packageRoot, "dist", "qa-runtime-AbC123.js");
      const omittedTopLevelMap = path.join(packageRoot, "dist", "runtime.js.map");
      const omittedMap = path.join(packageRoot, "dist", "plugin-sdk", "runtime.js.map");
      const packageExcludedRuntime = path.join(packageRoot, "dist", "local-runtime.js");
      const packageExcludedAsset = path.join(packageRoot, "dist", "local-assets", "theme.css");
      const omittedAppBundle = path.join(packageRoot, "dist", "OpenClaw.app");

      await fs.mkdir(path.dirname(packagedRuntime), { recursive: true });
      await fs.mkdir(path.dirname(omittedNestedHelper), { recursive: true });
      await fs.mkdir(path.dirname(packageExcludedAsset), { recursive: true });
      await fs.mkdir(omittedAppBundle, { recursive: true });
      await fs.writeFile(
        path.join(packageRoot, "package.json"),
        JSON.stringify({
          files: [
            "dist/",
            "!dist/OpenClaw.app/**",
            "!dist/plugin-sdk/plugin-test-runtime.js",
            "!dist/plugin-sdk/plugin-test-runtime.d.ts",
            "!dist/plugin-sdk/src/test-utils/**",
            "!dist/plugin-sdk/qa-channel.*",
            "!dist/qa-runtime-*.js",
            "!dist/**/*.map",
            "!dist/local-runtime.js",
            "!dist/local-assets/**",
          ],
        }),
        "utf8",
      );
      await fs.writeFile(packagedRuntime, "export {};\n", "utf8");
      await fs.writeFile(omittedTestRuntime, "export {};\n", "utf8");
      await fs.writeFile(omittedTestTypes, "export {};\n", "utf8");
      await fs.writeFile(omittedNestedHelper, "export {};\n", "utf8");
      await fs.writeFile(omittedQaCompat, "export {};\n", "utf8");
      await fs.writeFile(omittedRuntimeChunk, "export {};\n", "utf8");
      await fs.writeFile(omittedTopLevelMap, "{}", "utf8");
      await fs.writeFile(omittedMap, "{}", "utf8");
      await fs.writeFile(packageExcludedRuntime, "export const local = true;\n", "utf8");
      await fs.writeFile(packageExcludedAsset, "body {}\n", "utf8");
      await fs.symlink(packageRoot, path.join(omittedAppBundle, "Autoupdate"));

      await expect(writePackageDistInventory(packageRoot)).resolves.toEqual([
        "dist/plugin-sdk/runtime.js",
      ]);
      await expect(
        collectPackageDistInventory(packageRoot, { includePackageExcludedFiles: true }),
      ).resolves.toEqual([
        "dist/local-assets/theme.css",
        "dist/local-runtime.js",
        "dist/plugin-sdk/runtime.js",
        "dist/plugin-sdk/runtime.js.map",
        "dist/runtime.js.map",
      ]);
    });
  });

  it("keeps transient plugin dependency trees out of the inventory", async () => {
    await withTempDir({ prefix: "openclaw-dist-inventory-plugin-deps-" }, async (packageRoot) => {
      const realFile = path.join(packageRoot, "dist", "index.js");
      const rootDependencyPackage = path.join(
        packageRoot,
        "dist",
        "extensions",
        "node_modules",
        "openclaw",
        "package.json",
      );
      const pluginDependencyPackage = path.join(
        packageRoot,
        "dist",
        "extensions",
        "slack",
        "node_modules",
        "left-pad",
        "package.json",
      );
      await fs.mkdir(path.dirname(realFile), { recursive: true });
      await fs.mkdir(path.dirname(rootDependencyPackage), { recursive: true });
      await fs.mkdir(path.dirname(pluginDependencyPackage), { recursive: true });
      await fs.writeFile(realFile, "export {};\n", "utf8");
      await fs.writeFile(rootDependencyPackage, "{}", "utf8");
      await fs.writeFile(pluginDependencyPackage, "{}", "utf8");

      await expect(writePackageDistInventory(packageRoot)).resolves.toEqual(["dist/index.js"]);
    });
  });

  it("omits packaged extension node_modules while keeping extension runtime files", async () => {
    await withTempDir(
      { prefix: "openclaw-dist-inventory-extension-node-modules-" },
      async (packageRoot) => {
        const extensionRuntime = path.join(
          packageRoot,
          "dist",
          "extensions",
          "demo",
          "runtime-api.js",
        );
        const rootSdkAliasPackage = path.join(
          packageRoot,
          "dist",
          "extensions",
          "node_modules",
          "openclaw",
          "package.json",
        );
        const extensionDependencyPackage = path.join(
          packageRoot,
          "dist",
          "extensions",
          "demo",
          "node_modules",
          "left-pad",
          "package.json",
        );

        await fs.mkdir(path.dirname(extensionRuntime), { recursive: true });
        await fs.mkdir(path.dirname(rootSdkAliasPackage), { recursive: true });
        await fs.mkdir(path.dirname(extensionDependencyPackage), { recursive: true });
        await fs.writeFile(extensionRuntime, "export {};\n", "utf8");
        await fs.writeFile(rootSdkAliasPackage, "{}", "utf8");
        await fs.writeFile(extensionDependencyPackage, "{}", "utf8");

        await expect(writePackageDistInventory(packageRoot)).resolves.toEqual([
          "dist/extensions/demo/runtime-api.js",
        ]);
      },
    );
  });

  it("keeps publishable externalized bundled plugin dist trees out of the inventory", async () => {
    await withTempDir({ prefix: "openclaw-dist-inventory-externalized-" }, async (packageRoot) => {
      const externalizedRuntime = path.join(
        packageRoot,
        "dist",
        "extensions",
        "external-chat",
        "index.js",
      );
      const bundledRuntime = path.join(
        packageRoot,
        "dist",
        "extensions",
        "bundled-chat",
        "index.js",
      );
      const externalizedPackageJson = path.join(
        packageRoot,
        "extensions",
        "external-chat",
        "package.json",
      );
      const bundledPackageJson = path.join(
        packageRoot,
        "extensions",
        "bundled-chat",
        "package.json",
      );
      const rootPackageJson = path.join(packageRoot, "package.json");

      await fs.mkdir(path.dirname(externalizedRuntime), { recursive: true });
      await fs.mkdir(path.dirname(bundledRuntime), { recursive: true });
      await fs.mkdir(path.dirname(externalizedPackageJson), { recursive: true });
      await fs.mkdir(path.dirname(bundledPackageJson), { recursive: true });
      await fs.writeFile(externalizedRuntime, "export {};\n", "utf8");
      await fs.writeFile(bundledRuntime, "export {};\n", "utf8");
      await fs.writeFile(
        rootPackageJson,
        JSON.stringify({
          files: ["dist/", "!dist/extensions/external-chat/**"],
        }),
        "utf8",
      );
      await fs.writeFile(
        externalizedPackageJson,
        JSON.stringify({
          name: "@openclaw/external-chat",
          openclaw: {
            release: {
              publishToClawHub: true,
              publishToNpm: true,
            },
          },
        }),
        "utf8",
      );
      await fs.writeFile(
        bundledPackageJson,
        JSON.stringify({
          name: "@openclaw/bundled-chat",
          openclaw: {},
        }),
        "utf8",
      );

      await expect(writePackageDistInventory(packageRoot)).resolves.toEqual([
        "dist/extensions/bundled-chat/index.js",
      ]);
    });
  });

  it("keeps publishable core-package runtime plugin dist trees in the inventory", async () => {
    await withTempDir({ prefix: "openclaw-dist-inventory-core-runtime-" }, async (packageRoot) => {
      const coreRuntime = path.join(packageRoot, "dist", "extensions", "core-chat", "index.js");
      const corePackageJson = path.join(packageRoot, "extensions", "core-chat", "package.json");

      await fs.mkdir(path.dirname(coreRuntime), { recursive: true });
      await fs.mkdir(path.dirname(corePackageJson), { recursive: true });
      await fs.writeFile(coreRuntime, "export {};\n", "utf8");
      await fs.writeFile(
        corePackageJson,
        JSON.stringify({
          name: "@openclaw/core-chat",
          openclaw: {
            release: {
              publishToClawHub: true,
              publishToNpm: true,
            },
          },
        }),
        "utf8",
      );

      await expect(writePackageDistInventory(packageRoot)).resolves.toEqual([
        "dist/extensions/core-chat/index.js",
      ]);
    });
  });

  it("matches install-stage paths case-insensitively across path segments", () => {
    expect(
      isLegacyPluginDependencyInstallStagePath(
        "dist/extensions/brave/.openclaw-install-stage/node_modules/typebox/package.json",
      ),
    ).toBe(true);
    expect(
      isLegacyPluginDependencyInstallStagePath(
        "dist/Extensions/browser/.OPENCLAW-INSTALL-STAGE-AbC123/node_modules/playwright-core/package.json",
      ),
    ).toBe(true);
    expect(
      isLegacyPluginDependencyInstallStagePath(
        "Dist/Extensions/browser/.OpenClaw-Install-Stage/package.json",
      ),
    ).toBe(true);
    expect(
      isLegacyPluginDependencyInstallStagePath(
        "dist/extensions/browser/.openclaw-runtime-deps-copy-AbC123/package.json",
      ),
    ).toBe(false);
    expect(
      isLegacyPluginDependencyInstallStagePath("dist/extensions/.openclaw-install-stage"),
    ).toBe(false);
  });

  it("rejects pre-populated install-stage debris before writing an inventory", async () => {
    await withTempDir({ prefix: "openclaw-dist-inventory-stage-" }, async (packageRoot) => {
      for (const relativePath of [
        "dist/extensions/brave/.openclaw-install-stage/package.json",
        "dist/extensions/browser/.openclaw-install-stage-AbC123/node_modules/playwright-core/package.json",
      ]) {
        const filePath = path.join(packageRoot, relativePath);
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, "{}", "utf8");
      }

      await expect(writePackageDistInventory(packageRoot)).rejects.toThrow(
        /unexpected legacy plugin dependency staging debris/u,
      );
    });
  });

  it("rejects mixed-case install-stage debris on case-sensitive builders", async () => {
    await withTempDir({ prefix: "openclaw-dist-inventory-stage-case-" }, async (packageRoot) => {
      const stagedFile = path.join(
        packageRoot,
        "Dist",
        "Extensions",
        "browser",
        ".OPENCLAW-INSTALL-STAGE-AbC123",
        "package.json",
      );
      await fs.mkdir(path.dirname(stagedFile), { recursive: true });
      await fs.writeFile(stagedFile, "{}", "utf8");

      await expect(writePackageDistInventory(packageRoot)).rejects.toThrow(
        /unexpected legacy plugin dependency staging debris/u,
      );
    });
  });

  it("returns null when the inventory is missing", async () => {
    await withTempDir({ prefix: "openclaw-dist-inventory-missing-" }, async (packageRoot) => {
      await fs.mkdir(path.join(packageRoot, "dist"), { recursive: true });
      await expect(readPackageDistInventoryIfPresent(packageRoot)).resolves.toBeNull();
    });
  });

  it("rejects symlinked dist entries", async () => {
    await withTempDir({ prefix: "openclaw-dist-inventory-symlink-" }, async (packageRoot) => {
      const distDir = path.join(packageRoot, "dist");
      await fs.mkdir(distDir, { recursive: true });
      await fs.writeFile(path.join(packageRoot, "escape.js"), "export {};\n", "utf8");
      await fs.symlink(path.join(packageRoot, "escape.js"), path.join(distDir, "entry.js"));

      await expect(collectPackageDistInventory(packageRoot)).rejects.toThrow(
        "Unsafe package dist path: dist/entry.js",
      );
    });
  });
});
