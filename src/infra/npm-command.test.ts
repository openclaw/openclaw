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
  it("preserves PATH npm and its arguments under Node", () => {
    Object.defineProperty(process, "versions", { value: { ...originalVersions, bun: undefined } });
    const stat = vi.spyOn(fs, "statSync");
    expect(resolveNpmCommand(["view", "@openclaw/irc", "version"])).toEqual([
      "npm",
      "view",
      "@openclaw/irc",
      "version",
    ]);
    expect(stat).not.toHaveBeenCalled();
  });

  it("runs the bundled CLI with the current Bun executable", () => {
    Object.defineProperty(process, "versions", { value: { ...originalVersions, bun: "1.4.2" } });
    expect(resolveNpmCommand(["install", "--ignore-scripts"])).toEqual([
      process.execPath,
      cliPath,
      "install",
      "--ignore-scripts",
    ]);
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
