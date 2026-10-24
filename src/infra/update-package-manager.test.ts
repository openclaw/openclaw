import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveUpdateBuildManager } from "./update-package-manager.js";

type PackageManagerCommandRunner = Parameters<typeof resolveUpdateBuildManager>[0];
const roots = useAutoCleanupTempDirTracker(afterEach);

async function checkout(version: string) {
  const root = roots.make("openclaw-update-manager-test-");
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ packageManager: `pnpm@${version}+sha512.test` }),
  );
  await fs.writeFile(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  return root;
}

it("returns a package-manager failure when the probe directory cannot be allocated", async () => {
  const root = await checkout("12.0.0");
  const tmpdir = vi.spyOn(os, "tmpdir").mockReturnValue(path.join(root, "missing"));
  const runCommand = vi.fn<PackageManagerCommandRunner>();
  try {
    await expect(resolveUpdateBuildManager(runCommand, root, 5_000)).resolves.toEqual({
      kind: "missing-required",
      preferred: "pnpm",
      reason: "pnpm-corepack-missing",
    });
    expect(runCommand).not.toHaveBeenCalled();
  } finally {
    tmpdir.mockRestore();
  }
});

describe.each(["corepack", "npm"])("%s bootstrap deadlines", (installer) => {
  it.each([
    ["legacy caller", undefined, 5_000],
    ["unbounded update work", {}, undefined],
    ["explicit update deadline", { timeoutMs: 9_000 }, 9_000],
  ] as const)("separates work/probe deadlines: %s", async (_label, work, expected) => {
    const root = await checkout("12.0.0");
    let installed = false;
    const runCommand: PackageManagerCommandRunner = async (argv, options) => {
      const verb = installer === "npm" ? "install" : "enable";
      if (argv[0] === installer && argv[1] === verb) {
        expect(options.timeoutMs).toBe(expected);
        installed = true;
        return { code: 0, stdout: "installed", stderr: "" };
      }
      expect(options.timeoutMs).toBe(5_000);
      if ((installer === "npm" && argv[0] === "corepack") || (argv[0] === "pnpm" && !installed)) {
        throw new Error("not installed");
      }
      return { code: 0, stdout: "12.0.0", stderr: "" };
    };
    const result = await resolveUpdateBuildManager(runCommand, root, 5_000, undefined, work);
    assert(result.kind === "resolved");
    expect(installed).toBe(true);
    await result.cleanup?.();
  });
});

it.each([
  ["11.22.0", undefined],
  ["12.0.0", undefined],
  ["12.0.0", "install"],
  ["12.0.0", "verify"],
] as const)("bootstraps pinned pnpm %s (failure: %s)", async (version, failure) => {
  const root = await checkout(version);
  const lockPath = path.join(root, "pnpm-lock.yaml");
  const lockBefore = await fs.readFile(lockPath);
  const manifestBefore = await fs.readFile(path.join(root, "package.json"));
  const calls: string[][] = [];
  let prefix = "";
  const baseEnv = Object.freeze({
    Path: "synthetic-bin",
    PATH: undefined,
    EMPTY: "",
    KEEP: "value",
  });
  const runCommand: PackageManagerCommandRunner = async (argv, options) => {
    calls.push(argv);
    const key = argv.join(" ");
    if (key === "corepack --version" || (failure && key === "pnpm --version")) {
      throw new Error("missing tool");
    }
    if (key === "pnpm --version") {
      const envPath = options.env?.PATH ?? options.env?.Path ?? "";
      const expectedBin = path.join(prefix, "node_modules", ".bin");
      const local = prefix && envPath.split(path.delimiter)[0] === expectedBin;
      if (local) {
        assert(options.env);
        expect(options.env).toMatchObject({ EMPTY: "", KEEP: "value" });
        expect(Object.hasOwn(options.env, "PATH")).toBe(false);
        expect(options.env).not.toBe(baseEnv);
      }
      if (!local) {
        assert(options.cwd);
        const manifest = JSON.parse(
          await fs.readFile(path.join(options.cwd, "package.json"), "utf8"),
        );
        if (manifest.packageManager) {
          // Older pnpm resolves/writes its launcher before reporting the pinned version.
          await fs.appendFile(lockPath, "packageManagerDependencies: ['@pnpm/exe']\n");
          return { stdout: version, stderr: "", code: 0 };
        }
        expect(await fs.readFile(path.join(options.cwd, "pnpm-workspace.yaml"), "utf8")).toBe(
          "packages: []\n",
        );
      }
      return { stdout: local ? version : "10.0.0", stderr: "", code: 0 };
    }
    if (key === "npm --version") {
      return { stdout: "10.0.0", stderr: "", code: 0 };
    }
    if (key.startsWith("npm install --prefix ")) {
      prefix = argv[3] ?? "";
      expect(argv[4]).toBe(`pnpm@${version}`);
      expect(JSON.parse(await fs.readFile(path.join(prefix, "package.json"), "utf8"))).toEqual({
        private: true,
        allowScripts: { [`pnpm@${version}`]: true },
      });
      return { stdout: "added pnpm", stderr: "", code: failure === "install" ? 1 : 0 };
    }
    throw new Error(`Unexpected command ${key}`);
  };
  const result = await resolveUpdateBuildManager(runCommand, root, 5000, baseEnv);
  expect(await fs.readFile(lockPath)).toEqual(lockBefore);
  expect(await fs.readFile(path.join(root, "package.json"))).toEqual(manifestBefore);
  if (failure) {
    expect(result).toEqual({
      kind: "missing-required",
      preferred: "pnpm",
      reason: "pnpm-npm-bootstrap-failed",
    });
  } else {
    assert(result.kind === "resolved" && result.manager === "pnpm");
    expect(calls).toContainEqual(["npm", "install", "--prefix", prefix, `pnpm@${version}`]);
    await expect(fs.stat(prefix)).resolves.toBeDefined();
    await result.cleanup?.();
  }
  await expect(fs.stat(prefix)).rejects.toMatchObject({ code: "ENOENT" });
});

it("uses a scoped Corepack shim for the checkout pin when npm is unavailable", async () => {
  const root = await checkout("12.0.0");
  const lockBefore = await fs.readFile(path.join(root, "pnpm-lock.yaml"));
  const rootKeys = [
    "NPM_CONFIG_WORKSPACE_DIR",
    "npm_config_workspace_dir",
    "PNPM_CONFIG_LOCKFILE_DIR",
    "pnpm_config_lockfile_dir",
  ];
  const baseEnv = Object.freeze({
    PATH: "/ambient/bin",
    COREPACK_ENABLE_PROJECT_SPEC: "0",
    ...Object.fromEntries(rootKeys.map((key) => [key, "/other-checkout"])),
  });
  let shimDir = "";
  const runCommand: PackageManagerCommandRunner = async (argv, options) => {
    if (argv[0] === "pnpm") {
      const fromOwnedShim = shimDir && options.env?.PATH?.split(path.delimiter)[0] === shimDir;
      if (!fromOwnedShim) {
        return { stdout: "11.15.1", stderr: "", code: 0 };
      }
      expect(options.cwd).toBe(root);
      expect(JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"))).toEqual({
        packageManager: "pnpm@12.0.0+sha512.test",
      });
      for (const key of rootKeys) {
        expect(options.env?.[key]).toBe(root);
      }
      expect(options.env?.COREPACK_ENABLE_PROJECT_SPEC).toBe("1");
      expect(options.env?.COREPACK_DEFAULT_TO_LATEST).toBe("0");
      return { stdout: "12.0.0", stderr: "", code: 0 };
    }
    if (argv.join(" ") === "corepack --version") {
      return { stdout: "0.35.0", stderr: "", code: 0 };
    }
    if (argv[0] === "corepack" && argv[1] === "enable") {
      if (argv[2] !== "--install-directory" || !argv[3] || argv[4] !== "pnpm") {
        return { stdout: "", stderr: "global toolchain is read-only", code: 1 };
      }
      shimDir = argv[3];
      expect(shimDir).not.toBe(root);
      await fs.access(shimDir);
      return { stdout: "", stderr: "", code: 0 };
    }
    throw new Error(`Unavailable command ${argv.join(" ")}`);
  };
  const result = await resolveUpdateBuildManager(runCommand, root, 5_000, baseEnv);
  assert(result.kind === "resolved");
  expect(result.env?.PATH).toBe(`${shimDir}${path.delimiter}/ambient/bin`);
  await expect(fs.stat(shimDir)).resolves.toBeDefined();
  expect(await fs.readFile(path.join(root, "pnpm-lock.yaml"))).toEqual(lockBefore);
  await result.cleanup?.();
  await expect(fs.stat(shimDir)).rejects.toMatchObject({ code: "ENOENT" });
});
