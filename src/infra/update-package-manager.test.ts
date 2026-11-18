import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveUpdateBuildManager } from "./update-package-manager.js";

type Runner = Parameters<typeof resolveUpdateBuildManager>[0];
const roots = useAutoCleanupTempDirTracker(afterEach);
const output = (stdout = "", code = 0) => ({ stdout, stderr: "", code });
const rootKeys = [
  "NPM_CONFIG_WORKSPACE_DIR",
  "npm_config_workspace_dir",
  "PNPM_CONFIG_LOCKFILE_DIR",
  "pnpm_config_lockfile_dir",
];

async function checkout(version = "12.0.0") {
  const root = roots.make("openclaw-update-manager-test-");
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ packageManager: `pnpm@${version}+sha512.test` }),
  );
  await fs.writeFile(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  return root;
}
const readJson = async (file: string): Promise<unknown> =>
  JSON.parse(await fs.readFile(file, "utf8"));

it("reports failure when the probe directory cannot be allocated", async () => {
  const root = await checkout();
  const tmpdir = vi.spyOn(os, "tmpdir").mockReturnValue(path.join(root, "missing"));
  const run = vi.fn<Runner>();
  try {
    await expect(resolveUpdateBuildManager(run, root, 5_000)).resolves.toEqual({
      kind: "missing-required",
      preferred: "pnpm",
      reason: "pnpm-corepack-missing",
    });
    expect(run).not.toHaveBeenCalled();
  } finally {
    tmpdir.mockRestore();
  }
});

it.each([
  ["npm", "11.22.0", undefined, 5_000, undefined],
  ["npm", "12.0.0", {}, undefined, undefined],
  ["npm", "12.0.0", { timeoutMs: 9_000 }, 9_000, undefined],
  ["npm", "12.0.0", undefined, 5_000, "install"],
  ["npm", "12.0.0", undefined, 5_000, "verify"],
  ["corepack", "12.0.0", undefined, 5_000, undefined],
  ["corepack", "12.0.0", {}, undefined, undefined],
  ["corepack", "12.0.0", { timeoutMs: 9_000 }, 9_000, undefined],
] as const)(
  "bootstraps %s pnpm %s (work=%j, timeout=%s, failure=%s)",
  async (installer, version, work, timeout, failure) => {
    const root = await checkout(version);
    const manifest = path.join(root, "package.json");
    const lock = path.join(root, "pnpm-lock.yaml");
    const before = await Promise.all([fs.readFile(manifest), fs.readFile(lock)]);
    const pathKey = installer === "npm" ? "Path" : "PATH";
    const baseEnv = Object.freeze({
      PATH: undefined,
      [pathKey]: "/ambient/bin",
      EMPTY: "",
      KEEP: "value",
      COREPACK_ENABLE_PROJECT_SPEC: "0",
      ...Object.fromEntries(rootKeys.map((key) => [key, "/other-checkout"])),
    });
    let prefix = "";
    let probeFiles: unknown;
    let installManifest: unknown;
    let verified: Parameters<Runner>[1] | undefined;
    let installArgs: string[] = [];
    const bin = () => (installer === "npm" ? path.join(prefix, "node_modules", ".bin") : prefix);
    const verb = installer === "npm" ? "install" : "enable";
    const run = vi.fn<Runner>(async (argv, options) => {
      assert(options.cwd);
      if (argv[0] === "pnpm") {
        const owned = prefix && options.env?.[pathKey]?.split(path.delimiter)[0] === bin();
        if (owned) {
          verified = options;
          if (failure === "verify") {
            throw new Error("missing tool");
          }
          return output(version);
        }
        probeFiles = [
          await readJson(path.join(options.cwd, "package.json")),
          await fs.readFile(path.join(options.cwd, "pnpm-workspace.yaml"), "utf8"),
        ];
        if (failure) {
          throw new Error("missing tool");
        }
        return output("10.0.0");
      }
      if (argv[0] !== installer) {
        throw new Error("missing tool");
      }
      if (argv[1] === "--version") {
        return output("0.35.0");
      }
      const flag = installer === "npm" ? "--prefix" : "--install-directory";
      const pin = installer === "npm" ? `pnpm@${version}` : "pnpm";
      if (argv[1] !== verb || argv[2] !== flag || !argv[3] || argv[4] !== pin) {
        throw new Error(`Unexpected command ${argv.join(" ")}`);
      }
      installArgs = argv;
      prefix = argv[3] ?? "";
      installManifest = await readJson(path.join(prefix, "package.json"));
      return output("", failure === "install" ? 1 : 0);
    });
    const result = await resolveUpdateBuildManager(run, root, 5_000, baseEnv, work);
    expect(await Promise.all([fs.readFile(manifest), fs.readFile(lock)])).toEqual(before);
    expect(probeFiles).toEqual([{ private: true }, "packages: []\n"]);
    expect(installArgs).toEqual(
      installer === "npm"
        ? ["npm", "install", "--prefix", prefix, `pnpm@${version}`]
        : ["corepack", "enable", "--install-directory", prefix, "pnpm"],
    );
    expect(prefix).not.toBe(root);
    expect(installManifest).toEqual(
      installer === "npm"
        ? { private: true, allowScripts: { [`pnpm@${version}`]: true } }
        : { private: true },
    );
    for (const [argv, options] of run.mock.calls) {
      expect(options.timeoutMs).toBe(argv[1] === verb ? timeout : 5_000);
    }
    if (failure) {
      expect(result).toEqual({
        kind: "missing-required",
        preferred: "pnpm",
        reason: "pnpm-npm-bootstrap-failed",
      });
    } else {
      assert(result.kind === "resolved" && result.manager === "pnpm");
      assert(verified?.env);
      const owner = installer === "npm" ? prefix : root;
      expect(verified.cwd).toBe(owner);
      expect(verified.env).toMatchObject({
        EMPTY: "",
        KEEP: "value",
        COREPACK_ENABLE_PROJECT_SPEC: "1",
        COREPACK_DEFAULT_TO_LATEST: "0",
        ...Object.fromEntries(rootKeys.map((key) => [key, owner])),
      });
      expect(result.env?.[pathKey]).toBe(`${bin()}${path.delimiter}/ambient/bin`);
      expect(result.env).not.toBe(baseEnv);
      if (installer === "npm") {
        expect(Object.hasOwn(verified.env, "PATH")).toBe(false);
      }
      await expect(fs.stat(prefix)).resolves.toBeDefined();
      await result.cleanup?.();
    }
    await expect(fs.stat(prefix)).rejects.toMatchObject({ code: "ENOENT" });
  },
);
