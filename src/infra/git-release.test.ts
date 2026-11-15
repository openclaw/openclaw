import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeGitReleaseLauncher } from "./git-release-launcher.js";
import {
  GIT_RELEASE_TRIAL,
  gitReleaseSlot,
  resolveGitReleaseEntrypointForLauncher,
  resolveGitReleaseLauncherForEntrypoint,
} from "./git-release-paths.js";
import {
  createGitReleaseWorktreeDir,
  publishGitRelease,
  settleGitReleaseTrial,
} from "./git-release.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function release(prefix: string, version: string, entry: string) {
  const root = await createGitReleaseWorktreeDir(prefix, version);
  await fs.mkdir(path.join(root, "dist"), { recursive: true });
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "openclaw", version }),
  );
  await fs.writeFile(path.join(root, "dist", "index.js"), entry);
  return root;
}

async function setup() {
  const stateDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "git-release-")));
  roots.push(stateDir);
  return { stateDir, prefix: path.join(stateDir, "git-install") };
}

const startGateway = (prefix: string, env: NodeJS.ProcessEnv = {}) =>
  spawnSync(process.execPath, [path.join(prefix, "openclaw-launcher.mjs"), "gateway"], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });

describe.skipIf(process.platform === "win32")("git releases", () => {
  it("switches back and restores upgraded state after two failed trial starts", async () => {
    const { stateDir, prefix } = await setup();
    const good = await release(prefix, "1.0.0", 'console.log("old " + process.argv[1]);\n');
    await publishGitRelease({ prefix, releaseRoot: good, trial: true });
    const bad = await release(prefix, "2.0.0", 'throw new Error("boot");\n');
    const db = path.join(stateDir, "state", "openclaw.sqlite");
    await fs.mkdir(path.dirname(db), { recursive: true });
    await publishGitRelease({ prefix, releaseRoot: bad, trial: true });
    // The new release's boot upgraded state by copy and swap before crashing.
    await fs.writeFile(`${db}.pre-2.0.0`, "old schema");
    await fs.writeFile(db, "new schema");

    expect(startGateway(prefix).status).not.toBe(0);
    expect(startGateway(prefix).status).not.toBe(0);
    const third = startGateway(prefix);

    expect(third.status).toBe(0);
    expect(third.stdout).toContain(`old ${path.join(gitReleaseSlot(prefix), "dist", "index.js")}`);
    expect(third.stderr).toContain("failed to start twice");
    expect(await fs.readFile(db, "utf8")).toBe("old schema");
    await expect(fs.access(path.join(prefix, "releases", GIT_RELEASE_TRIAL))).rejects.toThrow();
  });

  it("stops counting once the trial release reports ready", async () => {
    const { prefix } = await setup();
    await publishGitRelease({
      prefix,
      releaseRoot: await release(prefix, "1.0.0", ""),
      trial: false,
    });
    await publishGitRelease({
      prefix,
      releaseRoot: await release(prefix, "2.0.0", 'console.log("new");\n'),
      trial: true,
    });
    const trial = path.join(prefix, "releases", GIT_RELEASE_TRIAL);
    expect(JSON.parse(await fs.readFile(trial, "utf8"))).toMatchObject({ version: "2.0.0" });

    expect(startGateway(prefix).stdout).toContain("new");
    await settleGitReleaseTrial(gitReleaseSlot(prefix));

    await expect(fs.access(trial)).rejects.toThrow();
  });

  it("maps a release entry to its launcher and back", async () => {
    const { prefix } = await setup();
    await publishGitRelease({
      prefix,
      releaseRoot: await release(prefix, "1.0.0", ""),
      trial: false,
    });
    const entry = path.join(gitReleaseSlot(prefix), "dist", "index.js");
    const launcher = resolveGitReleaseLauncherForEntrypoint(entry);

    expect(launcher).toBe(path.join(prefix, "openclaw-launcher.mjs"));
    expect(resolveGitReleaseEntrypointForLauncher(launcher!)).toBe(entry);
    expect(resolveGitReleaseLauncherForEntrypoint("/opt/openclaw/dist/index.js")).toBeNull();
    expect(await writeGitReleaseLauncher(prefix)).toBe(launcher);
  });
});
