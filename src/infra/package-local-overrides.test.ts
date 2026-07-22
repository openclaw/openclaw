// Covers capture and replay of local package overrides.
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { configureFsSafePython, getFsSafePythonConfig } from "@openclaw/fs-safe/config";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { writePackageDistInventory } from "../../scripts/lib/package-dist-inventory.ts";
import { withTempDir } from "../test-helpers/temp-dir.js";
import {
  applyLocalPackageOverrides,
  captureLocalPackageOverrides,
} from "./package-local-overrides.js";

const originalStateDir = process.env.OPENCLAW_STATE_DIR;
let packageUpdateTestStateDir = "";

beforeAll(async () => {
  packageUpdateTestStateDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "openclaw-package-update-state-"),
  );
  process.env.OPENCLAW_STATE_DIR = packageUpdateTestStateDir;
});

afterAll(async () => {
  if (originalStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = originalStateDir;
  }
  await fs.rm(packageUpdateTestStateDir, { recursive: true, force: true });
});

async function writePackageRoot(packageRoot: string, version: string): Promise<void> {
  await fs.mkdir(path.join(packageRoot, "dist"), { recursive: true });
  await Promise.all([
    fs.writeFile(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "openclaw", version }),
      "utf8",
    ),
    fs.writeFile(path.join(packageRoot, "dist", "index.js"), "export {};\n", "utf8"),
  ]);
  await writePackageDistInventory(packageRoot);
}

async function expectPathMissing(filePath: string): Promise<void> {
  try {
    await fs.access(filePath);
  } catch (error) {
    expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
    return;
  }
  throw new Error(`Expected missing path: ${filePath}`);
}

describe("local package overrides", () => {
  it("rejects recovery roots inside the package being updated", async () => {
    await withTempDir({ prefix: "openclaw-package-update-local-recovery-root-" }, async (base) => {
      const packageRoot = path.join(base, "package");
      const indexPath = path.join(packageRoot, "dist", "index.js");
      await writePackageRoot(packageRoot, "1.0.0");
      await fs.writeFile(indexPath, "export const local = true;\n", "utf8");

      const priorStateDir = process.env.OPENCLAW_STATE_DIR;
      process.env.OPENCLAW_STATE_DIR = path.join(packageRoot, "state");
      try {
        await expect(captureLocalPackageOverrides({ packageRoot })).rejects.toThrow(
          "local override recovery root must be outside package root",
        );
      } finally {
        if (priorStateDir === undefined) {
          delete process.env.OPENCLAW_STATE_DIR;
        } else {
          process.env.OPENCLAW_STATE_DIR = priorStateDir;
        }
      }
      await expectPathMissing(path.join(packageRoot, "state"));
    });
  });

  it.runIf(process.platform !== "win32")(
    "does not capture override payloads through symlinked source ancestors",
    async () => {
      await withTempDir(
        { prefix: "openclaw-package-update-local-capture-symlink-ancestor-" },
        async (base) => {
          const packageRoot = path.join(base, "package");
          const distPath = path.join(packageRoot, "dist");
          const preservedDistPath = path.join(packageRoot, "preserved-dist");
          const indexPath = path.join(distPath, "index.js");
          const outsideRoot = path.join(base, "outside");
          const outsideIndexPath = path.join(outsideRoot, "index.js");
          await writePackageRoot(packageRoot, "1.0.0");
          await fs.writeFile(indexPath, "export const local = true;\n", "utf8");
          await fs.mkdir(outsideRoot);
          await fs.writeFile(outsideIndexPath, "export const outside = true;\n", "utf8");

          let ancestorChanged = false;
          __setFsSafeTestHooksForTest({
            afterPreOpenLstat: async (filePath) => {
              if (!ancestorChanged && path.basename(filePath) === path.basename(indexPath)) {
                ancestorChanged = true;
                await fs.rename(distPath, preservedDistPath);
                await fs.symlink(outsideRoot, distPath, "dir");
              }
            },
          });

          try {
            await expect(captureLocalPackageOverrides({ packageRoot })).rejects.toMatchObject({
              code: expect.stringMatching(/outside-workspace|path-mismatch|symlink/),
            });
            expect(ancestorChanged).toBe(true);
            await expect(fs.readFile(outsideIndexPath, "utf8")).resolves.toBe(
              "export const outside = true;\n",
            );
          } finally {
            __setFsSafeTestHooksForTest(undefined);
          }
        },
      );
    },
  );

  it("does not classify baseline files replaced by directories as deletions", async () => {
    await withTempDir(
      { prefix: "openclaw-package-update-local-capture-non-file-" },
      async (base) => {
        const packageRoot = path.join(base, "package");
        const indexPath = path.join(packageRoot, "dist", "index.js");
        await writePackageRoot(packageRoot, "1.0.0");
        await fs.rm(indexPath);
        await fs.mkdir(indexPath);

        await expect(captureLocalPackageOverrides({ packageRoot })).rejects.toMatchObject({
          code: "not-file",
        });
        expect((await fs.stat(indexPath)).isDirectory()).toBe(true);
      },
    );
  });

  it.runIf(process.platform !== "win32")(
    "opens override capture reads nonblocking so unsupported entries cannot stall capture",
    async () => {
      await withTempDir(
        { prefix: "openclaw-package-update-local-capture-nonblocking-" },
        async (base) => {
          const packageRoot = path.join(base, "package");
          const indexPath = path.join(packageRoot, "dist", "index.js");
          await writePackageRoot(packageRoot, "1.0.0");
          await fs.writeFile(indexPath, "export const local = true;\n", "utf8");

          const openFlags: number[] = [];
          __setFsSafeTestHooksForTest({
            beforeOpen: (_filePath, flags) => {
              openFlags.push(flags);
            },
          });

          try {
            await expect(captureLocalPackageOverrides({ packageRoot })).resolves.not.toBeNull();
            expect(openFlags.length).toBeGreaterThan(0);
            expect(openFlags.every((flags) => (flags & fsConstants.O_NONBLOCK) !== 0)).toBe(true);
          } finally {
            __setFsSafeTestHooksForTest(undefined);
          }
        },
      );
    },
  );

  it.runIf(process.platform !== "win32")(
    "does not move updated targets when required fs-safe Python is unavailable",
    async () => {
      await withTempDir({ prefix: "openclaw-package-update-local-no-python-" }, async (base) => {
        const packageRoot = path.join(base, "package");
        const indexPath = path.join(packageRoot, "dist", "index.js");
        await writePackageRoot(packageRoot, "1.0.0");
        await fs.writeFile(indexPath, "export const local = true;\n", "utf8");

        const plan = await captureLocalPackageOverrides({ packageRoot });
        expect(plan).not.toBeNull();
        await writePackageRoot(packageRoot, "2.0.0");

        const previousPythonConfig = getFsSafePythonConfig();
        configureFsSafePython({
          mode: "off",
          pythonPath: path.join(base, "missing-python"),
        });
        try {
          const result = await applyLocalPackageOverrides({
            packageRoot,
            plan,
            reapply: true,
          });

          expect(result.status).toBe("error");
          expect(result.applied).toBe(0);
          expect(result.conflicts).toEqual([{ path: "dist/index.js", reason: "apply-failed" }]);
          await expect(fs.readFile(indexPath, "utf8")).resolves.toBe("export {};\n");
          expect(
            (await fs.readdir(path.dirname(indexPath))).filter((entry) =>
              entry.startsWith(".openclaw-override-"),
            ),
          ).toEqual([]);
        } finally {
          configureFsSafePython(previousPythonConfig);
        }
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "does not reapply added overrides through symlinked target ancestors",
    async () => {
      await withTempDir(
        { prefix: "openclaw-package-update-local-symlink-ancestor-" },
        async (base) => {
          const packageRoot = path.join(base, "package");
          const outsideRoot = path.join(base, "outside");
          const localAddedPath = path.join(packageRoot, "dist", "local", "added.js");
          await writePackageRoot(packageRoot, "1.0.0");
          await fs.mkdir(path.dirname(localAddedPath), { recursive: true });
          await fs.writeFile(localAddedPath, "export const local = true;\n", "utf8");

          const plan = await captureLocalPackageOverrides({ packageRoot });
          expect(plan).not.toBeNull();
          await fs.rm(path.join(packageRoot, "dist"), { recursive: true, force: true });
          await fs.mkdir(outsideRoot, { recursive: true });
          await fs.symlink(outsideRoot, path.join(packageRoot, "dist"), "dir");

          const result = await applyLocalPackageOverrides({
            packageRoot,
            plan,
            reapply: true,
          });

          expect(result.status).toBe("conflict");
          expect(result.applied).toBe(0);
          expect(result.conflicts).toEqual([
            { path: "dist/local/added.js", reason: "target-inspection-failed" },
          ]);
          await expectPathMissing(path.join(outsideRoot, "local", "added.js"));
        },
      );
    },
  );

  it.runIf(process.platform !== "win32")(
    "does not publish overrides when a target ancestor swaps at the final mutation boundary",
    async () => {
      await withTempDir(
        { prefix: "openclaw-package-update-local-publish-symlink-ancestor-" },
        async (base) => {
          const packageRoot = path.join(base, "package");
          const distPath = path.join(packageRoot, "dist");
          const preservedDistPath = path.join(packageRoot, "preserved-dist");
          const localAddedPath = path.join(distPath, "local.js");
          const outsideRoot = path.join(base, "outside");
          const outsideAddedPath = path.join(outsideRoot, "local.js");
          await writePackageRoot(packageRoot, "1.0.0");
          await fs.writeFile(localAddedPath, "export const local = true;\n", "utf8");

          const plan = await captureLocalPackageOverrides({ packageRoot });
          expect(plan).not.toBeNull();
          await writePackageRoot(packageRoot, "2.0.0");
          await fs.rm(localAddedPath);
          await writePackageDistInventory(packageRoot);
          await fs.mkdir(outsideRoot);

          const realRealpath = fs.realpath.bind(fs);
          let ancestorChanged = false;
          const realpathSpy = vi
            .spyOn(fs, "realpath")
            .mockImplementation(async (...args: Parameters<typeof fs.realpath>) => {
              const result = await realRealpath(...args);
              const entries =
                String(args[0]) === distPath
                  ? await fs.readdir(distPath).catch(() => [] as string[])
                  : [];
              if (
                !ancestorChanged &&
                entries.some((entry) => entry.startsWith(".openclaw-override-next-"))
              ) {
                ancestorChanged = true;
                await fs.rename(distPath, preservedDistPath);
                await fs.symlink(outsideRoot, distPath, "dir");
              }
              return result;
            });

          try {
            const result = await applyLocalPackageOverrides({
              packageRoot,
              plan,
              reapply: true,
            });

            expect(ancestorChanged).toBe(true);
            expect(result.status).toBe("error");
            expect(result.applied).toBe(0);
            await expectPathMissing(outsideAddedPath);
          } finally {
            realpathSpy.mockRestore();
          }
        },
      );
    },
  );

  it("does not reapply added overrides after the package root changes", async () => {
    await withTempDir({ prefix: "openclaw-package-update-local-root-swap-" }, async (base) => {
      const packageRoot = path.join(base, "package");
      const replacementRoot = path.join(base, "replacement");
      const preservedRoot = path.join(base, "preserved");
      const addedPath = path.join(packageRoot, "dist", "local.js");
      await writePackageRoot(packageRoot, "1.0.0");
      await fs.writeFile(addedPath, "export const local = true;\n", "utf8");

      const plan = await captureLocalPackageOverrides({ packageRoot });
      expect(plan).not.toBeNull();
      await writePackageRoot(packageRoot, "2.0.0");
      await fs.rm(addedPath);
      await writePackageDistInventory(packageRoot);
      await writePackageRoot(replacementRoot, "2.0.0");

      const realRealpath = fs.realpath.bind(fs);
      let rootChanged = false;
      const realpathSpy = vi
        .spyOn(fs, "realpath")
        .mockImplementation(async (...args: Parameters<typeof fs.realpath>) => {
          const result = await realRealpath(...args);
          if (!rootChanged && String(args[0]) === path.join(packageRoot, "dist")) {
            rootChanged = true;
            await fs.rename(packageRoot, preservedRoot);
            await fs.rename(replacementRoot, packageRoot);
          }
          return result;
        });

      try {
        const result = await applyLocalPackageOverrides({
          packageRoot,
          plan,
          reapply: true,
        });

        expect(rootChanged).toBe(true);
        expect(result.status).toBe("conflict");
        expect(result.applied).toBe(0);
        expect(result.conflicts).toEqual([
          { path: "dist/local.js", reason: "target-inspection-failed" },
        ]);
        await expectPathMissing(path.join(packageRoot, "dist", "local.js"));
        await expectPathMissing(path.join(preservedRoot, "dist", "local.js"));
      } finally {
        realpathSpy.mockRestore();
      }
    });
  });

  it.runIf(process.platform !== "win32").each([
    ["modified", "outside"],
    ["deleted", "outside"],
    ["added", "outside"],
    ["modified", "inside"],
    ["deleted", "inside"],
    ["added", "inside"],
  ] as const)(
    "does not reapply %s overrides after a target ancestor becomes an %s symlink",
    async (overrideKind, redirectKind) => {
      await withTempDir(
        {
          prefix: `openclaw-package-update-local-symlink-race-${overrideKind}-${redirectKind}-`,
        },
        async (base) => {
          const packageRoot = path.join(base, "package");
          const redirectRoot =
            redirectKind === "outside"
              ? path.join(base, "outside")
              : path.join(packageRoot, "redirect");
          const indexPath = path.join(packageRoot, "dist", "index.js");
          const addedPath = path.join(packageRoot, "dist", "local.js");
          const redirectIndexPath = path.join(redirectRoot, "index.js");
          const redirectAddedPath = path.join(redirectRoot, "local.js");
          await writePackageRoot(packageRoot, "1.0.0");
          if (overrideKind === "modified") {
            await fs.writeFile(indexPath, "export const local = true;\n", "utf8");
          } else if (overrideKind === "deleted") {
            await fs.rm(indexPath);
          } else {
            await fs.writeFile(addedPath, "export const local = true;\n", "utf8");
          }

          const plan = await captureLocalPackageOverrides({ packageRoot });
          expect(plan).not.toBeNull();
          await writePackageRoot(packageRoot, "2.0.0");
          if (overrideKind === "added") {
            await fs.rm(addedPath);
            await writePackageDistInventory(packageRoot);
          }
          await fs.mkdir(redirectRoot, { recursive: true });
          await fs.writeFile(redirectIndexPath, "export const redirect = true;\n", "utf8");

          const realMkdtemp = fs.mkdtemp.bind(fs);
          const mkdtempSpy = vi
            .spyOn(fs, "mkdtemp")
            .mockImplementation(async (prefixArg, options) => {
              if (prefixArg.endsWith(`${path.sep}rollback-`)) {
                await fs.rm(path.join(packageRoot, "dist"), { recursive: true, force: true });
                await fs.symlink(redirectRoot, path.join(packageRoot, "dist"), "dir");
              }
              return await realMkdtemp(prefixArg, options);
            });

          try {
            const result = await applyLocalPackageOverrides({
              packageRoot,
              plan,
              reapply: true,
            });

            expect(result.status).toBe("error");
            expect(result.applied).toBe(0);
            await expect(fs.readFile(redirectIndexPath, "utf8")).resolves.toBe(
              "export const redirect = true;\n",
            );
            await expectPathMissing(redirectAddedPath);
          } finally {
            mkdtempSpy.mockRestore();
          }
        },
      );
    },
  );

  it.runIf(process.platform !== "win32")(
    "does not hash replay targets after they are replaced with symlinks",
    async () => {
      await withTempDir(
        { prefix: "openclaw-package-update-local-hash-symlink-race-" },
        async (base) => {
          const packageRoot = path.join(base, "package");
          const indexPath = path.join(packageRoot, "dist", "index.js");
          const outsidePath = path.join(base, "outside.js");
          await writePackageRoot(packageRoot, "1.0.0");
          await fs.writeFile(indexPath, "export const local = true;\n", "utf8");

          const plan = await captureLocalPackageOverrides({ packageRoot });
          expect(plan).not.toBeNull();
          await writePackageRoot(packageRoot, "2.0.0");
          await fs.writeFile(outsidePath, "export const outside = true;\n", "utf8");
          const realIndexPath = await fs.realpath(indexPath);

          let targetReplaced = false;
          __setFsSafeTestHooksForTest({
            afterPreOpenLstat: async (filePath) => {
              if (!targetReplaced && filePath === realIndexPath) {
                targetReplaced = true;
                await fs.rm(indexPath);
                await fs.symlink(outsidePath, indexPath, "file");
              }
            },
          });

          try {
            const result = await applyLocalPackageOverrides({
              packageRoot,
              plan,
              reapply: true,
            });

            expect(targetReplaced).toBe(true);
            expect(result.status).toBe("conflict");
            expect(result.applied).toBe(0);
            expect(result.conflicts).toEqual([
              { path: "dist/index.js", reason: "target-inspection-failed" },
            ]);
            await expect(fs.readFile(outsidePath, "utf8")).resolves.toBe(
              "export const outside = true;\n",
            );
          } finally {
            __setFsSafeTestHooksForTest(undefined);
          }
        },
      );
    },
  );

  it.runIf(process.platform !== "win32").each(["modified", "deleted"] as const)(
    "does not reapply %s overrides over upstream mode changes",
    async (overrideKind) => {
      await withTempDir(
        { prefix: `openclaw-package-update-local-mode-${overrideKind}-` },
        async (base) => {
          const packageRoot = path.join(base, "package");
          const indexPath = path.join(packageRoot, "dist", "index.js");
          await writePackageRoot(packageRoot, "1.0.0");
          await fs.chmod(indexPath, 0o644);
          await writePackageDistInventory(packageRoot);
          if (overrideKind === "modified") {
            await fs.writeFile(indexPath, "export const local = true;\n", "utf8");
          } else {
            await fs.rm(indexPath);
          }

          const plan = await captureLocalPackageOverrides({ packageRoot });
          expect(plan).not.toBeNull();
          await fs.writeFile(indexPath, "export {};\n", "utf8");
          await fs.chmod(indexPath, 0o755);
          await writePackageDistInventory(packageRoot);

          const result = await applyLocalPackageOverrides({
            packageRoot,
            plan,
            reapply: true,
          });

          expect(result.status).toBe("conflict");
          expect(result.applied).toBe(0);
          expect(result.conflicts).toEqual([{ path: "dist/index.js", reason: "target-changed" }]);
          await expect(fs.readFile(indexPath, "utf8")).resolves.toBe("export {};\n");
          expect((await fs.stat(indexPath)).mode & 0o777).toBe(0o755);
        },
      );
    },
  );

  it.runIf(process.platform !== "win32")("captures and reapplies mode-only overrides", async () => {
    await withTempDir({ prefix: "openclaw-package-update-local-mode-only-" }, async (base) => {
      const packageRoot = path.join(base, "package");
      const indexPath = path.join(packageRoot, "dist", "index.js");
      await writePackageRoot(packageRoot, "1.0.0");
      await fs.chmod(indexPath, 0o644);
      await writePackageDistInventory(packageRoot);
      await fs.chmod(indexPath, 0o755);

      const plan = await captureLocalPackageOverrides({ packageRoot });
      expect(plan).not.toBeNull();
      expect(plan?.result.modified).toBe(1);

      await writePackageRoot(packageRoot, "2.0.0");
      await fs.chmod(indexPath, 0o644);
      await writePackageDistInventory(packageRoot);

      const result = await applyLocalPackageOverrides({
        packageRoot,
        plan,
        reapply: true,
      });

      expect(result.status).toBe("applied");
      expect(result.applied).toBe(1);
      await expect(fs.readFile(indexPath, "utf8")).resolves.toBe("export {};\n");
      expect((await fs.stat(indexPath)).mode & 0o777).toBe(0o755);
    });
  });

  it.runIf(process.platform !== "win32")(
    "captures and reapplies distinct executable-mask overrides",
    async () => {
      await withTempDir(
        { prefix: "openclaw-package-update-local-executable-mask-" },
        async (base) => {
          const packageRoot = path.join(base, "package");
          const indexPath = path.join(packageRoot, "dist", "index.js");
          await writePackageRoot(packageRoot, "1.0.0");
          await fs.chmod(indexPath, 0o755);
          await writePackageDistInventory(packageRoot);
          await fs.chmod(indexPath, 0o700);

          const plan = await captureLocalPackageOverrides({ packageRoot });
          expect(plan).not.toBeNull();
          expect(plan?.result.modified).toBe(1);

          await writePackageRoot(packageRoot, "2.0.0");
          await fs.chmod(indexPath, 0o755);
          await writePackageDistInventory(packageRoot);

          const result = await applyLocalPackageOverrides({
            packageRoot,
            plan,
            reapply: true,
          });

          expect(result.status).toBe("applied");
          expect(result.applied).toBe(1);
          expect((await fs.stat(indexPath)).mode & 0o777).toBe(0o744);
        },
      );
    },
  );

  it.runIf(process.platform !== "win32")(
    "ignores non-executable mode normalization during capture",
    async () => {
      await withTempDir(
        { prefix: "openclaw-package-update-local-mode-normalized-" },
        async (base) => {
          const packageRoot = path.join(base, "package");
          const indexPath = path.join(packageRoot, "dist", "index.js");
          await writePackageRoot(packageRoot, "1.0.0");
          await fs.chmod(indexPath, 0o644);
          await writePackageDistInventory(packageRoot);
          await fs.chmod(indexPath, 0o600);

          await expect(captureLocalPackageOverrides({ packageRoot })).resolves.toBeNull();
        },
      );
    },
  );

  it.runIf(process.platform !== "win32")(
    "reapplies byte overrides over non-executable mode normalization",
    async () => {
      await withTempDir({ prefix: "openclaw-package-update-local-mode-reapply-" }, async (base) => {
        const packageRoot = path.join(base, "package");
        const indexPath = path.join(packageRoot, "dist", "index.js");
        await writePackageRoot(packageRoot, "1.0.0");
        await fs.chmod(indexPath, 0o644);
        await writePackageDistInventory(packageRoot);
        await fs.writeFile(indexPath, "export const local = true;\n", "utf8");

        const plan = await captureLocalPackageOverrides({ packageRoot });
        expect(plan).not.toBeNull();
        await writePackageRoot(packageRoot, "2.0.0");
        await fs.chmod(indexPath, 0o644);
        await writePackageDistInventory(packageRoot);
        await fs.chmod(indexPath, 0o600);

        const result = await applyLocalPackageOverrides({
          packageRoot,
          plan,
          reapply: true,
        });

        expect(result.status).toBe("applied");
        expect(result.applied).toBe(1);
        expect(result.conflicts).toEqual([]);
        await expect(fs.readFile(indexPath, "utf8")).resolves.toBe("export const local = true;\n");
        expect((await fs.stat(indexPath)).mode & 0o777).toBe(0o600);
      });
    },
  );

  it("captures and reapplies locally added files excluded from package files", async () => {
    await withTempDir({ prefix: "openclaw-package-update-local-excluded-files-" }, async (base) => {
      const packageRoot = path.join(base, "package");
      const localFiles = new Map([
        ["dist/index.js.map", '{"version":3,"sources":["index.ts"]}\n'],
        ["dist/local-runtime.js", "export const local = true;\n"],
        ["dist/local-assets/theme.css", "body {}\n"],
        ["dist/local-assets/runtime.wasm", "local wasm\n"],
        ["dist/local-assets/settings.json", '{"local":true}\n'],
      ]);
      const writePackageJson = async (version: string) => {
        await fs.writeFile(
          path.join(packageRoot, "package.json"),
          JSON.stringify({
            name: "openclaw",
            version,
            files: ["dist/", "!dist/**/*.map", "!dist/local-runtime.js", "!dist/local-assets/**"],
          }),
          "utf8",
        );
      };
      await writePackageRoot(packageRoot, "1.0.0");
      await writePackageJson("1.0.0");
      await writePackageDistInventory(packageRoot);
      for (const [relativePath, content] of localFiles) {
        const filePath = path.join(packageRoot, relativePath);
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, content, "utf8");
      }

      const plan = await captureLocalPackageOverrides({ packageRoot });
      expect(plan).not.toBeNull();
      expect(plan?.result.added).toBe(localFiles.size);

      await writePackageRoot(packageRoot, "2.0.0");
      await writePackageJson("2.0.0");
      for (const relativePath of localFiles.keys()) {
        await fs.rm(path.join(packageRoot, relativePath));
      }
      await writePackageDistInventory(packageRoot);

      const result = await applyLocalPackageOverrides({
        packageRoot,
        plan,
        reapply: true,
      });

      expect(result.status).toBe("applied");
      expect(result.applied).toBe(localFiles.size);
      for (const [relativePath, content] of localFiles) {
        await expect(fs.readFile(path.join(packageRoot, relativePath), "utf8")).resolves.toBe(
          content,
        );
      }
    });
  });

  it.runIf(process.platform !== "win32")(
    "does not reapply overrides after an unrecorded installed mode change",
    async () => {
      await withTempDir({ prefix: "openclaw-package-update-local-actual-mode-" }, async (base) => {
        const packageRoot = path.join(base, "package");
        const indexPath = path.join(packageRoot, "dist", "index.js");
        await writePackageRoot(packageRoot, "1.0.0");
        await fs.chmod(indexPath, 0o644);
        await writePackageDistInventory(packageRoot);
        await fs.writeFile(indexPath, "export const local = true;\n", "utf8");

        const plan = await captureLocalPackageOverrides({ packageRoot });
        expect(plan).not.toBeNull();
        await fs.writeFile(indexPath, "export {};\n", "utf8");
        await fs.chmod(indexPath, 0o644);
        await writePackageDistInventory(packageRoot);
        await fs.chmod(indexPath, 0o755);

        const result = await applyLocalPackageOverrides({
          packageRoot,
          plan,
          reapply: true,
        });

        expect(result.status).toBe("conflict");
        expect(result.applied).toBe(0);
        expect(result.conflicts).toEqual([{ path: "dist/index.js", reason: "target-changed" }]);
        await expect(fs.readFile(indexPath, "utf8")).resolves.toBe("export {};\n");
        expect((await fs.stat(indexPath)).mode & 0o777).toBe(0o755);
      });
    },
  );

  it.each(["modified", "deleted"] as const)(
    "does not reapply %s overrides after an unrecorded installed byte change",
    async (overrideKind) => {
      await withTempDir(
        { prefix: `openclaw-package-update-local-actual-bytes-${overrideKind}-` },
        async (base) => {
          const packageRoot = path.join(base, "package");
          const indexPath = path.join(packageRoot, "dist", "index.js");
          await writePackageRoot(packageRoot, "1.0.0");
          if (overrideKind === "modified") {
            await fs.writeFile(indexPath, "export const local = true;\n", "utf8");
          } else {
            await fs.rm(indexPath);
          }

          const plan = await captureLocalPackageOverrides({ packageRoot });
          expect(plan).not.toBeNull();
          await fs.writeFile(indexPath, "export {};\n", "utf8");
          await writePackageDistInventory(packageRoot);
          await fs.writeFile(indexPath, "export const changedAfterVerify = true;\n", "utf8");

          const result = await applyLocalPackageOverrides({
            packageRoot,
            plan,
            reapply: true,
          });

          expect(result.status).toBe("conflict");
          expect(result.applied).toBe(0);
          expect(result.conflicts).toEqual([{ path: "dist/index.js", reason: "target-changed" }]);
          await expect(fs.readFile(indexPath, "utf8")).resolves.toBe(
            "export const changedAfterVerify = true;\n",
          );
        },
      );
    },
  );

  it.runIf(process.platform !== "win32")(
    "does not overwrite a modified target changed after replay preflight",
    async () => {
      await withTempDir({ prefix: "openclaw-package-update-local-late-replace-" }, async (base) => {
        const packageRoot = path.join(base, "package");
        const indexPath = path.join(packageRoot, "dist", "index.js");
        await writePackageRoot(packageRoot, "1.0.0");
        await fs.writeFile(indexPath, "export const local = true;\n", "utf8");

        const plan = await captureLocalPackageOverrides({ packageRoot });
        expect(plan).not.toBeNull();
        await writePackageRoot(packageRoot, "2.0.0");

        const realMkdtemp = fs.mkdtemp.bind(fs);
        let targetChanged = false;
        const mkdtempSpy = vi
          .spyOn(fs, "mkdtemp")
          .mockImplementation(async (prefixArg, options) => {
            const result = await realMkdtemp(prefixArg, options);
            if (!targetChanged && prefixArg.endsWith(`${path.sep}rollback-`)) {
              targetChanged = true;
              await fs.writeFile(indexPath, "export const concurrent = true;\n", "utf8");
            }
            return result;
          });

        try {
          const result = await applyLocalPackageOverrides({
            packageRoot,
            plan,
            reapply: true,
          });

          expect(targetChanged).toBe(true);
          expect(result.status).toBe("error");
          expect(result.applied).toBe(0);
          await expect(fs.readFile(indexPath, "utf8")).resolves.toBe(
            "export const concurrent = true;\n",
          );
        } finally {
          mkdtempSpy.mockRestore();
        }
      });
    },
  );

  it("does not overwrite a target created at the final replacement boundary", async () => {
    await withTempDir({ prefix: "openclaw-package-update-local-final-replace-" }, async (base) => {
      const packageRoot = path.join(base, "package");
      const indexPath = path.join(packageRoot, "dist", "index.js");
      await writePackageRoot(packageRoot, "1.0.0");
      await fs.writeFile(indexPath, "export const local = true;\n", "utf8");

      const plan = await captureLocalPackageOverrides({ packageRoot });
      expect(plan).not.toBeNull();
      await writePackageRoot(packageRoot, "2.0.0");

      const realRealpath = fs.realpath.bind(fs);
      let targetChanged = false;
      const realpathSpy = vi
        .spyOn(fs, "realpath")
        .mockImplementation(async (...args: Parameters<typeof fs.realpath>) => {
          const result = await realRealpath(...args);
          const entries =
            String(args[0]) === path.dirname(indexPath)
              ? await fs.readdir(path.dirname(indexPath)).catch(() => [] as string[])
              : [];
          if (
            !targetChanged &&
            entries.some((entry) => entry.startsWith(".openclaw-override-next-"))
          ) {
            targetChanged = true;
            await fs.writeFile(indexPath, "export const concurrent = true;\n", "utf8");
          }
          return result;
        });

      try {
        const result = await applyLocalPackageOverrides({
          packageRoot,
          plan,
          reapply: true,
        });

        expect(targetChanged).toBe(true);
        expect(result.status).toBe("error");
        expect(result.applied).toBe(0);
        await expect(fs.readFile(indexPath, "utf8")).resolves.toBe(
          "export const concurrent = true;\n",
        );
        expect(
          (await fs.readdir(path.dirname(indexPath))).filter((entry) =>
            entry.startsWith(".openclaw-override-"),
          ),
        ).toEqual([]);
      } finally {
        realpathSpy.mockRestore();
      }
    });
  });

  it("does not delete a target changed at the final deletion boundary", async () => {
    await withTempDir({ prefix: "openclaw-package-update-local-late-delete-" }, async (base) => {
      const packageRoot = path.join(base, "package");
      const indexPath = path.join(packageRoot, "dist", "index.js");
      await writePackageRoot(packageRoot, "1.0.0");
      await fs.rm(indexPath);

      const plan = await captureLocalPackageOverrides({ packageRoot });
      expect(plan).not.toBeNull();
      await writePackageRoot(packageRoot, "2.0.0");

      let targetChanged = false;
      __setFsSafeTestHooksForTest({
        beforeRootFallbackMutation: async (operation, targetPath) => {
          if (
            !targetChanged &&
            operation === "move" &&
            path.basename(targetPath).startsWith(".openclaw-override-previous-")
          ) {
            targetChanged = true;
            await fs.writeFile(indexPath, "export const concurrent = true;\n", "utf8");
          }
        },
      });

      try {
        const result = await applyLocalPackageOverrides({
          packageRoot,
          plan,
          reapply: true,
        });

        expect(targetChanged).toBe(true);
        expect(result.status).toBe("error");
        expect(result.applied).toBe(0);
        await expect(fs.readFile(indexPath, "utf8")).resolves.toBe(
          "export const concurrent = true;\n",
        );
        expect(
          (await fs.readdir(path.dirname(indexPath))).filter((entry) =>
            entry.startsWith(".openclaw-override-"),
          ),
        ).toEqual([]);
      } finally {
        __setFsSafeTestHooksForTest(undefined);
      }
    });
  });

  it("does not report a deletion applied when the target is recreated during cleanup", async () => {
    await withTempDir(
      { prefix: "openclaw-package-update-local-recreated-delete-" },
      async (base) => {
        const packageRoot = path.join(base, "package");
        const indexPath = path.join(packageRoot, "dist", "index.js");
        await writePackageRoot(packageRoot, "1.0.0");
        await fs.rm(indexPath);

        const plan = await captureLocalPackageOverrides({ packageRoot });
        expect(plan).not.toBeNull();
        await writePackageRoot(packageRoot, "2.0.0");

        let targetRecreated = false;
        __setFsSafeTestHooksForTest({
          beforeRootFallbackMutation: async (operation, targetPath) => {
            if (
              !targetRecreated &&
              operation === "remove" &&
              path.basename(targetPath).startsWith(".openclaw-override-previous-")
            ) {
              targetRecreated = true;
              await fs.writeFile(indexPath, "export const concurrent = true;\n", "utf8");
            }
          },
        });

        try {
          const result = await applyLocalPackageOverrides({
            packageRoot,
            plan,
            reapply: true,
          });

          expect(targetRecreated).toBe(true);
          expect(result.status).toBe("error");
          expect(result.applied).toBe(0);
          await expect(fs.readFile(indexPath, "utf8")).resolves.toBe(
            "export const concurrent = true;\n",
          );
        } finally {
          __setFsSafeTestHooksForTest(undefined);
        }
      },
    );
  });

  it.runIf(process.platform !== "win32")(
    "does not mutate a redirect target when a deletion ancestor swaps at the mutation boundary",
    async () => {
      await withTempDir(
        { prefix: "openclaw-package-update-local-delete-topology-" },
        async (base) => {
          const packageRoot = path.join(base, "package");
          const distPath = path.join(packageRoot, "dist");
          const preservedDistPath = path.join(packageRoot, "preserved-dist");
          const indexPath = path.join(distPath, "index.js");
          const outsideRoot = path.join(base, "outside");
          const outsideIndexPath = path.join(outsideRoot, "index.js");
          await writePackageRoot(packageRoot, "1.0.0");
          await fs.rm(indexPath);

          const plan = await captureLocalPackageOverrides({ packageRoot });
          expect(plan).not.toBeNull();
          await writePackageRoot(packageRoot, "2.0.0");
          await fs.mkdir(outsideRoot);
          await fs.writeFile(outsideIndexPath, "export const outside = true;\n", "utf8");

          let topologyChanged = false;
          __setFsSafeTestHooksForTest({
            beforeRootFallbackMutation: async (operation, targetPath) => {
              if (
                !topologyChanged &&
                operation === "move" &&
                path.basename(targetPath).startsWith(".openclaw-override-previous-")
              ) {
                topologyChanged = true;
                await fs.rename(distPath, preservedDistPath);
                await fs.symlink(outsideRoot, distPath, "dir");
              }
            },
          });

          try {
            const result = await applyLocalPackageOverrides({
              packageRoot,
              plan,
              reapply: true,
            });

            expect(topologyChanged).toBe(true);
            expect(result.status).toBe("error");
            expect(result.applied).toBe(0);
            await expect(fs.readFile(outsideIndexPath, "utf8")).resolves.toBe(
              "export const outside = true;\n",
            );
            await expect(
              fs.readFile(path.join(preservedDistPath, "index.js"), "utf8"),
            ).resolves.toBe("export {};\n");
          } finally {
            __setFsSafeTestHooksForTest(undefined);
          }
        },
      );
    },
  );

  it("treats deletions already satisfied by the updated package as a no-op", async () => {
    await withTempDir(
      { prefix: "openclaw-package-update-local-deleted-upstream-" },
      async (base) => {
        const packageRoot = path.join(base, "package");
        const indexPath = path.join(packageRoot, "dist", "index.js");
        await writePackageRoot(packageRoot, "1.0.0");
        await fs.rm(indexPath);

        const plan = await captureLocalPackageOverrides({ packageRoot });
        expect(plan).not.toBeNull();
        await writePackageRoot(packageRoot, "2.0.0");
        await fs.rm(indexPath);
        await writePackageDistInventory(packageRoot);

        const result = await applyLocalPackageOverrides({
          packageRoot,
          plan,
          reapply: true,
        });

        expect(result.status).toBe("applied");
        expect(result.applied).toBe(0);
        expect(result.conflicts).toEqual([]);
        await expectPathMissing(indexPath);
      },
    );
  });

  it.runIf(process.platform !== "win32")(
    "reapplies overrides when Windows reports synthetic installed modes",
    async () => {
      await withTempDir({ prefix: "openclaw-package-update-local-windows-mode-" }, async (base) => {
        const packageRoot = path.join(base, "package");
        const indexPath = path.join(packageRoot, "dist", "index.js");
        await writePackageRoot(packageRoot, "1.0.0");
        await fs.chmod(indexPath, 0o644);
        await writePackageDistInventory(packageRoot);
        await fs.writeFile(indexPath, "export const local = true;\n", "utf8");

        const plan = await captureLocalPackageOverrides({ packageRoot });
        expect(plan).not.toBeNull();
        await fs.writeFile(indexPath, "export {};\n", "utf8");
        await fs.chmod(indexPath, 0o644);
        await writePackageDistInventory(packageRoot);
        await fs.chmod(indexPath, 0o666);

        const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
        let result;
        try {
          result = await applyLocalPackageOverrides({
            packageRoot,
            plan,
            reapply: true,
          });
        } finally {
          platformSpy.mockRestore();
        }

        expect(result.status).toBe("applied");
        expect(result.applied).toBe(1);
        expect(result.conflicts).toEqual([]);
        await expect(fs.readFile(indexPath, "utf8")).resolves.toBe("export const local = true;\n");
      });
    },
  );
});
