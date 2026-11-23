import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import {
  finishEarlyGitReleaseRecovery,
  runCommand,
  runEarlyGitReleaseRecovery,
  startEarlyGitReleaseRecovery,
  type RecoveryOutcome,
  type RecoveryPlan,
  type RunCommand,
  type StartDeps,
} from "./update-early-release-recovery.js";

const roots: string[] = [];
afterEach(() => cleanupTempDirs(roots));

function git(cwd: string, ...args: string[]) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

/**
 * A checkout on `main` one commit behind its upstream, and the target built by the early updater
 * as a release worktree at `<state>/git-install/releases/r1/build` beside the legacy link.
 */
function install() {
  const base = makeTempDir(roots, "openclaw-early-recovery-");
  const upstream = path.join(base, "upstream.git");
  const checkout = path.join(base, "checkout");
  spawnSync("git", ["init", "-q", "--bare", "-b", "main", upstream]);
  spawnSync("git", ["clone", "-q", upstream, checkout]);
  for (const [key, value] of Object.entries({
    "user.name": "T",
    "user.email": "t@example.invalid",
  })) {
    git(checkout, "config", key, value);
  }
  fs.writeFileSync(path.join(checkout, ".gitignore"), "dist/\n");
  git(checkout, "add", ".");
  git(checkout, "commit", "-qm", "a");
  const before = git(checkout, "rev-parse", "HEAD");
  git(checkout, "commit", "-q", "--allow-empty", "-m", "b");
  git(checkout, "push", "-q", "-u", "origin", "main");
  const target = git(checkout, "rev-parse", "HEAD");
  git(checkout, "reset", "-q", "--hard", before);
  fs.mkdirSync(path.join(checkout, "dist"));
  fs.writeFileSync(
    path.join(checkout, "dist", "build-info.json"),
    JSON.stringify({ commit: before }),
  );
  fs.writeFileSync(path.join(checkout, "dist", "index.js"), "");
  const stateDir = path.join(base, "state");
  const prefix = path.join(stateDir, "git-install");
  const root = path.join(prefix, "releases", "r1", "build");
  fs.mkdirSync(path.dirname(root), { recursive: true });
  git(checkout, "worktree", "add", "-q", "--detach", root, target);
  fs.mkdirSync(path.join(prefix, "lib", "node_modules"), { recursive: true });
  fs.symlinkSync(checkout, path.join(prefix, "lib", "node_modules", "openclaw"));
  const bin = path.join(base, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, "openclaw"),
    `#!/bin/sh\necho "OpenClaw 1 (${before.slice(0, 7)})"\n`,
    { mode: 0o755 },
  );
  const home = path.join(base, "home");
  const serviceFile = path.join(home, ".config", "systemd", "user", "openclaw-gateway.service");
  const systemd: string[][] = [];
  const deps: StartDeps & { active: string; systemdRun: number } = {
    platform: "linux",
    env: { HOME: home, PATH: bin, OPENCLAW_STATE_DIR: stateDir },
    active: "inactive",
    systemdRun: 0,
    run: async (argv, options) => {
      if (argv[0] === "git" || argv[0] === bin + "/openclaw") {
        return runCommand(argv, options);
      }
      systemd.push(argv);
      const code = argv[0] === "systemd-run" ? deps.systemdRun : 0;
      return { code, output: argv.includes("is-active") ? deps.active : "" };
    },
    freeBytes: () => 64 * 1024 ** 3,
    findDriver: () => ({ pid: 4242, start: "77" }),
    readService: async () => ({
      sourcePath: serviceFile,
      entry: path.join(checkout, "dist", "index.js"),
      environment: { OPENCLAW_STATE_DIR: stateDir },
    }),
  };
  const change = { root, stateDir, prefix: fs.realpathSync(prefix), state: 40, agent: 42 };
  return { checkout, target, root, prefix: change.prefix, change, deps, systemd };
}

it("keeps the built release and starts the runner as a transient user service", async () => {
  const fx = install();
  const result = await startEarlyGitReleaseRecovery(fx.change, fx.deps);

  expect(result).toEqual({ started: true, unit: "openclaw-update-recovery", target: fx.target });
  const release = path.join(fx.prefix, "recovery", "openclaw");
  expect(fs.existsSync(fx.root)).toBe(false);
  expect(git(release, "rev-parse", "HEAD")).toBe(fx.target);
  const started = fx.systemd.find((argv) => argv[0] === "systemd-run")!;
  expect(started).toEqual(
    expect.arrayContaining([
      "--user",
      "--unit=openclaw-update-recovery",
      "--property=Restart=on-abnormal",
    ]),
  );
  expect(started.at(-2)).toBe("--early-release-recovery");
  expect(started.at(-3)).toBe(
    path.join(release, "dist", "infra", "update-migrated-finalize.worker.js"),
  );
  expect(JSON.parse(started.at(-1)!)).toMatchObject({
    checkout: fs.realpathSync(fx.checkout),
    branch: "main",
    target: fx.target,
    driver: { pid: 4242, start: "77" },
  });
});

it.each([
  ["not linux", (fx: ReturnType<typeof install>) => void (fx.deps.platform = "darwin"), "Linux"],
  [
    "dirty",
    (fx: ReturnType<typeof install>) =>
      fs.writeFileSync(path.join(fx.checkout, ".gitignore"), "x\n"),
    "uncommitted",
  ],
  [
    "detached",
    (fx: ReturnType<typeof install>) => git(fx.checkout, "checkout", "-q", "--detach"),
    "not on a branch",
  ],
  [
    "diverged",
    (fx: ReturnType<typeof install>) =>
      git(fx.checkout, "commit", "-q", "--allow-empty", "-m", "c"),
    "cannot fast-forward",
  ],
  [
    "local commit at target",
    (fx: ReturnType<typeof install>) => {
      git(fx.checkout, "push", "-q", "--force", "origin", "HEAD:main");
      git(fx.checkout, "fetch", "-q");
      git(fx.checkout, "merge", "-q", "--ff-only", fx.target);
    },
    "local commits",
  ],
  [
    "no upstream",
    (fx: ReturnType<typeof install>) => git(fx.checkout, "branch", "-q", "--unset-upstream"),
    "no upstream",
  ],
  ["low disk", (fx: ReturnType<typeof install>) => void (fx.deps.freeBytes = () => 1), "4 GiB"],
  [
    "other service",
    (fx: ReturnType<typeof install>) =>
      void (fx.deps.readService = async () => ({
        sourcePath: "/etc/systemd/system/openclaw-gateway.service",
      })),
    "managed systemd user service",
  ],
  [
    "other state",
    (fx: ReturnType<typeof install>) => {
      const read = fx.deps.readService;
      fx.deps.readService = async (env) => ({
        ...(await read(env)),
        environment: { OPENCLAW_STATE_DIR: "/elsewhere" },
      });
    },
    "another state directory",
  ],
  [
    "other PATH cli",
    (fx: ReturnType<typeof install>) =>
      fs.writeFileSync(
        path.join(fx.deps.env.PATH!, "openclaw"),
        "#!/bin/sh\necho 'OpenClaw 2 (fedcba9)'\n",
      ),
    "on PATH runs another",
  ],
  [
    "systemd-run fails",
    (fx: ReturnType<typeof install>) => void (fx.deps.systemdRun = 1),
    "systemd-run failed",
  ],
])("changes nothing and names the reason: %s", async (_name, arrange, reason) => {
  const fx = install();
  arrange(fx);
  const result = await startEarlyGitReleaseRecovery(fx.change, fx.deps);

  expect(result).toMatchObject({ started: false, reason: expect.stringContaining(reason) });
  expect(git(fx.root, "rev-parse", "HEAD")).toBe(fx.target);
  expect(fs.existsSync(path.join(fx.prefix, "recovery"))).toBe(false);
});

it("starts nothing while another recovery runs", async () => {
  const fx = install();
  fx.deps.active = "active";
  expect(await startEarlyGitReleaseRecovery(fx.change, fx.deps)).toEqual({
    started: false,
    running: "openclaw-update-recovery",
  });
  expect(fs.existsSync(fx.root)).toBe(true);
  expect(fx.systemd.some((argv) => argv[0] === "systemd-run")).toBe(false);
});

/** The runner's world: a service file, the kept release, and scripted command outcomes. */
function runner(
  fail: Record<string, number> = {},
  service = "ExecStart=node /checkout/dist/index.js\n",
) {
  const base = makeTempDir(roots, "openclaw-early-runner-");
  const release = path.join(base, "git-install", "recovery", "openclaw");
  fs.mkdirSync(release, { recursive: true });
  const serviceFile = path.join(base, "openclaw-gateway.service");
  fs.writeFileSync(serviceFile, service.replace("RELEASE", release));
  const plan: RecoveryPlan = {
    unit: "openclaw-update-recovery",
    checkout: path.join(base, "checkout"),
    branch: "main",
    target: "b".repeat(40),
    release,
    prefix: path.join(base, "git-install"),
    serviceFile,
    fromVersion: "2026.11.4",
    driver: { pid: 1, start: "1" },
  };
  const calls: string[] = [];
  const records: RecoveryOutcome[] = [];
  let alive = 2;
  let migrated = false;
  const run: RunCommand = async (argv, options) => {
    const root = argv[1]?.endsWith("openclaw.mjs")
      ? options?.cwd === release
        ? "release"
        : "checkout"
      : "";
    const name = [root, ...argv.filter((arg) => !/^[/-]/u.test(arg))].join(" ").trim();
    calls.push(name);
    if (name === "release gateway start") {
      migrated = true;
    }
    if (name === "git rev-parse HEAD") {
      return { code: 0, output: "a".repeat(40) };
    }
    return { code: fail[name] ?? 0, output: name === "git symbolic-ref HEAD" ? "main" : "" };
  };
  const deps = {
    run,
    log: () => {},
    driverAlive: () => alive-- > 0,
    restarts: async () => 0,
    migrated: () => migrated,
    record: async (outcome: RecoveryOutcome) => void records.push(outcome),
    finish: async () => ({ code: 0, output: "" }),
    now: () => calls.length * 1000,
    sleep: async () => {},
  };
  return { plan, calls, records, deps, serviceFile, release };
}

const SWITCH_TO_RELEASE = ["release gateway install", "release gateway start"];
const BUILD = ["pnpm install", "pnpm build"];
const SWITCH_TO_CHECKOUT = ["checkout gateway install", "checkout gateway start"];

it("waits for the updater, fast-forwards, serves the release while the checkout builds, then serves the checkout", async () => {
  const fx = runner();
  await runEarlyGitReleaseRecovery(fx.plan, fx.deps);

  expect(fx.calls.filter((call) => !call.startsWith("git") || call.includes("merge"))).toEqual([
    `git merge ${"b".repeat(40)}`,
    ...SWITCH_TO_RELEASE,
    ...BUILD,
    ...SWITCH_TO_CHECKOUT,
  ]);
  expect(fx.records).toEqual([]);
});

it("a failed fast-forward changes nothing and removes the kept release", async () => {
  const fx = runner({ [`git merge ${"b".repeat(40)}`]: 1 });
  await runEarlyGitReleaseRecovery(fx.plan, fx.deps);

  expect(fx.calls.some((call) => call.includes("gateway") || call.startsWith("pnpm"))).toBe(false);
  expect(fs.existsSync(path.dirname(fx.release))).toBe(false);
  expect(fx.records).toEqual([]);
});

it("a release that does not start before migrating gets the previous service back", async () => {
  const fx = runner({ "release gateway install": 1 });
  const before = fs.readFileSync(fx.serviceFile, "utf8");
  await runEarlyGitReleaseRecovery(fx.plan, fx.deps);

  expect(fs.readFileSync(fx.serviceFile, "utf8")).toBe(before);
  expect(fx.calls).toContain("systemctl daemon-reload");
  expect(fx.calls.some((call) => call.startsWith("pnpm"))).toBe(false);
  expect(fs.existsSync(fx.release)).toBe(false);
});

it("a failed build leaves the Gateway on the release and records the next step", async () => {
  const fx = runner({ "pnpm build": 1 });
  await runEarlyGitReleaseRecovery(fx.plan, fx.deps);

  expect(fx.calls.filter((call) => call.includes("gateway"))).toEqual(SWITCH_TO_RELEASE);
  expect(fx.records).toEqual([
    expect.objectContaining({
      status: "failed",
      reason: "early-release-recovery-build-failed",
      nextAction: expect.stringContaining(
        "pnpm install --frozen-lockfile && pnpm build && openclaw gateway install --force",
      ),
    }),
  ]);
  expect(fs.existsSync(fx.release)).toBe(true);
});

it("a rebuilt checkout that does not start puts the Gateway back on the release", async () => {
  const fx = runner({ "checkout gateway start": 1 });
  await runEarlyGitReleaseRecovery(fx.plan, fx.deps);

  expect(fx.calls.filter((call) => call.includes("gateway")).slice(-2)).toEqual(SWITCH_TO_RELEASE);
  expect(fx.records).toEqual([
    expect.objectContaining({ status: "failed", reason: "early-release-recovery-switch-failed" }),
  ]);
});

it("a restarted runner whose service already serves the release resumes at the build", async () => {
  const fx = runner({}, "ExecStart=node RELEASE/dist/index.js\n");
  await runEarlyGitReleaseRecovery(fx.plan, fx.deps);

  expect(fx.calls.filter((call) => call.includes("gateway") || call.startsWith("pnpm"))).toEqual([
    ...BUILD,
    ...SWITCH_TO_CHECKOUT,
  ]);
});

it("removes what the early layout left and records the outcome", async () => {
  const fx = runner();
  const releases = path.join(fx.plan.prefix, "releases");
  fs.mkdirSync(path.join(releases, "git-old", "lib", "node_modules", "openclaw"), {
    recursive: true,
  });
  fs.mkdirSync(path.join(releases, "current-layout", "openclaw"), { recursive: true });
  fs.writeFileSync(path.join(releases, ".trial"), JSON.stringify({ target: "x", attempts: 1 }));
  fs.mkdirSync(path.join(fx.plan.prefix, "lib", "node_modules"), { recursive: true });
  fs.symlinkSync(
    path.join(releases, "git-old"),
    path.join(fx.plan.prefix, "lib", "node_modules", "openclaw"),
  );
  await finishEarlyGitReleaseRecovery(fx.plan, { downtimeMs: 21_000 }, fx.deps);

  expect(fs.readdirSync(fx.plan.prefix).toSorted()).toEqual(["releases"]);
  expect(fs.readdirSync(releases)).toEqual(["current-layout"]);
  expect(fx.calls).toContain("git worktree prune");
  expect(fx.records).toEqual([
    expect.objectContaining({
      status: "succeeded",
      downtimeMs: 21_000,
      detail: expect.stringContaining(
        "Removed the old-format trial, the old release link, releases/git-old, recovery.",
      ),
    }),
  ]);
});
