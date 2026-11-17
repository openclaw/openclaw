import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
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
    // It crashed partway through its durable plan: one file added, one still pending.
    const plan = path.join(stateDir, ".upgrade-2.0.0-1-1");
    const added = path.join(stateDir, "state", "added.sqlite");
    const pending = path.join(stateDir, "state", "pending.sqlite");
    await fs.mkdir(plan);
    await fs.writeFile(added, "new only");
    await fs.writeFile(pending, "old pending");
    await fs.writeFile(path.join(plan, "pending.next"), "new pending");
    await fs.writeFile(
      path.join(plan, "plan.json"),
      JSON.stringify({
        appVersion: "2.0.0",
        ops: [
          { kind: "add", live: added, next: path.join(plan, "added.next") },
          { kind: "replace", live: pending, next: path.join(plan, "pending.next") },
        ],
      }),
    );

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
    // The previous release finds no plan to finish and none of the trial's files.
    await expect(fs.access(plan)).rejects.toThrow();
    await expect(fs.access(added)).rejects.toThrow();
    expect(await fs.readFile(pending, "utf8")).toBe("old pending");
  });

  it("restores what the trial's build replaced after two upgrades within one version", async () => {
    const { stateDir, prefix } = await setup();
    await fs.cp(
      fileURLToPath(
        new URL("../../test/fixtures/state-corpus-populated/2026.10.10/state/", import.meta.url),
      ),
      stateDir,
      { recursive: true },
    );
    const db = path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
    const env = {
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: path.join(stateDir, "x.json"),
    };
    // Each build of the same package version upgrades state at its first start.
    const upgradeAs = async (buildId: string) => {
      vi.resetModules();
      vi.doMock("../version.js", async (importOriginal) => ({
        ...(await importOriginal<typeof import("../version.js")>()),
        resolveRuntimeServiceBuildId: () => buildId,
      }));
      const { upgradeStateDirectory } = await import("../state/state-upgrade.js");
      const { ChainStepError } = await import("../state/state-upgrade-validate.js");
      vi.doUnmock("../version.js");
      return await upgradeStateDirectory({
        env,
        log: { info: () => {}, warn: () => {} },
        runChain: async () => {
          throw new ChainStepError("injected", "use the generic rebuild");
        },
      });
    };
    const fixtureVersion = new DatabaseSync(db).prepare("PRAGMA user_version").get();
    expect((await upgradeAs("1.0.0-aaa")).status).toBe("upgraded");
    // The previous release served this state; the next commit needs a newer schema.
    const served = new DatabaseSync(db);
    served.exec("CREATE TABLE e2e_served (build TEXT); INSERT INTO e2e_served VALUES ('aaa')");
    served.exec(`PRAGMA user_version = ${Number(fixtureVersion?.user_version)}`);
    served.close();
    const good = await release(prefix, "1.0.0", 'console.log("old");\n');
    await publishGitRelease({ prefix, releaseRoot: good, trial: false });
    const bad = await release(prefix, "1.0.0", 'throw new Error("boot");\n');
    await fs.writeFile(
      path.join(bad, "dist", "build-info.json"),
      JSON.stringify({ version: "1.0.0", buildId: "1.0.0-bbb" }),
    );
    await publishGitRelease({ prefix, releaseRoot: bad, trial: true });
    expect((await upgradeAs("1.0.0-bbb")).status).toBe("upgraded");

    startGateway(prefix);
    startGateway(prefix);
    expect(startGateway(prefix).stdout).toContain("old");

    const restored = new DatabaseSync(db);
    try {
      expect(restored.prepare("SELECT build FROM e2e_served").get()).toEqual({ build: "aaa" });
    } finally {
      restored.close();
    }
  });

  it("resumes an interrupted rollback before the link moves", async () => {
    const { stateDir, prefix } = await setup();
    const good = await release(prefix, "1.0.0", 'console.log("old");\n');
    await publishGitRelease({ prefix, releaseRoot: good, trial: true });
    const bad = await release(prefix, "2.0.0", 'throw new Error("boot");\n');
    await publishGitRelease({ prefix, releaseRoot: bad, trial: true });
    const db = path.join(stateDir, "state", "openclaw.sqlite");
    await fs.mkdir(db, { recursive: true });
    await fs.writeFile(path.join(db, "blocker"), "");
    await fs.writeFile(`${db}.pre-2.0.0`, "old schema");
    const slot = gitReleaseSlot(prefix);
    const target = await fs.readlink(slot);

    startGateway(prefix);
    startGateway(prefix);
    // Restoration fails: the trial still names its release, so the next start retries.
    expect(startGateway(prefix).status).not.toBe(0);
    expect(await fs.readlink(slot)).toBe(target);
    await fs.rm(db, { recursive: true });
    const resumed = startGateway(prefix);

    expect(resumed.stdout).toContain("old");
    expect(await fs.readFile(db, "utf8")).toBe("old schema");
    expect(await fs.readlink(slot)).not.toBe(target);
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

  it("converts a checkout only when its service can be redirected to the launcher", async () => {
    const servicePlan = await import("../cli/update-cli/update-command-service-plan.js");
    const { gatewayServiceOwnsGitInstall } =
      await import("../cli/update-cli/update-command-git.js");
    const { stateDir, prefix } = await setup();
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    const checkout = await release(prefix, "1.0.0", "");
    const service = (entry: string | null, sealed = false) =>
      vi.spyOn(servicePlan, "readGatewayServiceStateForUpdate").mockResolvedValue({
        installed: entry !== null,
        loadState: { status: entry ? "loaded" : "not-loaded" },
        running: entry !== null,
        env: {},
        command: entry ? { programArguments: [process.execPath, entry, "gateway"] } : null,
        runtime: { status: entry ? "running" : "stopped" },
        ...(sealed ? { definitionMutationCapability: { kind: "sealed", reason: "symlink" } } : {}),
      } as Awaited<ReturnType<typeof servicePlan.readGatewayServiceStateForUpdate>>);
    try {
      const entry = path.join(checkout, "dist", "index.js");
      // Run by hand: nothing would start through the release link.
      service(null);
      expect(await gatewayServiceOwnsGitInstall(checkout)).toBe(false);
      service(entry);
      expect(await gatewayServiceOwnsGitInstall(checkout)).toBe(true);
      // A sealed definition keeps starting the checkout, so the switch would never serve.
      service(entry, true);
      expect(await gatewayServiceOwnsGitInstall(checkout)).toBe(false);
      // Once the unit names the launcher, switches need no definition write.
      await publishGitRelease({ prefix, releaseRoot: checkout, trial: false });
      service(await writeGitReleaseLauncher(prefix), true);
      expect(await gatewayServiceOwnsGitInstall(checkout)).toBe(true);
    } finally {
      vi.restoreAllMocks();
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
