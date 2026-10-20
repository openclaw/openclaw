import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
  return root;
}

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
    expect(options.cwd).toBe(root);
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
