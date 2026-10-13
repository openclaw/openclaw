// Covers package dist inventory collection and validation.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import { describe, expect, it, vi } from "vitest";
import {
  isLegacyPluginDependencyInstallStagePath,
  LOCAL_BUILD_METADATA_DIST_PATHS,
  writePackageDistInventory,
  writePackageDistInventoryForPublish,
} from "../../scripts/lib/package-dist-inventory.ts";
import { PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH } from "../../scripts/lib/package-lifecycle-marker.mjs";
import { withTestDir } from "../test-helpers/temp-dir.js";
import {
  collectPackageDistContentInventory,
  collectPackageDistInventory,
  readPackageDistInventoryIfPresent,
} from "./package-dist-inventory.js";

async function writeFiles(packageRoot: string, paths: readonly string[], content = "export {};\n") {
  for (const relativePath of paths) {
    const filePath = path.join(packageRoot, relativePath);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, "utf8");
  }
}

describe("package dist inventory", () => {
  it("retains binary digests, byte counts, modes, and allowed package hardlinks", async () => {
    await withTestDir({ prefix: "openclaw-dist-content-inventory-" }, async (packageRoot) => {
      const distDir = path.join(packageRoot, "dist");
      const binaryPath = path.join(distDir, "binary.js");
      const binary = Buffer.alloc(128 * 1024 + 7, 0xa5);
      binary[0] = 0;
      binary[binary.length - 1] = 0xff;
      await fs.mkdir(distDir);
      await fs.writeFile(binaryPath, binary);
      await fs.chmod(binaryPath, 0o751);
      await fs.link(binaryPath, path.join(distDir, "linked.js"));
      await fs.writeFile(path.join(distDir, "empty.js"), "", { mode: 0o600 });
      const binaryEntry = {
        sha256: createHash("sha256").update(binary).digest("hex"),
        size: binary.byteLength,
        mode: process.platform === "win32" ? (await fs.stat(binaryPath)).mode & 0o777 : 0o751,
      };
      await expect(collectPackageDistContentInventory(packageRoot)).resolves.toEqual([
        { path: "dist/binary.js", ...binaryEntry },
        {
          path: "dist/empty.js",
          sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
          size: 0,
          mode:
            process.platform === "win32"
              ? (await fs.stat(path.join(distDir, "empty.js"))).mode & 0o777
              : 0o600,
        },
        { path: "dist/linked.js", ...binaryEntry },
      ]);
    });
  });

  it.each(["content", "inventory", "publication"] as const)(
    "rejects symlinked entries at the %s boundary",
    async (boundary) => {
      await withTestDir({ prefix: "openclaw-dist-inventory-link-" }, async (packageRoot) => {
        const publishing = boundary === "publication";
        const entry = publishing ? "dist/extensions/browser" : "dist/entry.js";
        const target = path.join(packageRoot, "outside");
        await fs.mkdir(path.dirname(path.join(packageRoot, entry)), { recursive: true });
        if (publishing) {
          await fs.mkdir(path.join(target, ".openclaw-install-stage"), { recursive: true });
        } else {
          await fs.writeFile(target, "outside");
        }
        await fs.symlink(
          publishing ? target : "../outside",
          path.join(packageRoot, entry),
          publishing && process.platform === "win32" ? "junction" : publishing ? "dir" : "file",
        );
        if (boundary === "content") {
          await expect(
            collectPackageDistContentInventory(packageRoot, [entry]),
          ).rejects.toMatchObject({ code: "symlink" });
        } else {
          await expect(
            publishing
              ? writePackageDistInventoryForPublish(packageRoot)
              : collectPackageDistInventory(packageRoot),
          ).rejects.toThrow(`Unsafe package dist path: ${entry}`);
        }
        if (publishing) {
          await expect(
            fs.access(path.join(packageRoot, PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH)),
          ).rejects.toMatchObject({ code: "ENOENT" });
        }
      });
    },
  );

  it("hashes the complete file when it outgrows the admitted small-file buffer", async () => {
    await withTestDir({ prefix: "openclaw-dist-content-growth-" }, async (packageRoot) => {
      const filePath = path.join(packageRoot, "dist", "growing.js");
      const grown = Buffer.alloc(128 * 1024 + 7, 0x71);
      await fs.mkdir(path.dirname(filePath));
      await fs.writeFile(filePath, "small");
      let replaced = false;
      __setFsSafeTestHooksForTest({
        beforeRootReadFinalFence: async (openedPath) => {
          if (!replaced && path.basename(openedPath) === "growing.js") {
            replaced = true;
            await fs.writeFile(filePath, grown);
          }
        },
      });
      try {
        await expect(collectPackageDistContentInventory(packageRoot)).resolves.toEqual([
          expect.objectContaining({
            path: "dist/growing.js",
            sha256: createHash("sha256").update(grown).digest("hex"),
            size: grown.byteLength,
          }),
        ]);
        expect(replaced).toBe(true);
      } finally {
        __setFsSafeTestHooksForTest();
      }
    });
  });

  it("tracks missing and stale files while keeping lifecycle state outside the inventory", async () => {
    await withTestDir({ prefix: "openclaw-dist-inventory-" }, async (packageRoot) => {
      const currentFile = path.join(packageRoot, "dist", "current-BR6xv1a1.js");
      await fs.mkdir(path.dirname(currentFile), { recursive: true });
      await fs.writeFile(currentFile, "export {};\n", "utf8");

      await expect(readPackageDistInventoryIfPresent(packageRoot)).resolves.toBeNull();
      await expect(writePackageDistInventoryForPublish(packageRoot)).resolves.toEqual([
        "dist/current-BR6xv1a1.js",
        "dist/postinstall-content-inventory.json",
      ]);
      await expect(readPackageDistInventoryIfPresent(packageRoot)).resolves.toStrictEqual([
        "dist/current-BR6xv1a1.js",
        "dist/postinstall-content-inventory.json",
      ]);

      await expect(collectPackageDistInventory(packageRoot)).resolves.toEqual([
        "dist/current-BR6xv1a1.js",
        "dist/postinstall-content-inventory.json",
      ]);
      await expect(
        fs.readFile(path.join(packageRoot, PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH), "utf8"),
      ).resolves.toBe("pending\n");
      await fs.rm(currentFile);
      await fs.writeFile(
        path.join(packageRoot, "dist", "stale-CJUAgRQR.js"),
        "export {};\n",
        "utf8",
      );

      await expect(collectPackageDistInventory(packageRoot)).resolves.toEqual([
        "dist/postinstall-content-inventory.json",
        "dist/stale-CJUAgRQR.js",
      ]);
    });
  });

  it("omits build and dependency artifacts while retaining packaged runtime files", async () => {
    await withTestDir({ prefix: "openclaw-dist-inventory-pack-" }, async (packageRoot) => {
      await writeFiles(packageRoot, [
        "dist/extensions/qa-channel/runtime-api.js",
        "dist/extensions/qa-lab/runtime-api.js",
        "dist/extensions/qa-channel/cli.js",
        "dist/extensions/qa-lab/cli.js",
        "dist/plugin-sdk/qa-lab.js",
        "dist/plugin-sdk/qa-channel.js",
        "dist/plugin-sdk/qa-channel-protocol.js",
        "dist/plugin-sdk/extensions/qa-lab/cli.d.ts",
        "dist/plugin-sdk/src/plugin-sdk/provider-entry.d.ts",
        "dist/plugin-sdk/provider-entry.d.ts",
        "dist/qa-runtime-B9LDtssJ.js",
        "dist/extensions/demo/runtime-api.js",
        "dist/extensions/node_modules/openclaw/package.json",
        "dist/extensions/demo/node_modules/left-pad/package.json",
      ]);
      await writeFiles(packageRoot, LOCAL_BUILD_METADATA_DIST_PATHS, "{}\n");
      await writeFiles(packageRoot, ["dist/feature.runtime.js.map"], "{}");
      await expect(writePackageDistInventory(packageRoot)).resolves.toStrictEqual([
        "dist/extensions/demo/runtime-api.js",
        "dist/plugin-sdk/provider-entry.d.ts",
        "dist/postinstall-content-inventory.json",
      ]);
    });
  });

  it.each([
    { exclusion: "!dist/OpenClaw.app/**", app: "dist/OpenClaw.app" },
    { exclusion: "!dist/**/*.app/**", app: "dist/.stage/OpenClaw.app" },
    { exclusion: "!dist/OpenClaw.app", app: "dist/OpenClaw.app" },
    { exclusion: "!dist/**/*.app", app: "dist/.stage/OpenClaw.app" },
  ])(
    "honors package files exclusions ($exclusion) when writing the dist inventory",
    async ({ exclusion, app }) => {
      await withTestDir(
        { prefix: "openclaw-dist-inventory-package-files-" },
        async (packageRoot) => {
          const omittedAppBundle = path.join(packageRoot, app);
          await fs.mkdir(omittedAppBundle, { recursive: true });
          await fs.writeFile(
            path.join(packageRoot, "package.json"),
            JSON.stringify({
              files: [
                "dist/",
                exclusion,
                "!dist/plugin-sdk/plugin-test-runtime.js",
                "!dist/plugin-sdk/plugin-test-runtime.d.ts",
                "!dist/plugin-sdk/src/test-utils/**",
                "!dist/plugin-sdk/qa-channel.*",
                "!dist/qa-runtime-*.js",
                "!dist/**/*.map",
              ],
            }),
            "utf8",
          );
          await writeFiles(packageRoot, [
            "dist/plugin-sdk/runtime.js",
            "dist/plugin-sdk/plugin-test-runtime.js",
            "dist/plugin-sdk/plugin-test-runtime.d.ts",
            "dist/plugin-sdk/src/test-utils/helpers.d.ts",
            "dist/plugin-sdk/qa-channel.js",
            "dist/qa-runtime-AbC123.js",
          ]);
          await writeFiles(
            packageRoot,
            ["dist/runtime.js.map", "dist/plugin-sdk/runtime.js.map"],
            "{}",
          );
          await fs.symlink(packageRoot, path.join(omittedAppBundle, "Autoupdate"));

          await expect(writePackageDistInventory(packageRoot)).resolves.toEqual([
            "dist/plugin-sdk/runtime.js",
            "dist/postinstall-content-inventory.json",
          ]);
        },
      );
    },
  );

  it("omits interrupted Control UI build siblings through the root package files list", async () => {
    const { files } = JSON.parse(await fs.readFile(path.resolve("package.json"), "utf8"));
    await withTestDir({ prefix: "openclaw-dist-inventory-ui-staging-" }, async (packageRoot) => {
      await fs.writeFile(path.join(packageRoot, "package.json"), JSON.stringify({ files }), "utf8");
      await writeFiles(packageRoot, [
        "dist/control-ui/index.html",
        "dist/control-ui.build-123-AbCdEf/assets/index.js",
        "dist/control-ui.build-123-AbCdEf.retired/index.html",
      ]);

      await expect(writePackageDistInventory(packageRoot)).resolves.toEqual([
        "dist/control-ui/index.html",
        "dist/postinstall-content-inventory.json",
      ]);
    });
  });

  it.each([
    { entry: "index.js", excluded: true },
    { entry: "", excluded: true },
    { entry: "index.js", excluded: false },
  ])(
    "inventories a publishable plugin entry $entry (excluded=$excluded)",
    async ({ entry, excluded }) => {
      await withTestDir({ prefix: "openclaw-dist-inventory-plugins-" }, async (packageRoot) => {
        await writeFiles(packageRoot, [
          path.join("dist/extensions/published-chat", entry),
          "dist/extensions/bundled-chat/index.js",
        ]);
        for (const [name, openclaw] of [
          ["published-chat", { release: { publishToClawHub: true, publishToNpm: true } }],
          ["bundled-chat", {}],
        ] as const) {
          await writeFiles(
            packageRoot,
            [`extensions/${name}/package.json`],
            JSON.stringify({ name: `@openclaw/${name}`, openclaw }),
          );
        }
        if (excluded) {
          await fs.writeFile(
            path.join(packageRoot, "package.json"),
            JSON.stringify({
              files: ["dist/", "!dist/extensions/published-chat/**"],
            }),
          );
        }
        await expect(writePackageDistInventory(packageRoot)).resolves.toEqual([
          "dist/extensions/bundled-chat/index.js",
          ...(excluded ? [] : ["dist/extensions/published-chat/index.js"]),
          "dist/postinstall-content-inventory.json",
        ]);
      });
    },
  );

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

  it.each(["directory", "file", "symlink", "mixed-case"] as const)(
    "rejects install-stage %s debris before changing published inventory artifacts",
    async (kind) => {
      await withTestDir({ prefix: "openclaw-dist-inventory-stage-" }, async (packageRoot) => {
        const stagePath = path.join(
          packageRoot,
          kind === "mixed-case"
            ? "Dist/Extensions/browser/.OPENCLAW-INSTALL-STAGE-AbC123"
            : "dist/extensions/browser/.openclaw-install-stage-AbC123",
        );
        await fs.mkdir(path.dirname(stagePath), { recursive: true });
        if (kind === "directory" || kind === "mixed-case") {
          await fs.mkdir(stagePath);
          await fs.writeFile(path.join(stagePath, "package.json"), "{}");
        } else if (kind === "file") {
          await fs.writeFile(stagePath, "debris");
        } else {
          await fs.symlink(
            packageRoot,
            stagePath,
            process.platform === "win32" ? "junction" : "dir",
          );
        }
        const artifacts = [
          "dist/postinstall-inventory.json",
          "dist/postinstall-content-inventory.json",
          PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH,
        ];
        await fs.mkdir(path.join(packageRoot, "dist"), { recursive: true });
        for (const artifact of artifacts) {
          await fs.writeFile(path.join(packageRoot, artifact), "previous publication\n");
        }
        await expect(writePackageDistInventoryForPublish(packageRoot)).rejects.toThrow(
          /unexpected legacy plugin dependency staging debris/u,
        );
        for (const artifact of artifacts) {
          await expect(fs.readFile(path.join(packageRoot, artifact), "utf8")).resolves.toBe(
            "previous publication\n",
          );
        }
      });
    },
  );

  it.each(["ENOENT", "ENOTDIR", "EACCES"])(
    "preserves %s scan failure handling before publication",
    async (code) => {
      await withTestDir(
        { prefix: "openclaw-dist-inventory-scan-failure-" },
        async (packageRoot) => {
          const failure = Object.assign(new Error("inventory scan failed"), { code });
          const scan = vi.spyOn(fs, "readdir").mockRejectedValueOnce(failure);
          try {
            if (code === "ENOENT") {
              await expect(writePackageDistInventoryForPublish(packageRoot)).resolves.toEqual([
                "dist/postinstall-content-inventory.json",
              ]);
            } else {
              await expect(writePackageDistInventoryForPublish(packageRoot)).rejects.toBe(failure);
              await expect(fs.access(path.join(packageRoot, "dist"))).rejects.toMatchObject({
                code: "ENOENT",
              });
              await expect(
                fs.access(path.join(packageRoot, PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH)),
              ).rejects.toMatchObject({ code: "ENOENT" });
            }
          } finally {
            scan.mockRestore();
          }
        },
      );
    },
  );

  it("only treats plugin-root install stages as dependency staging debris", async () => {
    await withTestDir({ prefix: "openclaw-dist-inventory-stage-depth-" }, async (packageRoot) => {
      const files = [
        "dist/extensions/.openclaw-install-stage/index.js",
        "dist/extensions/browser/assets/.openclaw-install-stage/index.js",
      ];
      for (const file of files) {
        await fs.mkdir(path.dirname(path.join(packageRoot, file)), { recursive: true });
        await fs.writeFile(path.join(packageRoot, file), "export {};\n");
      }
      await expect(writePackageDistInventory(packageRoot)).resolves.toEqual([
        ...files,
        "dist/postinstall-content-inventory.json",
      ]);
    });
  });
});
