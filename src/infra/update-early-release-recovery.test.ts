import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import * as recovery from "./update-early-release-recovery.js";
import type { RunCommand, RunnerDeps, StartDeps } from "./update-early-release-recovery.js";

type RecoveryOutcome = Parameters<RunnerDeps["record"]>[0];

const roots: string[] = [];
afterEach(() => cleanupTempDirs(roots));
// The runner exists only for Linux systemd services; its fixtures use POSIX shells and links.
const posix = it.runIf(process.platform !== "win32");

function sh(cwd: string, script: string) {
  const result = spawnSync("bash", ["-ec", script], { cwd, encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

/**
 * A checkout on `main` one commit behind its upstream, and the target that the early updater
 * built as the release worktree `state/git-install/releases/r1/build` beside its legacy link.
 * Git runs for real; systemd, pnpm and the Gateway service are scripted.
 */
function install() {
  const base = makeTempDir(roots, "openclaw-early-recovery-");
  const [before, target] = sh(
    base,
    `git init -q --bare -b main up.git && git clone -q up.git co 2>/dev/null && cd co
    git config user.email t@example.invalid && git config user.name T && echo dist/ > .gitignore
    git add . && git commit -qm a && git commit -q --allow-empty -m b && git push -q -u origin main
    git rev-parse HEAD~1 HEAD && git reset -q --hard HEAD~1 && mkdir dist ../bin && touch dist/index.js
    git worktree add -q --detach ../state/git-install/releases/r1/build origin/main
    mkdir -p ../state/git-install/lib/node_modules && ln -s "$PWD" ../state/git-install/lib/node_modules/openclaw`,
  ).split("\n") as [string, string];
  const [checkout, stateDir, cli] = ["co", "state", "bin/openclaw"].map((p) => path.join(base, p));
  fs.writeFileSync(path.join(checkout!, "dist", "build-info.json"), `{"commit":"${before}"}`);
  fs.writeFileSync(cli!, `#!/bin/sh\necho "OpenClaw 1 (${before.slice(0, 7)})"\n`, { mode: 0o755 });
  const home = path.join(base, "home");
  const systemd: string[][] = [];
  const deps: StartDeps & { active: string; systemdRun: number; pnpm: number } = {
    platform: "linux",
    env: { HOME: home, PATH: path.dirname(cli!), OPENCLAW_STATE_DIR: stateDir },
    active: "inactive",
    systemdRun: 0,
    pnpm: 0,
    run: async (argv, options) => {
      if (argv[0] === "git" || argv[0] === cli) {
        const result = spawnSync(argv[0]!, argv.slice(1), { cwd: options?.cwd, encoding: "utf8" });
        return { code: result.status, output: `${result.stdout}${result.stderr}` };
      }
      systemd.push(argv);
      const code = { "systemd-run": deps.systemdRun, pnpm: deps.pnpm }[argv[0]!] ?? 0;
      return { code, output: argv.includes("is-active") ? deps.active : "" };
    },
    freeBytes: () => 64 * 1024 ** 3,
    findDriver: () => ({ pid: 4242, start: "77" }),
    readService: async () => ({
      sourcePath: path.join(home, ".config", "systemd", "user", "openclaw-gateway.service"),
      entry: path.join(checkout!, "dist", "index.js"),
      environment: { OPENCLAW_STATE_DIR: stateDir! },
    }),
  };
  const prefix = fs.realpathSync(path.join(stateDir!, "git-install"));
  const root = path.join(prefix, "releases", "r1", "build");
  const change = { root, stateDir: stateDir!, prefix, pending: { state: 40, agent: 42 } };
  return { checkout: checkout!, target, root, prefix, change, deps, systemd, cli: cli! };
}

posix("keeps the built release and starts the runner as a transient user service", async () => {
  const fx = install();
  const result = await recovery.startEarlyGitReleaseRecovery(fx.change, fx.deps);

  expect(result).toEqual({ started: true, unit: "openclaw-update-recovery", target: fx.target });
  const release = path.join(fx.prefix, "recovery", "openclaw");
  expect(fs.existsSync(fx.root)).toBe(false);
  expect(sh(release, "git rev-parse HEAD")).toBe(fx.target);
  const argv = fx.systemd.find(([command]) => command === "systemd-run")!;
  expect(argv).toEqual(
    expect.arrayContaining(["--unit=openclaw-update-recovery", "--property=Restart=on-abnormal"]),
  );
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
  ["not on a branch", (fx) => sh(fx.checkout, "git checkout -q --detach")],
  ["cannot fast-forward", (fx) => sh(fx.checkout, "git commit -q --allow-empty -m c")],
  ["has no upstream", (fx) => sh(fx.checkout, "git branch -q --unset-upstream")],
  [
    "local commits that are not upstream",
    (fx) =>
      sh(fx.checkout, `git push -q -f origin HEAD:main && git merge -q --ff-only ${fx.target}`),
  ],
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
  ["pnpm is not on PATH", (fx) => (fx.deps.pnpm = 1)],
  ["updater process could not be identified", (fx) => (fx.deps.findDriver = () => undefined)],
  [
    "service runs another installation",
    (fx) => {
      const read = fx.deps.readService;
      fx.deps.readService = async (env) => ({ ...(await read(env)), entry: "/opt/openclaw/x.js" });
    },
  ],
];

posix.each(refusals)("changes nothing and says why: %s", async (reason, arrange) => {
  const fx = install();
  arrange(fx);
  const result = await recovery.startEarlyGitReleaseRecovery(fx.change, fx.deps);

  expect(result).toMatchObject({ started: false, reason: expect.stringContaining(reason) });
  expect(sh(fx.root, "git rev-parse HEAD")).toBe(fx.target);
  expect(fs.existsSync(path.join(fx.prefix, "recovery"))).toBe(false);
});

posix("starts nothing while another recovery runs", async () => {
  const fx = install();
  fx.deps.active = "active";

  const result = await recovery.startEarlyGitReleaseRecovery(fx.change, fx.deps);
  expect(result).toEqual({ started: false, running: "openclaw-update-recovery" });
  expect(fs.existsSync(fx.root)).toBe(true);
  expect(fx.systemd.map(([command]) => command)).not.toContain("systemd-run");
});

/** The runner's world: a service definition, the kept release, and scripted command outcomes. */
function runner(fail: Record<string, number>, resumed = false, restarts = 0) {
  const base = makeTempDir(roots, "openclaw-early-runner-");
  const prefix = path.join(base, "git-install");
  const release = path.join(prefix, "recovery", "openclaw");
  const serviceFile = path.join(base, "openclaw-gateway.service");
  const original = `ExecStart=node ${resumed ? release : "/co"}/dist/index.js --port 1\n`;
  fs.mkdirSync(release, { recursive: true });
  fs.writeFileSync(serviceFile, original);
  const target = "b".repeat(40);
  const calls: string[] = [];
  const records: RecoveryOutcome[] = [];
  let alive = 2;
  const run: RunCommand = async (argv) => {
    const cli = argv[1]?.endsWith("openclaw.mjs") ? path.dirname(argv[1]) : "";
    const role = cli === release ? "release" : cli ? "checkout" : "";
    const name = [role, ...argv.filter((arg) => !/^[/-]/u.test(arg))].join(" ").trim();
    calls.push(name);
    if (name.endsWith("gateway install") && !fail[name]) {
      fs.writeFileSync(serviceFile, `ExecStart=node ${cli}/dist/index.js --port 1\n`);
    }
    // A resumed runner already fast-forwarded the checkout.
    const head = resumed ? target : "a".repeat(40);
    const output = { "git rev-parse HEAD": head, "git symbolic-ref HEAD": "main" }[name];
    return { code: fail[name] ?? 0, output: output ?? "" };
  };
  const deps = {
    run,
    log: () => {},
    driverAlive: () => {
      calls.push("driver alive");
      return alive-- > 0;
    },
    restarts: async () => restarts,
    migrated: () => true,
    ready: async (port: number | null) => {
      const role = fs.readFileSync(serviceFile, "utf8").includes(release) ? "release" : "checkout";
      calls.push(`${role} ready ${port}`);
      return !fail[`${role} ready`];
    },
    record: async (outcome: RecoveryOutcome) => void records.push(outcome),
    finish: async (_plan: unknown, facts: { downtimeMs: number }) => {
      calls.push(`finish ${facts.downtimeMs > 0}`);
      fs.rmSync(path.dirname(release), { recursive: true });
      return { code: 0, output: "" };
    },
    now: () => calls.length * 1000,
    sleep: async () => {},
  };
  const plan = { unit: "u", checkout: path.join(base, "co"), branch: "main", target, release };
  const full = { ...plan, prefix, serviceFile, fromVersion: "1", driver: { pid: 1, start: "1" } };
  return { plan: full, calls, records, deps, serviceFile, release, original };
}

const TO_RELEASE = ["release gateway install", "release ready 1"];
const BUILD = ["pnpm install", "pnpm build"];
const TO_CHECKOUT = ["checkout gateway install", "checkout ready 1"];
const MERGE = `git merge ${"b".repeat(40)}`;

const DONE = [...TO_CHECKOUT, "finish true"];
it.each([
  ["serves the release while the checkout builds", {}, [...TO_RELEASE, ...BUILD, ...DONE]],
  ["resumes at the build once the release serves", {}, [...BUILD, ...DONE], true],
  ["changes nothing when the fast-forward fails", { [MERGE]: 1 }, []],
  [
    "changes nothing when the service cannot be moved to the release",
    { "release gateway install": 1 },
    ["release gateway install"],
  ],
  [
    "never puts the previous build back once the release started",
    { "release ready": 1 },
    TO_RELEASE,
  ],
  [
    "keeps the release serving when the build fails",
    { "pnpm build": 1 },
    [...TO_RELEASE, ...BUILD],
  ],
  [
    "returns to the release when the rebuilt checkout does not start",
    { "checkout ready": 1 },
    [...TO_RELEASE, ...BUILD, ...TO_CHECKOUT, ...TO_RELEASE],
  ],
  ["stops restarting after repeated interruptions, keeping the release", {}, [], true, 3],
] as Array<[string, Record<string, number>, string[], boolean?, number?]>)(
  "%s",
  async (_name, fail, expected, resumed = false, restarts = 0) => {
    const fx = runner(fail, resumed, restarts);
    const done = expected.includes("finish true");
    expect(await recovery.runEarlyGitReleaseRecovery(fx.plan, fx.deps)).toBe(done);

    expect(fx.calls.filter((call) => /gateway|pnpm|ready|finish/u.test(call))).toEqual(expected);
    // Nothing moves before the updater that started the runner has exited.
    const merged = fx.calls.indexOf(MERGE);
    expect(merged === -1 ? resumed : merged > fx.calls.lastIndexOf("driver alive")).toBe(true);
    // Once the service starts the release a failure is recorded with its next step; before
    // that nothing changed and the next update retries.
    const failed =
      restarts > 0 || ["release ready", "pnpm build", "checkout ready"].some((name) => fail[name]);
    expect(fx.records.map((record) => record.nextAction?.includes("install --force"))).toEqual(
      failed ? [true] : [],
    );
    // The kept release stays while the Gateway may serve from it, until the finishing step.
    expect(fs.existsSync(fx.release)).toBe(
      !done && !fail[MERGE] && !fail["release gateway install"],
    );
  },
);

posix("removes what the early layout left and records the outcome", async () => {
  const fx = runner({});
  sh(
    fx.plan.prefix,
    `mkdir -p releases/git-old/lib/node_modules/openclaw releases/now/openclaw lib/node_modules
    ln -s ../../releases/git-old lib/node_modules/openclaw && echo '{"attempts":1}' > releases/.trial`,
  );
  await recovery.finishEarlyGitReleaseRecovery(fx.plan, { downtimeMs: 21_000 }, fx.deps);

  expect(fs.readdirSync(fx.plan.prefix)).toEqual(["releases"]);
  expect(fs.readdirSync(path.join(fx.plan.prefix, "releases"))).toEqual(["now"]);
  expect(fx.calls).toContain("git worktree prune");
  const removed = "Removed the old-format trial, the old release link, releases/git-old, recovery.";
  expect(fx.records).toEqual([
    expect.objectContaining({ downtimeMs: 21_000, detail: expect.stringContaining(removed) }),
  ]);
});
