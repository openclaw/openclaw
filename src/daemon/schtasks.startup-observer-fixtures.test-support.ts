import fs from "node:fs/promises";
import path from "node:path";

// Record execution before testing survival; hold the probe after its survival
// marker so the parent can query its native Job membership independently.
const probeSource = String.raw`
const fs = require("node:fs");
const [marker, parentFile] = process.argv.slice(2);
const write = (file, value) => {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > 16 * 1024) throw new Error("Probe evidence exceeded its bound");
  fs.writeFileSync(file + ".tmp", text);
  fs.renameSync(file + ".tmp", file);
};
const launcherPid = Number(fs.readFileSync(parentFile, "utf8"));
write(marker + ".started.json", {
  pid: process.pid, ppid: process.ppid, argv: process.argv, cwd: process.cwd(), launcherPid, observedAt: Date.now(),
});
const deadline = Date.now() + 10_000;
function waitForLauncherExit() {
  try { process.kill(launcherPid, 0); } catch (error) {
    if (error.code !== "ESRCH") throw error;
    write(marker + ".survived.json", { pid: process.pid, launcherPid, observedAt: Date.now() });
    fs.writeFileSync(marker + ".tmp", process.pid + ":" + launcherPid);
    fs.renameSync(marker + ".tmp", marker);
    waitForRelease();
    return;
  }
  if (Date.now() >= deadline) process.exit(2);
  setTimeout(waitForLauncherExit, 25);
}
function waitForRelease() {
  if (fs.existsSync(marker + ".release")) return;
  if (Date.now() >= deadline) process.exit(3);
  setTimeout(waitForRelease, 25);
}
waitForLauncherExit();
`;

const harnessSource = String.raw`
import cp from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const spec = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const save = (value) => {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > spec.outputLimit) throw new Error("Invocation evidence exceeded its bound");
  fs.writeFileSync(spec.invocationPath + ".tmp", text);
  fs.renameSync(spec.invocationPath + ".tmp", spec.invocationPath);
};
const nativeSpawn = cp.spawn;
cp.spawn = (command, args, options) => {
  const isControl = spec.mode === "batch" &&
    String(command).toLowerCase() === String(spec.powershellPath).toLowerCase() &&
    Array.isArray(args) && args.length === 4 &&
    args[0] === "-NoProfile" && args[1] === "-NonInteractive" && args[2] === "-EncodedCommand" &&
    typeof args[3] === "string" && options?.env?.OPENCLAW_TASK_SCRIPT === spec.scriptPath &&
    options.env.OPENCLAW_STARTUP_CMD === spec.cmdPath;
  if (options?.detached !== true && !isControl) return nativeSpawn(command, args, options);
  const record = {
    command, args,
    cwd: options.cwd ?? process.cwd(), detached: options.detached === true,
    transport: isControl ? "powershell-control" : "detached-payload",
    windowsHide: options.windowsHide, windowsVerbatimArguments: options.windowsVerbatimArguments ?? false,
    originalStdio: options.stdio,
    scriptPath: options.env?.OPENCLAW_TASK_SCRIPT ?? null,
    targetCommand: options.env?.OPENCLAW_STARTUP_CMD ?? null,
    spawnObserved: false, exitObserved: false,
    exitCode: null, exitSignal: null, closeObserved: false, closeCode: null, closeSignal: null,
  };
  save(record);
  const child = nativeSpawn(command, args, options);
  child.once("spawn", () => { record.pid = child.pid; record.spawnObserved = true; save(record); });
  child.once("error", (error) => { record.errorCode = error.code ?? null; save(record); });
  child.once("exit", (code, signal) => {
    Object.assign(record, { exitObserved: true, exitCode: code, exitSignal: signal }); save(record);
  });
  child.once("close", (code, signal) => {
    Object.assign(record, { closeObserved: true, closeCode: code, closeSignal: signal }); save(record);
  });
  return child;
};
syncBuiltinESMExports();
fs.writeFileSync(spec.parentPidPath, String(process.pid));
const { launchFallbackTaskScript } = await import(spec.runtimeModuleUrl);
const command = spec.mode === "direct" ? {
  programArguments: [process.execPath, spec.probePath, spec.markerPath, spec.parentPidPath],
  workingDirectory: spec.proofRoot,
} : null;
await launchFallbackTaskScript(spec.env, command);
`;

const observerSource = String.raw`
import { spawn } from "node:child_process";
import fs from "node:fs";
const spec = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const read = (file, json = true) => {
  try {
    const bytes = fs.readFileSync(file);
    if (bytes.length > spec.outputLimit) throw new Error("Fixture evidence exceeded its bound: " + file);
    return json ? JSON.parse(bytes.toString("utf8")) : bytes.toString("utf8");
  } catch (error) { if (error.code === "ENOENT") return null; throw error; }
};
let parentExit;
let output = { stdout: "", stderr: "" };
let failure;
const launchedAt = Date.now();
const parent = spawn(process.execPath, [spec.harnessPath, process.argv[2]], {
  cwd: spec.launcherCwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
});
parent.once("error", (error) => { failure = error; });
parent.once("close", (code, signal) => { parentExit = { code, signal, observedAt: Date.now() }; });
for (const name of ["stdout", "stderr"]) {
  parent[name].on("data", (chunk) => {
    output[name] += chunk.toString();
    if (Buffer.byteLength(output[name]) > spec.outputLimit) {
      output[name] = output[name].slice(0, spec.outputLimit);
      failure = new Error("Short-lived launcher output exceeded its bound");
    }
  });
}
function report(event, extra = {}) {
  const record = {
    event, observerPid: process.pid, launcherPid: parent.pid, parentExit, ...output,
    invocation: read(spec.invocationPath), started: read(spec.markerPath + ".started.json"),
    survived: read(spec.markerPath + ".survived.json"),
    ...extra,
  };
  process.send(record);
}
function tick() {
  try {
    if (failure) throw failure;
    const marker = read(spec.markerPath, false);
    if (parentExit) {
      if (parentExit.code !== 0) throw new Error("Startup launcher parent did not exit successfully");
      if (marker) {
        const [childPid, launcherPid] = marker.trim().split(":").map(Number);
        const started = read(spec.markerPath + ".started.json");
        const survived = read(spec.markerPath + ".survived.json");
        if (!Number.isSafeInteger(childPid) || childPid <= 1 || launcherPid !== parent.pid ||
            started?.pid !== childPid || survived?.pid !== childPid || survived.launcherPid !== parent.pid) {
          throw new Error("Startup execution and survival identities differ");
        }
        report("survived", { childPid });
        return;
      }
      if (Date.now() - parentExit.observedAt >= spec.timeoutMs) {
        throw new Error("Startup fallback detached process did not write its launch marker");
      }
    } else if (Date.now() - launchedAt >= spec.timeoutMs) {
      throw new Error("Startup launcher parent exceeded its original deadline");
    }
    setTimeout(tick, 200);
  } catch (error) {
    try { report("failed", { error: error.message }); }
    catch (evidenceError) { process.send({ event: "failed", observerPid: process.pid,
      invocation: null, error: error.message, evidenceError: evidenceError.message }); }
  }
}
process.once("message", () => {
  fs.writeFileSync(spec.markerPath + ".release", "release");
  process.disconnect();
});
tick();
`;

export async function writeStartupObserverFixture(params: {
  proofRoot: string;
  probePath: string;
  harnessPath: string;
}) {
  const observerPath = path.join(params.proofRoot, "observer.mjs");
  await fs.writeFile(params.probePath, probeSource);
  await fs.writeFile(params.harnessPath, harnessSource);
  await fs.writeFile(observerPath, observerSource);
  return observerPath;
}
