import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkShellCompletionStatus } from "../commands/doctor-completion.js";
import { installCompletion } from "./completion-runtime.js";

describe("completion runtime", () => {
  const originalHome = process.env.HOME;
  const originalShell = process.env.SHELL;
  const originalStateDir = process.env.OPENCLAW_STATE_DIR;

  let homeDir = "";
  let stateDir = "";

  beforeEach(async () => {
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-completion-home-"));
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-completion-state-"));
    process.env.HOME = homeDir;
    process.env.SHELL = "/bin/zsh";
    process.env.OPENCLAW_STATE_DIR = stateDir;
  });

  afterEach(async () => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalShell === undefined) {
      delete process.env.SHELL;
    } else {
      process.env.SHELL = originalShell;
    }
    if (originalStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = originalStateDir;
    }

    await fs.rm(homeDir, { recursive: true, force: true });
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("installs dynamic profile sourcing without writing completion cache files", async () => {
    await installCompletion("zsh", true, "openclaw");

    const profile = await fs.readFile(path.join(homeDir, ".zshrc"), "utf-8");
    expect(profile).toContain("source <(openclaw completion --shell zsh)");
    await expect(fs.stat(path.join(stateDir, "completions"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rewrites a retired state-dir completion cache profile line", async () => {
    const retiredCachePath = path.join(stateDir, "completions", "openclaw.zsh");
    await fs.writeFile(path.join(homeDir, ".zshrc"), `source ${retiredCachePath}\n`, "utf-8");

    const status = await checkShellCompletionStatus("openclaw");
    expect(status).toMatchObject({
      profileInstalled: false,
      retiredCachePath,
      shell: "zsh",
      usesRetiredCache: true,
    });

    await installCompletion("zsh", true, "openclaw", {
      retiredCachePath: status.retiredCachePath,
    });

    const profile = await fs.readFile(path.join(homeDir, ".zshrc"), "utf-8");
    expect(profile).toContain("source <(openclaw completion --shell zsh)");
    expect(profile).not.toContain(retiredCachePath);
  });
});
