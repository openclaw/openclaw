import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveRuntimeScriptEnv } from "../../cli-invocation.mjs";
import { resolveNpmCommand } from "./npm-command.js";

const cliPath = path.join(
  path.dirname(createRequire(import.meta.url).resolve("npm/package.json")),
  "bin",
  "npm-cli.js",
);

const originalVersions = process.versions;
afterEach(() => {
  Object.defineProperty(process, "versions", { value: originalVersions });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("npm invocation", () => {
  it("uses the standalone sidecar and self-as-Bun environment without host npm", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "standalone-npm-command-"));
    try {
      const entry = path.join(root, "npm", "bin", "npm-cli.js");
      fs.mkdirSync(path.dirname(entry), { recursive: true });
      fs.writeFileSync(entry, "// packaged npm entry");
      vi.stubGlobal("__openclawStandaloneRootUrl", pathToFileURL(root + path.sep).href);
      Object.defineProperty(process, "versions", { value: { ...originalVersions, bun: "1.4.3" } });
      const env = {
        NPM_CONFIG_IGNORE_SCRIPTS: "true",
        NPM_CONFIG_REGISTRY: "https://registry.example",
      };
      expect(resolveNpmCommand(["install", "--ignore-scripts"])).toEqual([
        process.execPath,
        entry,
        "install",
        "--ignore-scripts",
      ]);
      expect(resolveRuntimeScriptEnv(env)).toEqual({ ...env, BUN_BE_BUN: "1" });
      expect(env).not.toHaveProperty("BUN_BE_BUN");
      fs.rmSync(entry);
      expect(() => resolveNpmCommand(["install"])).toThrow(entry);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    { bun: undefined, args: ["view", "@openclaw/irc", "version"], command: ["npm"] },
    { bun: "1.4.3", args: ["install", "--ignore-scripts"], command: [process.execPath, cliPath] },
  ])("preserves npm arguments with Bun version $bun", ({ bun, args, command }) => {
    Object.defineProperty(process, "versions", { value: { ...originalVersions, bun } });
    const stat = vi.spyOn(fs, "statSync");
    expect(resolveNpmCommand(args)).toEqual([...command, ...args]);
    if (!bun) {
      expect(stat).not.toHaveBeenCalled();
    }
  });

  it("fails with a typed missing-file error instead of falling back to PATH npm", () => {
    Object.defineProperty(process, "versions", { value: { ...originalVersions, bun: "1.4.3" } });
    vi.spyOn(fs, "statSync").mockImplementation(() => {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });
    expect(() => resolveNpmCommand(["install"])).toThrow(
      expect.objectContaining({
        name: "BundledNpmCliNotFoundError",
        code: "BUNDLED_NPM_CLI_NOT_FOUND",
        cause: expect.objectContaining({ code: "ENOENT" }),
      }),
    );
    expect(() => resolveNpmCommand(["install"])).toThrow(cliPath);
  });
});
