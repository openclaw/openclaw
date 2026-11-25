import syncFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearExecutablePathCache } from "../infra/executable-path.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { assertGitHubCliAvailable } from "./github-cli-preflight.js";

afterEach(() => {
  clearExecutablePathCache();
});

describe("GitHub CLI preflight", () => {
  it("recognizes CLI installation changes without synchronous filesystem calls", async () => {
    await withTestDir({ prefix: "openclaw-github-cli-" }, async (binDir) => {
      const executableName = process.platform === "win32" ? "gh.cmd" : "gh";
      const executablePath = path.join(binDir, executableName);
      const env = {
        PATH: binDir,
        ...(process.platform === "win32" ? { PATHEXT: ".CMD" } : {}),
      };
      using stat = vi.spyOn(syncFs, "statSync");
      using access = vi.spyOn(syncFs, "accessSync");
      using realpath = vi.spyOn(syncFs, "realpathSync");
      const probe = async () => assertGitHubCliAvailable(env);

      await expect(probe()).rejects.toThrow("GitHub CLI (`gh`) is required");
      await fs.writeFile(executablePath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

      await expect(probe()).resolves.toBeUndefined();
      await fs.rm(executablePath);
      await expect(probe()).rejects.toThrow("GitHub CLI (`gh`) is required");
      expect([
        stat.mock.calls.length,
        access.mock.calls.length,
        realpath.mock.calls.length,
      ]).toEqual([0, 0, 0]);
    });
  });
});
