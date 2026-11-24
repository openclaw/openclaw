import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { readUpdateLock } from "../update/store.js";
import { waitForGatewayReady } from "./update-early-release-recovery-ready.js";
import { startEarlyGitReleaseRecovery } from "./update-early-release-recovery-start.js";
import type { StartDeps } from "./update-early-release-recovery-start.js";
import * as recovery from "./update-early-release-recovery.js";
import type { FinishFacts, RunCommand, RunnerDeps } from "./update-early-release-recovery.js";
import { getUpdateRunStatusAsync } from "./update-run-reader.js";
import { createUpdateRunAsync, finishUpdateRunAsync } from "./update-run-write.async.js";

type RecoveryOutcome = Parameters<RunnerDeps["record"]>[0];
const roots: string[] = [];
afterEach(async () => {
  await closeOpenClawStateDatabaseAsync();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  cleanupTempDirs(roots);
});
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
 * Git runs for real, under a path with `$` in it; systemd, pnpm and the service are scripted.
 */
function install() {
  const base = makeTempDir(roots, "openclaw-early-$recovery-");
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
  // A pnpm command shim names its target on its last line.
  const shim = (sha: string, to?: string) =>
    `#!/bin/sh\necho "OpenClaw 1 (${sha.slice(0, 7)})"\n${to ? `# cmd-shim-target=../${to}/openclaw.mjs` : ""}`;
  fs.writeFileSync(cli!, shim(before, "co"), { mode: 0o755 });
  const unitFile = path.join(base, "home/.config/systemd/user/openclaw-gateway.service");
  const environment = { OPENCLAW_STATE_DIR: stateDir! };
  const service = { sourcePath: unitFile, entry: `${checkout}/dist/index.js`, environment };
  const state = { active: "inactive", gateway: "active", "systemd-run": 0, pnpm: 0 };
  const systemd: string[][] = [];
  const deps: StartDeps = {
    platform: "linux",
    env: { HOME: path.join(base, "home"), PATH: path.dirname(cli!), OPENCLAW_STATE_DIR: stateDir },
    run: async (argv, options) => {
      if (argv[0] === "git" || argv[0] === cli) {
        const result = spawnSync(argv[0]!, argv.slice(1), { cwd: options?.cwd, encoding: "utf8" });
        return { code: result.status, output: `${result.stdout}${result.stderr}` };
      }
      systemd.push(argv);
      const recoveryUnit = argv.includes("openclaw-update-recovery");
      const shown = { "is-active": recoveryUnit ? state.active : state.gateway }[argv[2]!];
      const code = argv[0] === "systemd-run" || argv[0] === "pnpm" ? state[argv[0]] : 0;
      return { code, output: shown ?? (argv[2] === "is-enabled" ? "disabled" : "") };
    },
    freeBytes: () => 64 * 1024 ** 3,
    findDriver: () => ({ pid: 4242, start: "77" }),
    readSchema: () => ({ state: 40, agents: { "/a.sqlite": 42 } }),
    readService: async () => ({ ...service }),
  };
  const prefix = fs.realpathSync(path.join(stateDir!, "git-install"));
  const root = path.join(prefix, "releases", "r1", "build");
  const change = { root, stateDir: stateDir!, prefix, pending: { state: 40, agent: 42 } };
  const fx = { base, checkout: checkout!, target, root, prefix, change, deps, systemd, cli: cli! };
  return { ...fx, before, shim, state, service };
}

posix("keeps the built release and starts the runner as a transient user service", async () => {
  const fx = install();
  const result = await startEarlyGitReleaseRecovery(fx.change, fx.deps);

  expect(result).toEqual({ started: true, unit: "openclaw-update-recovery", target: fx.target });
  const release = path.join(fx.prefix, "recovery", "openclaw");
  expect(fs.existsSync(fx.root)).toBe(false);
  expect(sh(release, "git rev-parse HEAD")).toBe(fx.target);
  const argv = fx.systemd.find(([command]) => command === "systemd-run")!;
  const stateDir = `--setenv=OPENCLAW_STATE_DIR=${fx.change.stateDir}`;
  expect(argv).toEqual(expect.arrayContaining(["--property=Restart=on-abnormal", stateDir]));
  // systemd turns `$$` back into `$` when it expands the command line.
  const [worker, flag, json] = argv.slice(-3).map((arg) => arg.replaceAll("$$", "$"));
  expect(worker).toBe(path.join(release, "dist", "infra", "update-migrated-finalize.worker.js"));
  const plan = { ...JSON.parse(json!), flag };
  const schema = { state: 40, agents: { "/a.sqlite": 42 } };
  expect(plan).toMatchObject({ checkout: fs.realpathSync(fx.checkout), target: fx.target, schema });
  expect(plan).toMatchObject({ flag: "--early-release-recovery", enabled: "disabled" });
});

type Fx = ReturnType<typeof install>;
const writeCli = (fx: Fx, text: string) => fs.writeFileSync(fx.cli, text);
const launcher = (fx: Fx) => (fx.service.entry = path.join(fx.prefix, "openclaw-launcher.mjs"));
const other = "runs another installation";
const git = (fx: Fx, script: string) => sh(fx.checkout, script);
const NESTED = "git worktree add -q w && mkdir w/d && echo w/d/x";
const refusals: Array<[string, (fx: Fx) => unknown]> = [
  ["Linux systemd user service", (fx) => (fx.deps.platform = "darwin")],
  ["uncommitted changes", (fx) => fs.writeFileSync(path.join(fx.checkout, ".gitignore"), "x")],
  ["not on a branch", (fx) => git(fx, "git checkout -q --detach")],
  ["cannot fast-forward", (fx) => git(fx, "git commit -q --allow-empty -m c")],
  ["has no upstream", (fx) => git(fx, "git branch -q --unset-upstream")],
  ["local commits", (fx) => git(fx, `git push -qf origin @:main && git merge -q ${fx.target}`)],
  ["does not contain", (fx) => git(fx, "git push -q origin @:x && git branch -qu origin/x")],
  ["4 GiB", (fx) => (fx.deps.freeBytes = () => 1)],
  ["not a managed systemd user service", (fx) => (fx.deps.readService = async () => null)],
  ["another state directory", (fx) => (fx.service.environment = { OPENCLAW_STATE_DIR: "/x" })],
  ["PATH could not be traced", (fx) => writeCli(fx, fx.shim(fx.before))],
  ["PATH runs another build", (fx) => writeCli(fx, fx.shim("fedcba9", "co"))],
  ["systemd-run failed", (fx) => (fx.state["systemd-run"] = 1)],
  ["pnpm is not on PATH", (fx) => (fx.state.pnpm = 1)],
  ["updater process could not be identified", (fx) => (fx.deps.findDriver = () => undefined)],
  // A worktree nested in the checkout, and a linked one the command on PATH runs.
  [`service ${other}`, (fx) => (fx.service.entry = `${fx.checkout}/${git(fx, NESTED)}`)],
  [
    `PATH ${other}`,
    (fx) => [
      git(fx, "git worktree add -q ../w"),
      launcher(fx),
      writeCli(fx, fx.shim(fx.before, "w")),
    ],
  ],
  ["could not be identified", (fx) => [launcher(fx), (fx.deps.env.PATH = fx.base)]],
  ["Gateway service is not running", (fx) => (fx.state.gateway = "inactive")],
  ["schema versions could not be read", (fx) => (fx.deps.readSchema = () => null)],
];

posix.each(refusals)("changes nothing and says why: %s", async (reason, arrange) => {
  const fx = install();
  arrange(fx);
  const result = await startEarlyGitReleaseRecovery(fx.change, fx.deps);

  expect(result).toMatchObject({ started: false, reason: expect.stringContaining(reason) });
  expect(sh(fx.root, "git rev-parse HEAD")).toBe(fx.target);
  expect(fs.existsSync(path.join(fx.prefix, "recovery"))).toBe(false);
});

posix("starts nothing while another recovery runs or another check is starting one", async () => {
  const fx = install();
  git(fx, "git worktree add -q --detach ../state/git-install/releases/r2/build origin/main");
  const second = { ...fx.change, root: path.join(fx.prefix, "releases", "r2", "build") };
  const [run, reached, gate] = [fx.deps.run, createDeferred(), createDeferred()];
  let blocked = false;
  fx.deps.run = async (argv, options) => {
    if (argv[0] === "systemd-run" && !blocked) {
      blocked = true;
      reached.resolve();
      await gate.promise;
    }
    return run(argv, options);
  };
  // A dead check's lock is taken over. An unset state directory stays out of the service.
  publish(fx, "99999999 1");
  delete fx.deps.env.OPENCLAW_STATE_DIR;
  const first = startEarlyGitReleaseRecovery(fx.change, fx.deps);
  await reached.promise;
  const running = { started: false, running: "openclaw-update-recovery" };
  expect(await startEarlyGitReleaseRecovery(second, fx.deps)).toEqual(running);
  expect(fs.existsSync(second.root)).toBe(true);
  // A lock that is no longer this check's stays with its holder.
  fs.writeFileSync(path.join(fx.prefix, ".recovery-start", "owner"), LIVE);
  gate.resolve();
  expect(await first).toMatchObject({ started: true });
  expect(fs.readFileSync(path.join(fx.prefix, ".recovery-start", "owner"), "utf8")).toBe(LIVE);
  expect(fx.systemd.flat().filter((arg) => arg.includes("OPENCLAW_STATE_DIR"))).toEqual([]);
  expect(sh(path.join(fx.prefix, "recovery", "openclaw"), "git rev-parse HEAD")).toBe(fx.target);
  fx.state.active = "active";
  expect(await startEarlyGitReleaseRecovery(second, fx.deps)).toEqual(running);
});

const LIVE = `${process.ppid} ${recovery.processStart(process.ppid) ?? ""}`;
function publish(fx: Fx, owner: string) {
  const lock = path.join(fx.prefix, ".recovery-start");
  fs.mkdirSync(`${lock}.p`);
  fs.writeFileSync(path.join(`${lock}.p`, "owner"), owner);
  fs.renameSync(`${lock}.p`, lock);
}

posix("moves a dead check's lock once, whichever check sees it first", async () => {
  const fx = install();
  const [lock, rename] = [path.join(fx.prefix, ".recovery-start"), fs.renameSync];
  publish(fx, "99999999 1");
  vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
    // Another check that saw the same dead lock moves it and publishes its own first.
    if (from === lock && fs.readFileSync(path.join(lock, "owner"), "utf8") !== LIVE) {
      rename(lock, `${lock}.stale-99999999-1`);
      publish(fx, LIVE);
    }
    rename(from, to);
    // A third check takes the lock path whenever it is free (a rename-back would lose to it).
    if (from === lock && !fs.existsSync(lock)) {
      publish(fx, "1 third");
    }
  });
  const running = { started: false, running: "openclaw-update-recovery" };
  expect(await startEarlyGitReleaseRecovery(fx.change, fx.deps)).toEqual(running);
  expect(fs.readFileSync(path.join(lock, "owner"), "utf8")).toBe(LIVE);
  const locks = fs.readdirSync(fx.prefix).filter((name) => name.startsWith(".recovery-start"));
  expect(locks.toSorted()).toEqual([".recovery-start", ".recovery-start.stale-99999999-1"]);
});

/** The runner's world: a hand-edited service definition, the kept release, scripted systemd. */
type Opts = {
  fail?: Record<string, number>;
  resumed?: boolean;
  restarts?: number;
  migrates?: boolean;
  past?: boolean;
  /** How long the release takes to stop. */
  stopMs?: number;
};
function runner(opts: Opts) {
  const { fail = {}, resumed = false, restarts = 0 } = opts;
  const base = makeTempDir(roots, "openclaw-early-runner-");
  const [prefix, checkout] = [path.join(base, "git-install"), path.join(base, "co")];
  const release = path.join(prefix, "recovery", "openclaw");
  const serviceFile = path.join(base, "openclaw-gateway.service");
  const unit = (root: string) => `ExecStart=node ${root}/dist/index.js --port 1\n`;
  const original = `${unit(checkout)}Nice=5\n`;
  const commit = `git -c user.name=T -c user.email=t@example.invalid commit -q --allow-empty -m`;
  const target = sh(
    base,
    `git init -q -b main co && cd co && ${commit} a && ${commit} b && git rev-parse @`,
  );
  sh(checkout, resumed ? "true" : opts.past ? `${commit} c` : "git reset -q --hard @~1");
  const planned = { state: 40, agents: { "/a": 1, "/b": 1 } };
  const migrated = { state: 41, agents: { "/a": 2, "/b": 2 } };
  const where = { checkout, release, prefix, serviceFile, unit: "u", branch: "main", target };
  const plan = { ...where, driver: { pid: 1, start: "1" }, enabled: "disabled", schema: planned };
  const full = { ...plan, fromVersion: "1", plannedAt: 1 };
  fs.mkdirSync(release, { recursive: true });
  fs.writeFileSync(serviceFile, resumed ? unit(release) : original);
  if (resumed) {
    fs.writeFileSync(`${serviceFile}.before-update-recovery`, original);
  }
  let schema = opts.migrates && restarts > 2 ? migrated : planned;
  // A resumed runner can find the release still migrating; it holds state until ready.
  let [migrating, alive, running, enabled, failed] = [resumed, 2, true, false, false];
  const [calls, records, finished] = [[] as string[], [] as RecoveryOutcome[], [] as FinishFacts[]];
  const logs: string[] = [];
  const serves = () => {
    const text = fs.readFileSync(serviceFile, "utf8");
    return text === original ? "original" : text.includes(release) ? "release" : "checkout";
  };
  const run: RunCommand = async (argv, options) => {
    const cli = argv[1]?.endsWith("openclaw.mjs") ? path.dirname(argv[1]) : "";
    const role = cli === release ? "release" : cli ? "checkout" : "";
    const words = argv.filter((arg) => !/^([/-]|\d+$|[0-9a-f]{40}$)/u.test(arg));
    const name = [role, ...words].join(" ").trim();
    calls.push(name);
    if (name === "pnpm install" && fail.throw) {
      throw new Error("synthetic");
    }
    if (argv[0] === "git" && !fail[name]) {
      const result = spawnSync(argv[0], argv.slice(1), { encoding: "utf8" });
      return { code: result.status, output: `${result.stdout}${result.stderr}` };
    }
    if (name.endsWith("gateway install") && !fail[name]) {
      fs.writeFileSync(serviceFile, unit(cli));
      [running, enabled] = [true, true];
      // A release that crashes part-way through its boot migration, until its unit fails.
      if (opts.migrates && cli === release) {
        [schema, running, failed] = [migrated, false, true];
      }
    }
    const shown = argv.find((arg) => arg.startsWith("--property="))?.slice(11);
    const state = running ? "active" : failed ? "failed" : "inactive";
    const output = { ActiveState: state, TimeoutStopUSec: "5min 30s" }[shown ?? ""] ?? "";
    const verb = words[2] === "openclaw-gateway.service" ? words[1] : "";
    // Killed at the client's timeout while the release still works; it commits a migration later.
    if (verb === "stop" && (options?.timeoutMs ?? 120_000) < (opts.stopMs ?? 0)) {
      return { code: null, output: "" };
    }
    // The release commits one store's migration and exits while it stops.
    schema = verb === "stop" && opts.stopMs ? { ...planned, agents: { "/a": 1, "/b": 2 } } : schema;
    // A failed unit starts again only after `reset-failed` (systemd refuses a start-limit hit).
    failed = verb === "reset-failed" || verb === "stop" ? false : failed;
    running = verb === "stop" ? false : verb === "start" && !failed ? true : running;
    enabled = verb === "disable" ? false : enabled;
    return { code: fail[name] ?? 0, output };
  };
  const deps: RunnerDeps = {
    run,
    log: (line) => void logs.push(line),
    driverAlive: () => calls.push("driver alive") > 0 && alive-- > 0,
    restarts: async () => restarts,
    schema: () => schema,
    // The migrating Gateway holds the state's maintenance lock.
    hold: async () =>
      migrating ? Promise.reject(new Error("maintenance")) : fail.hold ? null : "run-1",
    ready: async () => {
      const role = serves();
      calls.push(`${role} ready`);
      if (role === "release" && !fail["release ready"]) {
        [migrating, schema] = [false, migrated];
      }
      // The previous build refuses migrated data.
      return !fail[`${role} ready`] && !(role === "original" && schema === migrated);
    },
    record: async (outcome) => void (records.push(outcome), calls.push("record")),
    finish: async (_plan, facts) => {
      finished.push(facts);
      fs.rmSync(path.dirname(release), { recursive: true });
      return { code: 0, output: "" };
    },
    now: () => calls.length * 1000,
    sleep: async () => {},
  };
  const state = () => ({ running, enabled });
  return { plan: full, calls, records, finished, logs, deps, release, original, serves, state };
}

const [MERGE, READY, OLD, SF] = ["git merge", "release ready", "original ready", "start-failed"];
const f = (step: string, more: Opts = {}) => ({ ...more, fail: { [step]: 1, ...more.fail } });
const [migrates, resumed] = [{ migrates: true }, { resumed: true }];
const gaveUp = { resumed: true, restarts: 3, migrates: true };
type Run = [string, Opts, "original" | "release" | "checkout", string?, string?];
const runs: Run[] = [
  ["moves the service to the release, rebuilds, then serves the checkout", {}, "checkout"],
  ["resumes during the boot migration and waits for it", { ...resumed, restarts: 1 }, "checkout"],
  ["changes nothing when the fast-forward fails", f(MERGE), "original"],
  ["never builds past the target", { past: true }, "original", "", "moved past"],
  ["changes nothing when the service cannot move", f("release gateway install"), "original"],
  ["puts the previous build back when unmigrated", f("release ready"), "original"],
  ["never puts it back once migrated", f("release ready", migrates), "release", "start-failed"],
  ["never puts it back when one store moved", f(READY, { stopMs: 3e5 }), "release", SF],
  ["keeps the release if not stopped", f(READY, { stopMs: Infinity }), "release", SF, "confirm"],
  ["keeps it while the old one fails", f(READY, { fail: { [OLD]: 1 } }), "original", "", "stays"],
  ["keeps the release serving when the build fails", f("pnpm build"), "release", "build-failed"],
  ["back to the release when the checkout fails", f("checkout ready"), "release", "switch-failed"],
  ["records that another update holds the lock", f("hold"), "release", "update-running"],
  ["records an unexpected error with its next step", f("throw"), "release", "error"],
  ["stops after repeated interruptions", gaveUp, "release", "interrupted"],
];
it.each(runs)("%s", async (_name, opts, serves, reason, said) => {
  const fx = runner(opts);
  const done = serves === "checkout";
  expect(await recovery.runEarlyGitReleaseRecovery(fx.plan, fx.deps)).toBe(done);
  expect(fx.serves()).toBe(serves);
  // Nothing moves before the updater that started the runner has exited.
  const merged = fx.calls.indexOf(MERGE);
  expect(merged === -1 || merged > fx.calls.lastIndexOf("driver alive")).toBe(true);
  // Recorded only once state migrated, and always with a command that finishes the update.
  const recorded = fx.records.map((r) => [r.reason, r.nextAction?.includes("--force")]);
  expect(recorded).toEqual(reason ? [[`early-release-recovery-${reason}`, true]] : []);
  // The release stays while the service may start it, and until the previous build serves.
  const previousServes = serves === "original" && !opts.fail?.[OLD];
  expect(fs.existsSync(fx.release)).toBe(serves !== "checkout" && !previousServes);
  const copy = `${fx.plan.serviceFile}.before-update-recovery`;
  const kept = fs.existsSync(copy) && fs.readFileSync(copy, "utf8");
  expect(kept).toBe(serves !== "original" && fx.original);
  const timing = opts.resumed ? {} : { downtimeMs: expect.any(Number) };
  expect(fx.finished).toEqual(done ? [{ runId: "run-1", ...timing }] : []);
  // A Gateway runs at the end, and a disabled autostart ends disabled.
  expect(fx.state()).toEqual({ running: true, enabled: false });
  // Recorded before the Gateway starts again on the state the runner opened to record.
  const started = fx.calls.lastIndexOf("systemctl start openclaw-gateway.service");
  expect(fx.calls.lastIndexOf("record")).toBeLessThan(started === -1 ? Infinity : started);
  expect(fx.logs.join("\n")).toContain(said ?? "");
});

it("gives up on a slow crash loop at the unit's restart allowance, not on a long migration", async () => {
  for (const crashEveryMs of [35_000, 0]) {
    let clock = 0;
    const restarts = () => (crashEveryMs ? Math.floor(clock / crashEveryMs) : 0);
    const run: RunCommand = async (argv) => {
      const facts = { StartLimitBurst: "10", NRestarts: String(restarts()), ActiveState: "active" };
      return { code: 0, output: facts[argv[3]?.slice(11) as keyof typeof facts] ?? "" };
    };
    // Each probe takes 5 s; the migration is done after 15 minutes.
    const probe = async () => (clock += 5000) >= 15 * 60_000;
    const deps = { run, now: () => clock, log: () => {} };
    expect(await waitForGatewayReady("u", probe, deps)).toBe(!crashEveryMs);
    expect(restarts()).toBe(crashEveryMs ? 10 : 0);
  }
});

it.each([0, 1])("releases only its own interrupted build lock (restarts %i)", async (restarts) => {
  const fx = runner({ resumed: true, restarts });
  const lock = path.join(fx.plan.checkout, ".artifacts", "dist-artifacts.lock");
  fs.mkdirSync(lock, { recursive: true });
  // A PID above the kernel's maximum is never alive.
  const owner = '{"pid":99999999,"startedAt":"2026-11-24T00:00:00Z"}';
  fs.writeFileSync(path.join(lock, "owner.json"), owner);
  await recovery.runEarlyGitReleaseRecovery(fx.plan, fx.deps);
  expect(fs.existsSync(lock)).toBe(restarts === 0);
});

posix("finishes the run the runner holds and removes what the early layout left", async () => {
  vi.stubEnv("OPENCLAW_STATE_DIR", makeTempDir(roots, "openclaw-early-store-"));
  vi.stubEnv("OPENCLAW_NO_AUTO_UPDATE", "1");
  const fx = runner({});
  const copy = `${fx.plan.serviceFile}.before-update-recovery`;
  fs.writeFileSync(copy, fx.original);
  sh(
    fx.plan.prefix,
    `mkdir -p releases/git-old/lib/node_modules/openclaw releases/now/openclaw lib/node_modules
    mkdir .removing-r-1 releases/.removing-r-2 .recovery-start.stale-1-2 && echo '{"attempts":1}' > releases/.trial
    ln -s ../../releases/git-old lib/node_modules/openclaw`,
  );
  // The real store: the Gateway-started update the early updater failed, then the held run.
  const api = await createUpdateRunAsync({ trigger: "api" });
  await finishUpdateRunAsync(api.runId, { status: "failed", reason: "check-failed" });
  const deps = recovery.defaultRunnerDeps();
  const runId = (await deps.hold({ ...fx.plan, plannedAt: Date.now() })) ?? "";
  const argv = [JSON.stringify(fx.plan), "finish", JSON.stringify({ runId, downtimeMs: 21_000 })];
  const { plan, finish } = recovery.readEarlyGitReleaseRecoveryArgs(argv);
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  await recovery.finishEarlyGitReleaseRecovery(plan, finish!, deps);

  expect(fs.readdirSync(fx.plan.prefix)).toEqual(["releases"]);
  expect(fs.readdirSync(path.join(fx.plan.prefix, "releases"))).toEqual(["now"]);
  const { activeRun, lastRun } = await getUpdateRunStatusAsync();
  expect(activeRun).toBeUndefined();
  expect(lastRun).toMatchObject({ runId, trigger: "api", status: "succeeded", downtimeMs: 21_000 });
  const detail = lastRun?.steps.find((step) => step.step === "early-release-recovery")?.detail;
  expect(detail).toContain("Removed the old-format trial, the old release link, releases/git-old");
  expect(detail).toContain(`kept at ${copy}`);
  expect(await readUpdateLock()).toBeNull();
});
