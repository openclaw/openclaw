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
 * Git runs for real; systemd, pnpm and the Gateway service are scripted.
 */
function install() {
  const base = makeTempDir(roots, "openclaw-early-recovery-");
  const [upstream, checkout, bin] = ["upstream.git", "checkout", "bin"].map((dir) =>
    path.join(base, dir),
  );
  spawnSync("git", ["init", "-q", "--bare", "-b", "main", upstream!]);
  spawnSync("git", ["clone", "-q", upstream!, checkout!]);
  git(checkout!, "config", "user.email", "t@example.invalid");
  git(checkout!, "config", "user.name", "T");
  fs.writeFileSync(path.join(checkout!, ".gitignore"), "dist/\n");
  git(checkout!, "add", ".");
  git(checkout!, "commit", "-qm", "a");
  const before = git(checkout!, "rev-parse", "HEAD");
  git(checkout!, "commit", "-q", "--allow-empty", "-m", "b");
  git(checkout!, "push", "-q", "-u", "origin", "main");
  const target = git(checkout!, "rev-parse", "HEAD");
  git(checkout!, "reset", "-q", "--hard", before);
  fs.mkdirSync(path.join(checkout!, "dist"));
  fs.writeFileSync(path.join(checkout!, "dist", "index.js"), "");
  fs.writeFileSync(path.join(checkout!, "dist", "build-info.json"), `{"commit":"${before}"}`);
  const stateDir = path.join(base, "state");
  const prefix = path.join(stateDir, "git-install");
  const root = path.join(prefix, "releases", "r1", "build");
  git(checkout!, "worktree", "add", "-q", "--detach", root, target);
  fs.mkdirSync(path.join(prefix, "lib", "node_modules"), { recursive: true });
  fs.symlinkSync(checkout!, path.join(prefix, "lib", "node_modules", "openclaw"));
  fs.mkdirSync(bin!);
  const cli = path.join(bin!, "openclaw");
  fs.writeFileSync(cli, `#!/bin/sh\necho "OpenClaw 1 (${before.slice(0, 7)})"\n`, { mode: 0o755 });
  const home = path.join(base, "home");
  const systemd: string[][] = [];
  const deps: StartDeps & { active: string; systemdRun: number } = {
    platform: "linux",
    env: { HOME: home, PATH: bin, OPENCLAW_STATE_DIR: stateDir },
    active: "inactive",
    systemdRun: 0,
    run: async (argv, options) => {
      if (argv[0] === "git" || argv[0] === cli) {
        return runCommand(argv, options);
      }
      systemd.push(argv);
      const code = argv[0] === "systemd-run" ? deps.systemdRun : 0;
      return { code, output: argv.includes("is-active") ? deps.active : "" };
    },
    freeBytes: () => 64 * 1024 ** 3,
    findDriver: () => ({ pid: 4242, start: "77" }),
    readService: async () => ({
      sourcePath: path.join(home, ".config", "systemd", "user", "openclaw-gateway.service"),
      entry: path.join(checkout!, "dist", "index.js"),
      environment: { OPENCLAW_STATE_DIR: stateDir },
    }),
  };
  const pending = { state: 40, agent: 42 };
  const change = { root, stateDir, prefix: fs.realpathSync(prefix), pending };
  return { checkout: checkout!, target, root, prefix: change.prefix, change, deps, systemd, cli };
}

it("keeps the built release and starts the runner as a transient user service", async () => {
  const fx = install();
  const result = await startEarlyGitReleaseRecovery(fx.change, fx.deps);

  expect(result).toEqual({ started: true, unit: "openclaw-update-recovery", target: fx.target });
  const release = path.join(fx.prefix, "recovery", "openclaw");
  expect(fs.existsSync(fx.root)).toBe(false);
  expect(git(release, "rev-parse", "HEAD")).toBe(fx.target);
  const argv = fx.systemd.find(([command]) => command === "systemd-run")!;
  expect(argv).toEqual(
    expect.arrayContaining(["--user", "--unit=openclaw-update-recovery", "--collect"]),
  );
  expect(argv).toContain("--property=Restart=on-abnormal");
  expect(argv.slice(-3, -1)).toEqual([
    path.join(release, "dist", "infra", "update-migrated-finalize.worker.js"),
    "--early-release-recovery",
  ]);
  expect(JSON.parse(argv.at(-1)!)).toMatchObject({
    checkout: fs.realpathSync(fx.checkout),
    branch: "main",
    target: fx.target,
    driver: { pid: 4242, start: "77" },
  });
});

type Fx = ReturnType<typeof install>;
const refusals: Array<[string, (fx: Fx) => unknown]> = [
  ["Linux systemd user service", (fx) => (fx.deps.platform = "darwin")],
  ["uncommitted changes", (fx) => fs.writeFileSync(path.join(fx.checkout, ".gitignore"), "x")],
  ["not on a branch", (fx) => git(fx.checkout, "checkout", "-q", "--detach")],
  ["cannot fast-forward", (fx) => git(fx.checkout, "commit", "-q", "--allow-empty", "-m", "c")],
  [
    "local commits that are not upstream",
    (fx) => {
      git(fx.checkout, "push", "-q", "--force", "origin", "HEAD:main");
      git(fx.checkout, "merge", "-q", "--ff-only", fx.target);
    },
  ],
  ["has no upstream", (fx) => git(fx.checkout, "branch", "-q", "--unset-upstream")],
  ["4 GiB", (fx) => (fx.deps.freeBytes = () => 1)],
  ["not a managed systemd user service", (fx) => (fx.deps.readService = async () => null)],
  [
    "another state directory",
    (fx) => {
      const read = fx.deps.readService;
      fx.deps.readService = async (env) => ({
        ...(await read(env)),
        environment: { OPENCLAW_STATE_DIR: "/elsewhere" },
      });
    },
  ],
  [
    "on PATH runs another",
    (fx) => fs.writeFileSync(fx.cli, "#!/bin/sh\necho 'OpenClaw (fedcba9)'"),
  ],
  ["systemd-run failed", (fx) => (fx.deps.systemdRun = 1)],
];

it.each(refusals)("changes nothing and says why: %s", async (reason, arrange) => {
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
  expect(fx.systemd.some(([command]) => command === "systemd-run")).toBe(false);
});

/** The runner's world: a service definition, the kept release, and scripted command outcomes. */
function runner(fail: Record<string, number>, servesRelease = false) {
  const base = makeTempDir(roots, "openclaw-early-runner-");
  const release = path.join(base, "git-install", "recovery", "openclaw");
  fs.mkdirSync(release, { recursive: true });
  const serviceFile = path.join(base, "openclaw-gateway.service");
  const original = `ExecStart=node ${servesRelease ? release : "/checkout"}/dist/index.js\n`;
  fs.writeFileSync(serviceFile, original);
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
    const cli = argv[1]?.endsWith("openclaw.mjs") ? path.dirname(argv[1]) : "";
    const role = cli === release ? "release" : cli ? "checkout" : "";
    const name = [role, ...argv.filter((arg) => !/^[/-]/u.test(arg))].join(" ").trim();
    calls.push(name);
    if (name.endsWith("gateway install")) {
      // Like the real install, the definition changes even when the start then fails.
      fs.writeFileSync(serviceFile, `ExecStart=node ${cli}/dist/index.js\n`);
    }
    migrated ||= name === "release gateway start";
    // A resumed runner already fast-forwarded the checkout.
    const head = (servesRelease ? "b" : "a").repeat(40);
    const output = { "git rev-parse HEAD": head, "git symbolic-ref HEAD": "main" }[name];
    return { code: fail[name] ?? 0, output: output ?? "" };
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
  return { plan, calls, records, deps, serviceFile, release, original };
}

const TO_RELEASE = ["release gateway install", "release gateway start"];
const BUILD = ["pnpm install", "pnpm build"];
const TO_CHECKOUT = ["checkout gateway install", "checkout gateway start"];
const MERGE = `git merge ${"b".repeat(40)}`;

it.each([
  [
    "serves the release while the checkout builds",
    {},
    false,
    [...TO_RELEASE, ...BUILD, ...TO_CHECKOUT],
    undefined,
  ],
  ["resumes at the build once the release serves", {}, true, [...BUILD, ...TO_CHECKOUT], undefined],
  ["changes nothing when the fast-forward fails", { [MERGE]: 1 }, false, [], undefined],
  [
    "puts back the previous service when the release fails before migrating",
    { "release gateway install": 1 },
    false,
    [
      "release gateway install",
      "systemctl daemon-reload",
      "systemctl restart openclaw-gateway.service",
    ],
    undefined,
  ],
  [
    "keeps the release serving when the build fails",
    { "pnpm build": 1 },
    false,
    [...TO_RELEASE, ...BUILD],
    "early-release-recovery-build-failed",
  ],
  [
    "returns to the release when the rebuilt checkout does not start",
    { "checkout gateway start": 1 },
    false,
    [...TO_RELEASE, ...BUILD, ...TO_CHECKOUT, ...TO_RELEASE],
    "early-release-recovery-switch-failed",
  ],
])(
  "%s",
  async (_name, fail: Record<string, number>, servesRelease, expected: string[], failure) => {
    const fx = runner(fail, servesRelease);
    const removed = await runEarlyGitReleaseRecovery(fx.plan, fx.deps);

    expect(fx.calls.filter((call) => /gateway|pnpm|systemctl/u.test(call))).toEqual(expected);
    expect(fx.calls.includes(MERGE)).toBe(!servesRelease);
    expect(fx.records.map((record) => record.reason)).toEqual(failure ? [failure] : []);
    expect(removed).toBe(false);
    // The kept release stays only while the Gateway may still serve from it.
    expect(fs.existsSync(fx.release)).toBe(expected.includes("pnpm install"));
    if (fail["release gateway install"]) {
      expect(fs.readFileSync(fx.serviceFile, "utf8")).toBe(fx.original);
    }
    if (failure === "early-release-recovery-build-failed") {
      expect(fx.records[0]?.nextAction).toContain(
        "pnpm install --frozen-lockfile && pnpm build && openclaw gateway install --force",
      );
    }
  },
);

it("removes what the early layout left and records the outcome", async () => {
  const fx = runner({});
  const releases = path.join(fx.plan.prefix, "releases");
  fs.mkdirSync(path.join(releases, "git-old", "lib", "node_modules", "openclaw"), {
    recursive: true,
  });
  fs.mkdirSync(path.join(releases, "current-layout", "openclaw"), { recursive: true });
  fs.writeFileSync(path.join(releases, ".trial"), JSON.stringify({ target: "x", attempts: 1 }));
  fs.mkdirSync(path.join(fx.plan.prefix, "lib", "node_modules"), { recursive: true });
  const link = path.join(fx.plan.prefix, "lib", "node_modules", "openclaw");
  fs.symlinkSync(path.join(releases, "git-old"), link);
  await finishEarlyGitReleaseRecovery(fx.plan, { downtimeMs: 21_000 }, fx.deps);

  expect(fs.readdirSync(fx.plan.prefix)).toEqual(["releases"]);
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
