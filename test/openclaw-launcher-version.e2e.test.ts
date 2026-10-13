// Exercises packaged launcher version provenance without loading the runtime.
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "./helpers/temp-dir.js";

const packageVersion = "1.2.3-test";
const checkoutCommit = "abcdef0123456789abcdef0123456789abcdef01";
const buildCommit = "1234567890abcdef1234567890abcdef12345678";

type LauncherVersionFixtureOptions = {
  buildVersion?: string;
  checkout?: boolean;
  pendingLifecycle?: "complete" | "fail";
};

async function makeLauncherVersionFixture(
  fixtureRoots: string[],
  options: LauncherVersionFixtureOptions = {},
): Promise<string> {
  const fixtureRoot = makeTempDir(fixtureRoots, "openclaw-launcher-version-");
  for (const filename of [
    "openclaw.mjs",
    "node-host-launcher.mjs",
    "node-compile-cache.mjs",
    "node-version.mjs",
    "node-sqlite.mjs",
    "node-runtime-update.mjs",
    "node-runtime-recovery.mjs",
    "node-runtime-env.mjs",
    "cli-root-options.mjs",
    "gateway-run-argv.mjs",
    "gateway-shutdown-budget.mjs",
  ]) {
    await fs.copyFile(path.resolve(filename), path.join(fixtureRoot, filename));
  }
  await fs.mkdir(path.join(fixtureRoot, "dist"), { recursive: true });
  await fs.writeFile(
    path.join(fixtureRoot, "package.json"),
    JSON.stringify({
      name: "openclaw",
      version: packageVersion,
    }),
  );
  await fs.writeFile(
    path.join(fixtureRoot, "dist", "entry.js"),
    "throw new Error('version fast path must not load the runtime entry');\n",
  );
  if (options.pendingLifecycle) {
    await fs.writeFile(path.join(fixtureRoot, ".openclaw-lifecycle-pending"), "pending\n");
    await fs.mkdir(path.join(fixtureRoot, "dist", "infra"), { recursive: true });
    await fs.writeFile(
      path.join(fixtureRoot, "dist", "infra", "package-lifecycle.js"),
      options.pendingLifecycle === "fail"
        ? 'export async function completePendingPackageLifecycle() { throw new Error("fixture postinstall failed"); }\n'
        : 'import fs from "node:fs/promises"; export async function completePendingPackageLifecycle({ packageRoot }) { await fs.rm(new URL(".openclaw-lifecycle-pending", `file://${packageRoot}/`)); }\n',
    );
  }

  await fs.writeFile(
    path.join(fixtureRoot, "dist", "build-info.json"),
    JSON.stringify({
      version: options.buildVersion ?? packageVersion,
      commit: buildCommit,
    }),
  );
  if (options.checkout) {
    const gitDirectory = path.join(fixtureRoot, "worktree-git");
    await fs.mkdir(gitDirectory, { recursive: true });
    await fs.writeFile(path.join(gitDirectory, "HEAD"), `${checkoutCommit}\n`);
    await fs.writeFile(path.join(fixtureRoot, ".git"), "gitdir: worktree-git\n");
  }

  return fixtureRoot;
}

function runLauncherVersion(fixtureRoot: string) {
  return spawnSync(process.execPath, [path.join(fixtureRoot, "openclaw.mjs"), "--version"], {
    cwd: fixtureRoot,
    env: {
      ...process.env,
      GIT_COMMIT: undefined,
      GIT_SHA: undefined,
      OPENCLAW_CONTAINER: undefined,
    },
    encoding: "utf8",
  });
}

describe("openclaw launcher version provenance", () => {
  const fixtureRoots: string[] = [];

  afterEach(() => {
    cleanupTempDirs(fixtureRoots);
  });

  it("reports the packaged build rather than the current linked checkout", async () => {
    const fixtureRoot = await makeLauncherVersionFixture(fixtureRoots, {
      checkout: true,
    });

    const result = runLauncherVersion(fixtureRoot);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`OpenClaw ${packageVersion} (${buildCommit.slice(0, 7)})\n`);
    expect(result.stderr).toBe("");
  });

  it("reports the built version when the source package version moved ahead", async () => {
    const fixtureRoot = await makeLauncherVersionFixture(fixtureRoots, {
      buildVersion: "2026.8.1",
    });

    // The launcher answers bare --version before the runtime entry loads, so a
    // checkout that pulled without rebuilding must not report the unbuilt version.
    const result = runLauncherVersion(fixtureRoot);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(`OpenClaw 2026.8.1 (${buildCommit.slice(0, 7)})\n`);
    expect(result.stderr).toBe("");
  });

  it("completes a pending package lifecycle before the version fast path", async () => {
    const fixtureRoot = await makeLauncherVersionFixture(fixtureRoots, {
      pendingLifecycle: "complete",
    });

    const result = runLauncherVersion(fixtureRoot);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(`OpenClaw ${packageVersion} (${buildCommit.slice(0, 7)})\n`);
    await expect(
      fs.access(path.join(fixtureRoot, ".openclaw-lifecycle-pending")),
    ).rejects.toHaveProperty("code", "ENOENT");
  });

  it("fails closed before reporting a version when package lifecycle completion fails", async () => {
    const fixtureRoot = await makeLauncherVersionFixture(fixtureRoots, {
      pendingLifecycle: "fail",
    });

    const result = runLauncherVersion(fixtureRoot);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("package lifecycle is incomplete");
    expect(result.stderr).toContain("fixture postinstall failed");
    await expect(
      fs.readFile(path.join(fixtureRoot, ".openclaw-lifecycle-pending"), "utf8"),
    ).resolves.toBe("pending\n");
  });
});
