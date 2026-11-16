import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeGitReleaseLauncher } from "./git-release-launcher.js";
import {
  GIT_RELEASE_TRIAL,
  gitReleaseSlot,
  resolveGitReleaseEntrypointForLauncher,
  resolveGitReleaseLauncherForEntrypoint,
  usesGitReleases,
} from "./git-release-paths.js";
import { createGitReleaseDirs, publishGitRelease, settleGitReleaseTrial } from "./git-release.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function release(prefix: string, version: string, entry: string) {
  const root = (await createGitReleaseDirs(prefix)).releaseRoot;
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
    // The new release's boot upgraded state by copy and swap before crashing:
    // the WAL had a predecessor, the trial created SHM and seal files from scratch.
    await fs.writeFile(`${db}.pre-2.0.0`, "old schema");
    await fs.writeFile(`${db}-wal.pre-2.0.0`, "old wal");
    await fs.writeFile(db, "new schema");
    await fs.writeFile(`${db}-wal`, "new wal");
    await fs.writeFile(`${db}-shm`, "new shm");
    await fs.writeFile(`${db}.seal`, "new seal");

    expect(startGateway(prefix).status).not.toBe(0);
    expect(startGateway(prefix).status).not.toBe(0);
    const third = startGateway(prefix);

    expect(third.status).toBe(0);
    expect(third.stdout).toContain(`old ${path.join(gitReleaseSlot(prefix), "dist", "index.js")}`);
    expect(third.stderr).toContain("failed to start twice");
    expect(await fs.readFile(db, "utf8")).toBe("old schema");
    expect(await fs.readFile(`${db}-wal`, "utf8")).toBe("old wal");
    await expect(fs.access(`${db}-shm`)).rejects.toThrow();
    await expect(fs.access(`${db}.seal`)).rejects.toThrow();
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

  it("keeps a service unit that names the launcher across release switches", async () => {
    const { inspectManagedGatewayServiceBeforeUpdate } =
      await import("../cli/update-cli/update-command-service-plan.js");
    const { prefix } = await setup();
    await publishGitRelease({
      prefix,
      releaseRoot: await release(prefix, "1.0.0", ""),
      trial: false,
    });
    const launcher = path.join(prefix, "openclaw-launcher.mjs");
    const verdict = await inspectManagedGatewayServiceBeforeUpdate({
      root: gitReleaseSlot(prefix),
      state: {
        installed: true,
        loadState: { status: "loaded" },
        running: true,
        env: {},
        command: { programArguments: [process.execPath, launcher, "gateway", "--port", "1"] },
        runtime: { status: "running" },
      },
    });

    expect(verdict).toMatchObject({ kind: "owned", refreshDefinition: false });
  });

  it("keeps a checkout without an owning Gateway service on the in-place runner", async () => {
    const { stateDir } = await setup();
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    try {
      // Nothing would start through the release link, so the next start would run the old commit.
      expect(usesGitReleases(false, false)).toBe(false);
      expect(usesGitReleases(false, true)).toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("takes the in-place runner with a reason when the release link cannot be used", async () => {
    const { stateDir, prefix } = await setup();
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    try {
      expect(usesGitReleases(false, true)).toBe(true);
      // Something other than a release link sits at the package path.
      await fs.mkdir(gitReleaseSlot(prefix), { recursive: true });
      const reasons: string[] = [];
      expect(usesGitReleases(false, true, (reason) => reasons.push(reason))).toBe(false);
      expect(reasons).toEqual([`${gitReleaseSlot(prefix)} is not a release link`]);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
