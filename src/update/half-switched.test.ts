import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getUpdateRunAsync } from "../infra/update-run-reader.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import {
  checkoutConversion,
  convertHalfSwitchedCheckout,
  resumeHalfSwitchedCheckout,
} from "./half-switched.js";
import { prepareUpdate, type UpdateRunLedger } from "./run.js";

// The fixture host's container facts must not decide preflight.
vi.mock("../infra/container-environment.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/container-environment.js")>()),
  isContainerEnvironment: () => false,
}));

// The service manager: what the definition starts, and a restart that plays the launcher's part.
const service = vi.hoisted(() => ({
  entry: "",
  environment: {} as Record<string, string>,
  restart: async () => {},
  restarts: 0,
}));
vi.mock("../daemon/service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon/service.js")>()),
  resolveGatewayService: () => ({
    readCommand: async () => ({
      programArguments: [process.execPath, service.entry, "gateway"],
      environment: service.environment,
    }),
    restart: async () => {
      service.restarts++;
      await service.restart();
      return { outcome: "completed" };
    },
  }),
}));
const staging = vi.hoisted(() => ({ repoint: true }));
// mock-isolation: the definition owner writes a real unit; here it either repoints or cannot.
vi.mock("./convert-service.js", () => ({
  stageReleaseService: async (params: { launcher: string }) => {
    if (staging.repoint) {
      service.entry = params.launcher;
    }
  },
}));

const exec = promisify(execFile);
let root: string;
let stateDir: string;

beforeEach(async () => {
  // Preflight on main also reads the Docker marker and container variables itself.
  const access = fs.access.bind(fs);
  vi.spyOn(fs, "access").mockImplementation(async (file, mode) => {
    if (file === "/.dockerenv") {
      throw Object.assign(new Error("No container marker in this fixture"), { code: "ENOENT" });
    }
    return access(file, mode);
  });
  for (const key of ["container", "DOCKER_CONTAINER", "OPENCLAW_CONTAINER"]) {
    vi.stubEnv(key, "");
  }
  root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-half-switched-"));
  stateDir = path.join(root, "state");
  const bin = path.join(root, "bin");
  await fs.mkdir(bin);
  await fs.symlink(process.execPath, path.join(bin, "node"));
  // pnpm stand-in: `install` succeeds, a script runs the fixture's own command.
  await fs.writeFile(
    path.join(bin, "pnpm"),
    `#!${process.execPath}\nconst args = process.argv.slice(2);\nif (args[0] === '--version') { console.log('10.0.0'); process.exit(0); }\nif (args[0] === 'install') process.exit(0);\nconst pkg = JSON.parse(require('node:fs').readFileSync('package.json'));\nprocess.exit(require('node:child_process').spawnSync(pkg.scripts[args[0]], { shell: true, stdio: 'inherit' }).status ?? 1);\n`,
    { mode: 0o755 },
  );
  vi.stubEnv("PATH", `${bin}${path.delimiter}${process.env.PATH}`);
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.stubEnv("IN_NIX_SHELL", "");
});
afterEach(async () => {
  service.restarts = 0;
  service.environment = {};
  service.restart = async () => {};
  staging.repoint = true;
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

async function writeTrial(record: object) {
  const releases = path.join(stateDir, "git-install", "releases");
  await fs.mkdir(releases, { recursive: true });
  await fs.writeFile(path.join(releases, ".trial"), JSON.stringify(record));
}

/** A checkout whose release answers its own `update check-release` and `update plugins`. */
async function checkout() {
  const source = path.join(root, "source");
  const dir = path.join(root, "checkout");
  await fs.mkdir(source);
  const git = (...args: string[]) => exec("git", ["-C", source, ...args]);
  await git("init", "-b", "main");
  await git("config", "user.email", "half-switched@example.invalid");
  await git("config", "user.name", "Half Switched Fixture");
  await fs.writeFile(
    path.join(source, "package.json"),
    JSON.stringify({
      name: "openclaw",
      version: "2026.11.21",
      engines: { node: ">=1" },
      scripts: { build: "node build.cjs", "ui:build": "node -e 0" },
    }),
  );
  await fs.writeFile(path.join(source, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  await fs.writeFile(
    path.join(source, "build.cjs"),
    "const fs=require('node:fs'); fs.mkdirSync('dist'); fs.writeFileSync('dist/build-info.json', JSON.stringify({buildId:'fixture-build'}));",
  );
  await fs.writeFile(
    path.join(source, "openclaw.mjs"),
    [
      "const [command, sub] = process.argv.slice(2);",
      "if (command === 'update' && sub === 'check-release') console.log(JSON.stringify({ ok: true, surfaces: [] }));",
      "if (command === 'update' && sub === 'plugins') console.log(JSON.stringify({ status: 'ok', changed: false, warnings: [], sync: { changed: false, switchedToBundled: [], switchedToNpm: [], warnings: [], errors: [] }, npm: { changed: false, outcomes: [] }, integrityDrifts: [] }));",
    ].join("\n"),
  );
  await git("add", ".");
  await git("commit", "-m", "fixture");
  await exec("git", ["clone", "--bare", source, path.join(root, "remote.git")]);
  await exec("git", ["clone", path.join(root, "remote.git"), dir]);
  const sha = (await exec("git", ["-C", dir, "rev-parse", "HEAD"])).stdout.trim();
  return { dir, sha };
}

function collectingLedger() {
  const writes: string[] = [];
  const ledger: UpdateRunLedger = {
    phase: async (_runId, phase) => writes.push(`phase:${phase}`),
    step: async (_runId, step) => writes.push(`step:${step.step}:${step.status}`),
    finish: async (_runId, result) => writes.push(`finish:${result.status}`),
  };
  return { writes, ledger };
}

const LEGACY_TRIAL = { target: "../../releases/x/lib/node_modules/openclaw", previous: "y" };

it("converts only where the serving build predates the release path", async () => {
  const launcher = path.join(stateDir, "git-install", "openclaw-launcher.mjs");
  service.entry = path.join(root, "checkout", "dist", "index.js");
  expect(await checkoutConversion()).toBeNull();
  await writeTrial({ v: 2, runId: "run", phase: "committed", target: "a", previous: "b" });
  expect(await checkoutConversion()).toBeNull();
  // The format-1 record #199706's updater writes: no `v`, no `phase`.
  await writeTrial(LEGACY_TRIAL);
  expect(await checkoutConversion()).toBe("convert");
  // A deferred format-1 trial on an install whose service already starts the launcher.
  service.entry = launcher;
  expect(await checkoutConversion()).toBeNull();
  // A rollback onto a checkout build without the forwarder serves the old handler again.
  const old = path.join(root, "old-checkout");
  await fs.mkdir(old);
  await fs.symlink(old, path.join(stateDir, "git-install", "openclaw"));
  await writeTrial({ v: 2, runId: "run", phase: "rolled-back", target: "a", previous: old });
  expect(await checkoutConversion()).toBe("convert");
  // A conversion that pointed the service at the launcher but never restarted into it.
  await writeTrial({ v: 2, runId: "run", phase: "pending", target: "a", previous: old });
  expect(await checkoutConversion()).toBe("resume");
  await fs.writeFile(path.join(old, "release-launcher-forward.mjs"), "");
  expect(await checkoutConversion()).toBeNull();
});

it("points the service at the launcher, restarts, and records the run once the release serves", async () => {
  const { dir } = await checkout();
  await writeTrial(LEGACY_TRIAL);
  service.entry = path.join(dir, "dist", "index.js");
  const prefix = path.join(stateDir, "git-install");
  // The launcher's part: it switches to the pending release, which becomes ready.
  service.restart = async () => {
    const file = path.join(prefix, "releases", ".trial");
    const trial = JSON.parse(await fs.readFile(file, "utf8"));
    await fs.writeFile(file, JSON.stringify({ ...trial, phase: "committed" }));
    // From here on the new release owns state, so this process may write it.
    openOpenClawStateDatabase({ env: process.env });
  };
  const runId = await convertHalfSwitchedCheckout({ runningRoot: dir, channel: "dev" });
  expect(service.restarts).toBe(1);
  expect(service.entry).toBe(path.join(prefix, "openclaw-launcher.mjs"));
  const run = await getUpdateRunAsync(runId);
  expect(run).toMatchObject({ status: "running", phase: "activating", trigger: "cli" });
  expect(run?.steps.find(({ step }) => step === "plugins")?.detail).toContain(
    "maintained by the next update",
  );
  expect(run?.steps.find(({ step }) => step === "warning:checkout-cli")?.detail).toContain(
    "openclaw/openclaw.mjs",
  );
});

it("restarts nothing and keeps the earlier updater's trial when the service cannot be repointed", async () => {
  const { dir } = await checkout();
  await writeTrial(LEGACY_TRIAL);
  service.entry = path.join(dir, "dist", "index.js");
  staging.repoint = false;
  await expect(convertHalfSwitchedCheckout({ runningRoot: dir, channel: "dev" })).rejects.toThrow(
    /not the release launcher[\s\S]*The current version is still running\./u,
  );
  expect(service.restarts).toBe(0);
  const trial = path.join(stateDir, "git-install", "releases", ".trial");
  expect(JSON.parse(await fs.readFile(trial, "utf8"))).toEqual(LEGACY_TRIAL);
  // So the next update converts again instead of asking the old Gateway.
  expect(await checkoutConversion()).toBe("convert");
  await expect(fs.access(path.join(stateDir, "state"))).rejects.toMatchObject({ code: "ENOENT" });
});

it("keeps the published trial for the launcher once the restart was attempted", async () => {
  const { dir } = await checkout();
  await writeTrial(LEGACY_TRIAL);
  service.entry = path.join(dir, "dist", "index.js");
  service.restart = async () => {
    throw new Error("systemctl timed out");
  };
  await expect(convertHalfSwitchedCheckout({ runningRoot: dir, channel: "dev" })).rejects.toThrow(
    /restart did not complete[\s\S]*rolls back on its own/u,
  );
  // The launcher may already be booting the release and needs this trial to roll it back.
  const file = path.join(stateDir, "git-install", "releases", ".trial");
  const published = JSON.parse(await fs.readFile(file, "utf8"));
  expect(published).toMatchObject({ v: 2, phase: "pending" });
  // Nothing started: the next update restarts into the prepared release and records its run.
  expect(await checkoutConversion()).toBe("resume");
  service.restart = async () => {
    await fs.writeFile(file, JSON.stringify({ ...published, phase: "committed" }));
    openOpenClawStateDatabase({ env: process.env });
  };
  const runId = await resumeHalfSwitchedCheckout({ runningRoot: dir });
  expect(runId).toBe(published.runId);
  expect(await getUpdateRunAsync(runId)).toMatchObject({ status: "running", trigger: "cli" });
});

it("changes nothing when the service runs with another state directory", async () => {
  const { dir } = await checkout();
  await writeTrial(LEGACY_TRIAL);
  service.entry = path.join(dir, "dist", "index.js");
  service.environment = { OPENCLAW_STATE_DIR: path.join(root, "other-state") };
  await expect(convertHalfSwitchedCheckout({ runningRoot: dir, channel: "dev" })).rejects.toThrow(
    /uses the state directory .*other-state[\s\S]*Nothing changed\./u,
  );
  expect(service.restarts).toBe(0);
  await expect(fs.access(path.join(stateDir, "git-install", "openclaw"))).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("prepares the release beside a serving checkout without touching the state database", async () => {
  const { dir } = await checkout();
  await writeTrial(LEGACY_TRIAL);
  const { writes, ledger } = collectingLedger();
  const outcome = await prepareUpdate({
    runId: "run-convert",
    runningRoot: dir,
    runningVersion: "2026.11.4",
    channel: "dev",
    servingCommit: "8".repeat(40),
    timeoutMs: 60_000,
    ledger,
  });
  expect(outcome).toMatchObject({ status: "pending", target: { version: "2026.11.21" } });
  expect(writes.filter((write) => write.startsWith("phase:"))).toEqual([
    "phase:staging",
    "phase:validating",
    "phase:activating",
  ]);
  expect(writes).toContain("step:plugins:completed");
  // Nothing opened or created the state database the other build owns.
  await expect(fs.access(path.join(stateDir, "state"))).rejects.toMatchObject({ code: "ENOENT" });
  const prefix = path.join(stateDir, "git-install");
  const trial = JSON.parse(await fs.readFile(path.join(prefix, "releases", ".trial"), "utf8"));
  // The checkout's build is what serves, so it is the trial's fallback.
  expect(trial).toMatchObject({ v: 2, phase: "pending", runId: "run-convert" });
  expect(path.resolve(prefix, trial.previous)).toBe(await fs.realpath(dir));
  expect(await fs.readFile(path.join(dir, ".git", "openclaw-launcher"), "utf8")).toBe(
    `${path.join(prefix, "openclaw-launcher.mjs")}\n`,
  );
});

it("treats the checkout's serving build, not this process's, as the current commit", async () => {
  const { dir, sha } = await checkout();
  const { writes, ledger } = collectingLedger();
  const outcome = await prepareUpdate({
    runId: "run-current",
    runningRoot: dir,
    runningVersion: "2026.11.21",
    channel: "dev",
    servingCommit: sha,
    timeoutMs: 60_000,
    ledger,
  });
  expect(outcome).toMatchObject({ status: "current" });
  expect(writes.at(-1)).toBe("finish:skipped");
});
