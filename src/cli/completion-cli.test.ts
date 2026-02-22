import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  installCompletion,
  resolveCompletionCachePath,
  uninstallCompletionFromProfile,
} from "./completion-cli.js";

const originalHome = process.env.HOME;
const originalStateDir = process.env.OPENCLAW_STATE_DIR;
const originalUserProfile = process.env.USERPROFILE;
const tempRoots: string[] = [];

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function setupTempHome(): Promise<{ home: string }> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-completion-"));
  tempRoots.push(home);
  process.env.HOME = home;
  process.env.OPENCLAW_STATE_DIR = path.join(home, "state");
  process.env.USERPROFILE = home;
  return { home };
}

afterEach(async () => {
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  if (originalStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = originalStateDir;
  }
  if (originalUserProfile === undefined) {
    delete process.env.USERPROFILE;
  } else {
    process.env.USERPROFILE = originalUserProfile;
  }

  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe("completion profile install/uninstall", () => {
  it("installs zsh completion with a file-exists guard", async () => {
    const { home } = await setupTempHome();
    const profilePath = path.join(home, ".zshrc");
    const cachePath = resolveCompletionCachePath("zsh", "openclaw");

    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    await fs.writeFile(cachePath, "# completion", "utf-8");
    await fs.writeFile(profilePath, "", "utf-8");

    await installCompletion("zsh", true, "openclaw");

    const profile = await fs.readFile(profilePath, "utf-8");
    expect(profile).toContain(
      `# OpenClaw Completion\n[ -r "${cachePath}" ] && source "${cachePath}"`,
    );
    expect(profile).not.toMatch(new RegExp(`^\\s*source\\s+"${escapeRegex(cachePath)}"\\s*$`, "m"));
  });

  it("removes stale completion source lines even when cache is already gone", async () => {
    const { home } = await setupTempHome();
    const profilePath = path.join(home, ".zshrc");
    const staleCachePath = path.join(home, ".openclaw", "completions", "openclaw.zsh");

    await fs.writeFile(
      profilePath,
      `export OPENCLAW_TEST=1\nsource "${staleCachePath}"\n`,
      "utf-8",
    );

    const removed = await uninstallCompletionFromProfile("zsh", "openclaw");
    const profile = await fs.readFile(profilePath, "utf-8");

    expect(removed).toBe(true);
    expect(profile).toBe("export OPENCLAW_TEST=1\n");
  });
});
