import fs from "node:fs/promises";
import path from "node:path";
import { ROOT_VALUE_FLAGS } from "../../cli-root-options.mjs";
import { GATEWAY_RUN_VALUE_FLAGS } from "../../gateway-run-argv.mjs";
import { hasErrnoCode } from "../infra/errno.js";
import { LINK_SOURCE } from "./link-source.js";
import { ROLLBACK_SOURCE } from "./rollback-source.js";

const LAUNCHER_FORMAT = 3;
// Both starts share the wall-clock ceiling; migration keeps the full allowance.
export const TRIAL_BUDGET_MS = 20 * 60 * 1000;
// A reported healthy host needed 496 seconds for agent preparation before ready.
const POST_UPGRADE_BUDGET_MS = 10 * 60 * 1000;

// Frozen source: no release dependency can prevent recovery. The sole exception is the
// best-effort Windows console binding, imported from the selected release with a timeout.
const LAUNCHER_SOURCE = String.raw`#!/usr/bin/env node
// OpenClaw launcher format: ${LAUNCHER_FORMAT}
import fs from "node:fs";
import path from "node:path";
import { fork, spawn } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const prefix = path.dirname(fileURLToPath(import.meta.url));
// A first-conversion fallback may still be a checkout/global package with its own forwarder.
process.env.OPENCLAW_RELEASE_LAUNCHER_FORWARDED = "1";
const slot = path.join(prefix, "openclaw");
const trialFile = path.join(prefix, "releases", ".trial");
const budget = ${TRIAL_BUDGET_MS};
const postUpgradeBudget = ${POST_UPGRADE_BUDGET_MS};
const valueFlags = new Set(${JSON.stringify([...ROOT_VALUE_FLAGS, ...GATEWAY_RUN_VALUE_FLAGS, "--task-supervisor-child"])});
const args = process.argv.slice(2);
const childArgs = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--task-supervisor") continue;
  if (args[i] === "--task-supervisor-child") { i++; continue; }
  if (args[i].startsWith("--task-supervisor-child=")) continue;
  childArgs.push(args[i]);
}
const positionals = [];
let literal = false;
let informational = false;
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (literal || !arg.startsWith("-")) positionals.push(arg);
  else if (arg === "--") literal = true;
  else if (valueFlags.has(arg)) i++;
  else if (["-h", "--help", "-V", "--version"].includes(arg)) informational = true;
}
const gatewayRun = !informational && positionals[0] === "gateway" &&
  (positionals.length === 1 || (positionals.length === 2 && positionals[1] === "run"));
globalThis[Symbol.for("openclaw.gitReleaseLauncher")] = fileURLToPath(import.meta.url);
const linked = (target) => path.resolve(prefix, target);
function readTrial() {
  try { return JSON.parse(fs.readFileSync(trialFile, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; return null; }
}
function writeTrial(record) {
  const temporary = trialFile + "." + process.pid;
  const fd = fs.openSync(temporary, "w", 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(record)); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(temporary, trialFile);
  // Windows cannot open a directory for fsync.
  if (process.platform !== "win32") {
    const dir = fs.openSync(path.dirname(trialFile), "r");
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  }
}
${ROLLBACK_SOURCE}
${LINK_SOURCE}
let stderrTail = Buffer.alloc(0);
let stderrTarget;
function rollback(trial, reason) {
  if (trial.phase !== "restoring") {
    trial.phase = "restoring";
    trial.outcome = { status: "rolled-back", reason, stderrTail: stderrTail.toString("utf8"), at: Date.now() };
    trial.restoring = [];
    const since = trial.createdAt - 1000;
    for (const generation of new Set([trial.buildId, trial.version].filter(Boolean))) {
      const suffix = ".pre-" + generation;
      const files = collectPreserved(path.dirname(prefix), suffix, since, 4, []);
      if (trial.config && !files.includes(trial.config) && (fs.lstatSync(trial.config + suffix, { throwIfNoEntry: false })?.ctimeMs ?? 0) >= since) files.push(trial.config);
      trial.restoring.push({ suffix, files });
    }
    // Inventory and phase precede every mutation; a killed restore replays safely.
    writeTrial(trial);
  }
  for (const generation of new Set([trial.buildId, trial.version].filter(Boolean))) retirePlans(path.dirname(prefix), generation);
  for (const { suffix, files } of trial.restoring) restoreState(files, suffix);
  switchLink(trial.previous);
  trial.phase = "rolled-back";
  writeTrial(trial);
  console.error("openclaw: " + trial.outcome.reason + "; switched back to " + trial.previous);
  return trial;
}
function startRule() {
  finishSwitch();
  let trial = readTrial();
  if (trial?.phase === "pending") {
    switchLink(trial.target);
    trial.phase = "trial";
    trial.createdAt = Date.now();
    trial.attempts = 0;
    writeTrial(trial);
  }
  if (trial?.phase === "restoring") return rollback(trial);
  if (trial?.phase === "trial") {
    if (Date.now() - trial.createdAt >= budget) return rollback(trial, "new build did not become ready in " + budget / 60000 + " min");
    if (trial.attempts >= 2) return rollback(trial, "new build failed to start");
    trial.attempts++;
    writeTrial(trial);
  }
  return trial;
}

if (!gatewayRun) {
  finishSwitch();
  process.argv[1] = path.join(slot, "dist", "entry.js");
  await import(pathToFileURL(process.argv[1]).href);
} else {
  let child;
  let stopping = false;
  let killTimer;
  let budgetTimer;
  let restartTimer;
  let crashRestarts = 0;
  let consoleBound = false;
  function forceKill() {
    if (!child?.pid) return;
    if (process.platform === "win32") {
      const killer = spawn("taskkill", ["/T", "/F", "/PID", String(child.pid)], { stdio: "ignore", windowsHide: true });
      killer.on("error", (error) => console.error("openclaw: taskkill failed: " + error.message));
    } else {
      try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    }
  }
  function stopChild() {
    if (!child) return;
    if (child.connected) child.send({ type: "openclaw.stop" }, () => {});
    killTimer ??= setTimeout(forceKill, 15000);
  }
  function shutdown() {
    if (stopping) return;
    stopping = true;
    clearTimeout(restartTimer);
    if (child) stopChild();
    else process.exit(0);
  }
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, shutdown);

  async function start() {
    const trial = startRule();
    if (trial?.phase === "trial" && stderrTarget !== trial.target) {
      stderrTarget = trial.target;
      stderrTail = Buffer.alloc(0);
    }
    // This optional platform module is runtime-selected from the release, never a recovery dependency.
    if (process.platform === "win32" && !consoleBound) {
      consoleBound = true;
      const kind = process.env.OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER;
      delete process.env.OPENCLAW_WINDOWS_TASK_HIDDEN_LAUNCHER;
      if (kind === "wscript" || kind === "cmd") {
        let timer;
        try {
          const binding = import(pathToFileURL(path.join(slot, "dist/process/supervisor/service-child-windows-task-launcher.js")).href);
          const timeout = Promise.withResolvers();
          timer = setTimeout(() => timeout.reject(new Error("binding timed out")), 2000);
          const module = await Promise.race([binding, timeout.promise]);
          module.bindWindowsTaskLauncher(kind);
        } catch (error) { console.error("openclaw: Windows console binding unavailable: " + error.message); }
        finally { clearTimeout(timer); }
      }
    }
    if (stopping) return;
    const startedAt = Date.now();
    let deadline = trial?.phase === "trial" ? trial.createdAt + budget : 0;
    let budgetReason = "new build did not become ready in " + budget / 60000 + " min";
    let budgetExpired = false;
    const expireBudget = () => { budgetExpired = true; stopChild(); };
    child = fork(path.join(slot, "dist", "index.js"), childArgs, {
      stdio: ["inherit", "inherit", "pipe", "ipc"],
      env: { ...process.env, OPENCLAW_LAUNCHER_IPC: "1", OPENCLAW_RELEASE_LAUNCHER_FORWARDED: "1" },
      detached: process.platform !== "win32",
    });
    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
      stderrTail = chunk.length >= 8192
        ? Buffer.from(chunk.subarray(-8192))
        : Buffer.concat([stderrTail.subarray(Math.max(0, stderrTail.length + chunk.length - 8192)), chunk]);
    });
    child.on("message", (message) => {
      if (stopping || budgetExpired) return;
      if (message?.type !== "openclaw.ready" && message?.type !== "openclaw.trial") return;
      const current = readTrial();
      if (current?.phase === "trial" && Date.now() >= deadline) {
        expireBudget();
        return;
      }
      if (message.type === "openclaw.trial") {
        // One stage mark, not a heartbeat: later marks cannot extend this deadline.
        if (message.phase === "trial" && current?.phase === "trial" && Date.now() + postUpgradeBudget < deadline) {
          deadline = Date.now() + postUpgradeBudget;
          budgetReason = "The new version did not finish starting within " + postUpgradeBudget / 60000 + " minutes";
          clearTimeout(budgetTimer);
          budgetTimer = setTimeout(expireBudget, Math.max(0, deadline - Date.now()));
        }
        return;
      }
      if (current?.phase === "trial" && linked(current.target) === linked(fs.readlinkSync(slot)) && (!current.buildId || message.buildId === current.buildId)) {
        current.phase = "committed";
        current.outcome = { status: "succeeded", ...(message.buildId ? { buildId: message.buildId } : {}), at: Date.now() };
        writeTrial(current);
        clearTimeout(budgetTimer);
      }
      if (child?.connected) child.send({ type: "openclaw.trial", trial: current }, () => {});
    });
    child.on("error", (error) => console.error("openclaw: Gateway child failed: " + error.message));
    child.once("exit", (code, signal) => {
      clearTimeout(killTimer); killTimer = undefined;
      clearTimeout(budgetTimer);
      child = undefined;
      const exitCode = code ?? (signal ? 1 : 0);
      if (stopping) process.exit(exitCode);
      const current = readTrial();
      // 78 refuses the configuration: terminal for a serving release, a failed candidate in a trial.
      if (exitCode === 78 && current?.phase !== "trial") process.exit(78);
      if (exitCode === 78 && current?.phase === "trial") rollback(current, "new build refused the configuration (exit 78)");
      if (budgetExpired && current?.phase === "trial") rollback(current, budgetReason);
      let delay = 0;
      if (exitCode !== 0 && current?.phase !== "trial" && !budgetExpired) {
        if (Date.now() - startedAt >= 5 * 60000) crashRestarts = 0;
        delay = [1000, 2000, 5000, 10000, 30000][Math.min(crashRestarts++, 4)];
      }
      restartTimer = setTimeout(() => { start().catch(fatal); }, delay);
    });
    if (trial?.phase === "trial") {
      budgetTimer = setTimeout(expireBudget, Math.max(0, deadline - Date.now()));
    }
  }
  function fatal(error) { console.error("openclaw: launcher failed: " + error.stack); process.exit(1); }
  await start();
}
`;

export async function writeLauncher(prefix: string): Promise<string> {
  await fs.mkdir(prefix, { recursive: true });
  const launcher = path.resolve(prefix, "openclaw-launcher.mjs");
  const current = await fs.readFile(launcher, "utf8").catch((error: unknown) => {
    if (!hasErrnoCode(error, "ENOENT")) {
      throw error;
    }
    return null;
  });
  const format = current?.match(/^\/\/ OpenClaw launcher format: (\d+)$/m);
  if (!current || !format || Number(format[1]) < LAUNCHER_FORMAT) {
    const temporary = `${launcher}.${process.pid}`;
    const handle = await fs.open(temporary, "w", 0o755);
    try {
      await handle.writeFile(LAUNCHER_SOURCE);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temporary, launcher);
  }
  return launcher;
}
