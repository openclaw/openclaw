// Exercises packaged launcher version provenance without loading the runtime.
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { stageLauncherFixture } from "./helpers/openclaw-launcher-fixture.js";
import { useAutoCleanupTempDirTracker } from "./helpers/temp-dir.js";

const packageVersion = "1.2.3-test";
const checkoutCommit = "abcdef0123456789abcdef0123456789abcdef01";
const buildCommit = "1234567890abcdef1234567890abcdef12345678";
const roots = useAutoCleanupTempDirTracker(afterEach);
const versionOutput = (version = packageVersion) =>
  `OpenClaw ${version} (${buildCommit.slice(0, 7)})\n`;

type LauncherVersionFixtureOptions = {
  buildVersion?: string;
  checkout?: boolean;
  pendingLifecycle?: "complete" | "fail";
};

async function fixture(options: LauncherVersionFixtureOptions = {}): Promise<string> {
  const fixtureRoot = roots.make("openclaw-launcher-version-");
  const write = (name: string, value: string) => fs.writeFile(path.join(fixtureRoot, name), value);
  await stageLauncherFixture(fixtureRoot);
  await write("package.json", JSON.stringify({ name: "openclaw", version: packageVersion }));
  await write(
    "dist/entry.js",
    "throw new Error('version fast path must not load the runtime entry');\n",
  );
  if (options.pendingLifecycle) {
    await write(".openclaw-lifecycle-pending", "pending\n");
    await fs.mkdir(path.join(fixtureRoot, "dist", "infra"), { recursive: true });
    await write(
      "dist/infra/package-lifecycle.js",
      options.pendingLifecycle === "fail"
        ? 'export async function completePendingPackageLifecycle() { throw new Error("fixture postinstall failed"); }\n'
        : 'import fs from "node:fs/promises"; export async function completePendingPackageLifecycle({ packageRoot }) { await fs.rm(new URL(".openclaw-lifecycle-pending", `file://${packageRoot}/`)); }\n',
    );
  }

  await write(
    "dist/build-info.json",
    JSON.stringify({ version: options.buildVersion ?? packageVersion, commit: buildCommit }),
  );
  if (options.checkout) {
    const gitDirectory = path.join(fixtureRoot, "worktree-git");
    await fs.mkdir(gitDirectory, { recursive: true });
    await fs.writeFile(path.join(gitDirectory, "HEAD"), `${checkoutCommit}\n`);
    await write(".git", "gitdir: worktree-git\n");
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

it.each([
  { checkout: true, buildVersion: packageVersion },
  { checkout: false, buildVersion: "2026.8.1" },
])(
  "reports built $buildVersion with checkout=$checkout without loading runtime",
  async (options) => {
    const result = runLauncherVersion(await fixture(options));
    expect(result).toMatchObject({
      status: 0,
      stdout: versionOutput(options.buildVersion),
      stderr: "",
    });
  },
);

it.each(["complete", "fail"] as const)(
  "handles pending lifecycle %s before version output",
  async (pendingLifecycle) => {
    const fixtureRoot = await fixture({ pendingLifecycle });
    const result = runLauncherVersion(fixtureRoot);
    const marker = path.join(fixtureRoot, ".openclaw-lifecycle-pending");
    expect(result).toMatchObject({
      status: pendingLifecycle === "complete" ? 0 : 1,
      stdout: pendingLifecycle === "complete" ? versionOutput() : "",
    });
    if (pendingLifecycle === "complete") {
      await expect(fs.access(marker)).rejects.toHaveProperty("code", "ENOENT");
      return;
    }
    expect(result.stderr).toContain("package lifecycle is incomplete");
    expect(result.stderr).toContain("fixture postinstall failed");
    await expect(fs.readFile(marker, "utf8")).resolves.toBe("pending\n");
  },
);
