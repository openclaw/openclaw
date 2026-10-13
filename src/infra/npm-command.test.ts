import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
});

describe("npm invocation", () => {
  it.each([
    { bun: undefined, args: ["view", "@openclaw/irc", "version"], command: ["npm"] },
    { bun: "1.4.2", args: ["install", "--ignore-scripts"], command: [process.execPath, cliPath] },
  ])("preserves npm arguments with Bun version $bun", ({ bun, args, command }) => {
    Object.defineProperty(process, "versions", { value: { ...originalVersions, bun } });
    const stat = vi.spyOn(fs, "statSync");
    expect(resolveNpmCommand(args)).toEqual([...command, ...args]);
    if (!bun) {
      expect(stat).not.toHaveBeenCalled();
    }
  });

  it("fails with a typed missing-file error instead of falling back to PATH npm", () => {
    Object.defineProperty(process, "versions", { value: { ...originalVersions, bun: "1.4.2" } });
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
