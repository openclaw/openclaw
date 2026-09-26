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

// This helper records only the arguments that reached Node; it never runs the original probe.
export const startupArgvCaptureSource = String.raw`
const fs = require("node:fs");
const result = {
  event: "argv-captured", pid: process.pid, ppid: process.ppid,
  execPath: process.execPath, argv: process.argv, observedAt: Date.now(), error: null,
};
try { result.cwd = process.cwd(); }
catch (error) { result.error = { code: error.code ?? null, message: String(error.message).slice(0, 512) }; }
let text = JSON.stringify(result);
let complete = result.error === null;
if (Buffer.byteLength(text) > 8 * 1024) {
  complete = false;
  text = JSON.stringify({ event: "argv-capture-overflow", pid: process.pid, ppid: process.ppid,
    argvCount: process.argv.length, evidenceBytes: Buffer.byteLength(text) });
}
const resultPath = process.env.OPENCLAW_STARTUP_ARGV_RESULT;
if (!resultPath) throw new Error("Argv capture result path was not inherited");
fs.writeFileSync(resultPath + ".tmp", text, { flag: "wx" });
fs.renameSync(resultPath + ".tmp", resultPath);
process.exitCode = complete ? 42 : 44;
`;

const harnessSource = String.raw`
import cp from "node:child_process";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const launcherStartedAt = Date.now();
const spec = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const save = (value) => {
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > spec.outputLimit) throw new Error("Invocation evidence exceeded its bound");
  fs.writeFileSync(spec.invocationPath + ".tmp", text);
  fs.renameSync(spec.invocationPath + ".tmp", spec.invocationPath);
};
const nativeSpawn = cp.spawn;
let detachedRecord;
cp.spawn = (command, args, options) => {
  if (options?.detached !== true) return nativeSpawn(command, args, options);
  let effectiveArgs = args;
  if (spec.preOpenCodePage !== undefined) {
    if (spec.mode !== "batch" || !/^[0-9]+$/.test(spec.preOpenCodePage) ||
        !["exit-tag-argv-pre-open-diagnostic", "original-body-pre-open-diagnostic"].includes(spec.variant) ||
        JSON.stringify(args) !== JSON.stringify(["/d", "/s", "/v:off", "/c", '""%OPENCLAW_TASK_SCRIPT%""']) ||
        options.windowsVerbatimArguments !== true || options.windowsHide !== true || options.stdio !== "ignore") {
      throw new Error("Pre-open diagnostic does not match the original CMD invocation policy");
    }
    effectiveArgs = [...args.slice(0, -1), '"chcp ' + spec.preOpenCodePage + ' >nul & "%OPENCLAW_TASK_SCRIPT%""'];
  }
  const record = {
    command, args, effectiveArgs, preOpenCodePage: spec.preOpenCodePage,
    cwd: options.cwd ?? process.cwd(), detached: options.detached,
    windowsHide: options.windowsHide, windowsVerbatimArguments: options.windowsVerbatimArguments ?? false,
    originalStdio: options.stdio, variant: spec.variant,
    effectiveStdio: spec.variant === "file-backed-diagnostic" ? ["ignore", "file", "file"] : options.stdio,
    scriptPath: options.env?.OPENCLAW_TASK_SCRIPT ?? null, spawnObserved: false, exitObserved: false,
    exitCode: null, exitSignal: null,
  };
  detachedRecord = record;
  save(record);
  const descriptors = spec.variant === "file-backed-diagnostic"
    ? [fs.openSync(spec.stdoutPath, "wx"), fs.openSync(spec.stderrPath, "wx")] : [];
  try {
    const child = nativeSpawn(command, effectiveArgs, descriptors.length
      ? { ...options, stdio: ["ignore", ...descriptors] } : options);
    child.once("spawn", () => { record.pid = child.pid; record.spawnObserved = true; save(record); });
    child.once("error", (error) => { record.errorCode = error.code ?? null; save(record); });
    child.once("exit", (code, signal) => {
      Object.assign(record, { exitObserved: true, exitCode: code, exitSignal: signal }); save(record);
    });
    return child;
  } finally {
    for (const fd of descriptors) fs.closeSync(fd);
  }
};
syncBuiltinESMExports();
fs.writeFileSync(spec.parentPidPath, String(process.pid));
const { launchFallbackTaskScript } = await import(spec.runtimeModuleUrl);
const command = spec.mode === "direct" ? {
  programArguments: [process.execPath, spec.probePath, spec.markerPath, spec.parentPidPath],
  workingDirectory: spec.proofRoot,
} : null;
await launchFallbackTaskScript(spec.env, command);
if (spec.variant === "parent-retained-diagnostic" || spec.expectedExitTag !== undefined) {
  if (!detachedRecord) throw new Error("Parent-retained diagnostic did not observe an owner spawn");
  detachedRecord.parentRetention = { startedAt: Date.now(), releasedAt: null, reason: null };
  save(detachedRecord);
  await new Promise((resolve) => {
    const release = (reason) => {
      Object.assign(detachedRecord.parentRetention, { releasedAt: Date.now(), reason });
      save(detachedRecord);
      resolve();
    };
    function observe() {
      if (detachedRecord.exitObserved) { release("detached-child-exit"); return; }
      if (spec.expectedExitTag === undefined && fs.existsSync(spec.markerPath + ".started.json")) {
        release("probe-start"); return;
      }
      if (Date.now() >= launcherStartedAt + spec.timeoutMs) {
        process.exitCode = 2;
        release("original-launcher-deadline");
        return;
      }
      setTimeout(observe, 25);
    }
    observe();
  });
}
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
const readOutput = (file) => {
  try {
    const fd = fs.openSync(file, "r");
    try {
      const bytes = fs.fstatSync(fd).size;
      const buffer = Buffer.alloc(Math.min(bytes, spec.outputLimit));
      const count = fs.readSync(fd, buffer, 0, buffer.length, 0);
      return { bytes, truncated: bytes > count, base64: buffer.subarray(0, count).toString("base64") };
    } finally { fs.closeSync(fd); }
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
function readArgvCapture() {
  if (!spec.argvCapture) return undefined;
  try { return { result: read(spec.argvCapture.resultPath), error: null }; }
  catch (error) { return { result: null,
    error: { code: error.code ?? null, message: String(error.message).slice(0, 512) } }; }
}
function report(event, extra = {}) {
  const record = {
    event, observerPid: process.pid, launcherPid: parent.pid, parentExit, ...output,
    invocation: read(spec.invocationPath), started: read(spec.markerPath + ".started.json"),
    survived: read(spec.markerPath + ".survived.json"),
    diagnosticStdout: readOutput(spec.stdoutPath), diagnosticStderr: readOutput(spec.stderrPath),
    ...(spec.argvCapture ? { argvCapture: readArgvCapture() } : {}),
    ...extra,
  };
  process.send(record);
}
function tick() {
  try {
    if (failure) throw failure;
    // Observe file bounds while the real detached child can still write.
    for (const file of [spec.stdoutPath, spec.stderrPath]) {
      if (fs.existsSync(file) && fs.statSync(file).size > spec.outputLimit) {
        throw new Error("Detached diagnostic output exceeded its bound");
      }
    }
    const marker = read(spec.markerPath, false);
    if (parentExit) {
      if (parentExit.code !== 0) throw new Error("Startup launcher parent did not exit successfully");
      if (spec.expectedExitTag !== undefined) {
        const invocation = read(spec.invocationPath);
        if (invocation?.exitObserved !== true) throw new Error("Exit-tag CMD status was not observed");
        report("diagnostic-exit", {
          expectedExitTag: spec.expectedExitTag,
          exitTagMatched: invocation.exitCode === spec.expectedExitTag,
        });
        return;
      }
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
  if (spec.expectedExitTag === undefined) fs.writeFileSync(spec.markerPath + ".release", "release");
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
