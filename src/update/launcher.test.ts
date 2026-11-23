import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeGitReleaseLauncher } from "../infra/git-release-launcher.js";
import { writeLauncher, TRIAL_BUDGET_MS } from "./launcher.js";
import type { Trial } from "./store.js";

// The frozen launcher consumes only this on-disk protocol, not the Gateway's module graph.
async function switchLink(target: string, prefix: string) {
  const slot = path.join(prefix, "openclaw");
  await fs.rm(slot, { force: true });
  await fs.symlink(path.resolve(prefix, target), slot, "junction");
}
async function readTrial(prefix: string): Promise<Trial> {
  return JSON.parse(await fs.readFile(path.join(prefix, "releases", ".trial"), "utf8")) as Trial;
}
async function writeTrial(trial: Trial, prefix: string) {
  await fs.writeFile(path.join(prefix, "releases", ".trial"), JSON.stringify(trial));
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup();
  }
});

async function fixture(newSource: string) {
  const state = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-launcher-"));
  cleanups.push(() => fs.rm(state, { recursive: true, force: true }));
  const prefix = path.join(state, "git-install");
  const common = `
    if (process.env.OPENCLAW_RELEASE_LAUNCHER_FORWARDED !== '1') throw new Error('release forwarding loop guard missing');
    process.on('message', message => { if (message.type === 'openclaw.stop') { console.log('STOP'); process.exit(23); } });
    const ready = () => process.send({type:'openclaw.ready',buildId:'new-build'});
    process.on('message', message => { if (message.type === 'openclaw.trial') console.log('READY ' + JSON.stringify(message.trial)); });
  `;
  for (const [id, source] of [
    ["old", "console.log('OLD'); ready();"],
    ["new", newSource],
  ]) {
    const root = path.join(prefix, "releases", id!, "openclaw");
    await fs.mkdir(path.join(root, "dist"), { recursive: true });
    await fs.writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ type: "module", version: "1.0.0" }),
    );
    await fs.writeFile(path.join(root, "dist", "index.js"), common + source);
    await fs.writeFile(
      path.join(root, "dist", "entry.js"),
      "if (process.env.OPENCLAW_RELEASE_LAUNCHER_FORWARDED !== '1') throw new Error('release forwarding loop guard missing'); console.log('ENTRY ' + JSON.stringify(process.argv.slice(2)))",
    );
  }
  await switchLink("releases/old/openclaw", prefix);
  const launcher = await writeLauncher(prefix);
  return { state, prefix, launcher };
}

function start(launcher: string, args = ["gateway", "run"]) {
  const child = spawn(process.execPath, [launcher, ...args], {
    stdio: "pipe",
    env: { ...process.env, NODE_OPTIONS: "" },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exited = once(child, "exit");
  cleanups.push(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await exited;
    }
  });
  return { child, exited, stdout: () => stdout, stderr: () => stderr };
}

async function output(child: ChildProcessWithoutNullStreams, text: string, current: () => string) {
  if (current().includes(text)) {
    return;
  }
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const onData = () => {
    if (current().includes(text)) {
      resolve();
    }
  };
  const onExit = () => reject(new Error(`Launcher exited before ${text}: ${current()}`));
  child.stdout.on("data", onData);
  child.once("exit", onExit);
  try {
    await promise;
  } finally {
    child.stdout.off("data", onData);
    child.off("exit", onExit);
  }
}

async function pending(prefix: string) {
  const trial: Trial = {
    v: 2,
    phase: "pending",
    createdAt: 0,
    attempts: 0,
    runId: "test-run",
    target: "releases/new/openclaw",
    previous: "releases/old/openclaw",
    version: "2.0.0",
    buildId: "new-build",
  };
  await writeTrial(trial, prefix);
  return trial;
}

describe("resident update launcher", () => {
  it("commits a pending trial only after the new child announces ready", async () => {
    const { prefix, launcher } = await fixture("ready();");
    await pending(prefix);
    const run = start(launcher, [
      "--profile",
      "test",
      "gateway",
      "--port",
      "1234",
      "run",
      "--task-supervisor",
      "--task-supervisor-child=65536",
    ]);
    await output(run.child, "READY", run.stdout);
    expect(await readTrial(prefix)).toMatchObject({
      phase: "committed",
      attempts: 1,
      outcome: { status: "succeeded", buildId: "new-build" },
    });
    expect(await fs.realpath(path.join(prefix, "openclaw"))).toBe(
      path.join(prefix, "releases/new/openclaw"),
    );
  });

  it("restores preserved state, additions, and orphan companions before restarting the old release", async () => {
    const { state, prefix, launcher } = await fixture(
      "console.error('candidate exploded'); process.exit(1);",
    );
    const database = path.join(state, "state.sqlite");
    const added = path.join(state, "added.sqlite");
    await fs.writeFile(database, "new state");
    await fs.writeFile(database + ".pre-new-build", "old state");
    await fs.writeFile(database + "-wal", "orphan WAL");
    await fs.writeFile(added, "added");
    await fs.writeFile(
      path.join(state, ".upgraded-new-build.json"),
      JSON.stringify({ ops: [{ kind: "add", live: added }] }),
    );
    await pending(prefix);
    const run = start(launcher);
    await output(run.child, "OLD", run.stdout);
    expect(await fs.readFile(database, "utf8")).toBe("old state");
    await expect(fs.stat(database + "-wal")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(added)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.realpath(path.join(prefix, "openclaw"))).toBe(
      path.join(prefix, "releases/old/openclaw"),
    );
    expect(await readTrial(prefix)).toMatchObject({
      phase: "rolled-back",
      attempts: 2,
      outcome: {
        status: "rolled-back",
        reason: "new build failed to start",
        stderrTail: expect.stringContaining("candidate exploded"),
      },
    });
  });

  it("propagates terminal exit 78 without restarting", async () => {
    const { prefix, launcher } = await fixture("process.exit(78);");
    await switchLink("releases/new/openclaw", prefix);
    const run = start(launcher);
    expect((await run.exited)[0]).toBe(78);
  });

  it("rolls back a trial whose new build refuses the configuration with exit 78", async () => {
    const { prefix, launcher } = await fixture("process.exit(78);");
    await pending(prefix);
    const run = start(launcher);
    await output(run.child, "OLD", run.stdout);
    expect(await readTrial(prefix)).toMatchObject({
      phase: "rolled-back",
      outcome: { status: "rolled-back", reason: "new build refused the configuration (exit 78)" },
    });
    expect(await fs.realpath(path.join(prefix, "openclaw"))).toBe(
      path.join(prefix, "releases/old/openclaw"),
    );
    run.child.kill("SIGTERM");
    await run.exited;
  });

  it("restarts an unrequested zero exit immediately and forwards stop with the child's code", async () => {
    const { prefix, launcher } = await fixture(`
      import fs from 'node:fs';
      const count = new URL('../count', import.meta.url);
      if (!fs.existsSync(count)) { fs.writeFileSync(count, 'once'); process.exit(0); }
      console.log('SECOND');
    `);
    await switchLink("releases/new/openclaw", prefix);
    const run = start(launcher);
    await output(run.child, "SECOND", run.stdout);
    run.child.kill("SIGTERM");
    expect((await run.exited)[0]).toBe(23);
    expect(run.stdout()).toContain("STOP");
  });

  it("stops a live child whose combined trial budget expired and rolls back", async () => {
    const { prefix, launcher } = await fixture("console.log('HANGING');");
    const trial = await pending(prefix);
    await switchLink(trial.target, prefix);
    await writeTrial(
      { ...trial, phase: "trial", createdAt: Date.now() - TRIAL_BUDGET_MS + 1500 },
      prefix,
    );
    const run = start(launcher);
    await output(run.child, "HANGING", run.stdout);
    await output(run.child, "OLD", run.stdout);
    expect(run.stdout()).toContain("STOP");
    expect(await readTrial(prefix)).toMatchObject({
      phase: "rolled-back",
      outcome: { reason: `new build did not become ready in ${TRIAL_BUDGET_MS / 60000} min` },
    });
  });

  it("finishes a missing-link interruption and leaves non-Gateway commands outside the trial", async () => {
    const { prefix, launcher } = await fixture("ready();");
    await pending(prefix);
    await fs.rename(
      path.join(prefix, "openclaw"),
      path.join(prefix, ".openclaw.release-link-interrupted"),
    );
    const run = start(launcher, ["gateway", "status"]);
    expect((await run.exited)[0]).toBe(0);
    expect(run.stdout()).toContain('ENTRY ["gateway","status"]');
    expect(await readTrial(prefix)).toMatchObject({ phase: "pending", attempts: 0 });
    expect(await fs.realpath(path.join(prefix, "openclaw"))).toBe(
      path.join(prefix, "releases/old/openclaw"),
    );
  });
});

it("returns an absolute launcher path and never downgrades a newer frozen format", async () => {
  const { prefix, launcher } = await fixture("ready();");
  expect(await writeLauncher(path.relative(process.cwd(), prefix))).toBe(launcher);
  const future = "// OpenClaw launcher format: 3\n";
  await fs.writeFile(launcher, future);
  await writeLauncher(prefix);
  await writeGitReleaseLauncher(prefix);
  expect(await fs.readFile(launcher, "utf8")).toBe(future);
});
