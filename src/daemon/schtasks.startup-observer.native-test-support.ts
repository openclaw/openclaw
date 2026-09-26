import assert from "node:assert/strict";
import { on } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { spawnWindowsJobChild } from "../../scripts/lib/managed-windows-job.mts";
import type { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import type { GatewayServiceEnv } from "./service-types.js";

const OUTPUT_LIMIT = 16 * 1024;
const identity = z.number().int().gt(1);
const observation = z
  .object({
    event: z.enum(["survived", "failed"]),
    observerPid: identity,
    launcherPid: identity.optional(),
    childPid: identity.optional(),
    invocation: z
      .object({
        pid: identity.optional(),
        spawnObserved: z.boolean(),
        detached: z.boolean(),
        originalStdio: z.unknown(),
      })
      .passthrough()
      .nullable(),
    started: z
      .object({ pid: identity, ppid: identity, argv: z.array(z.string()), cwd: z.string() })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

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
  const record = {
    command, args, cwd: options.cwd ?? process.cwd(), detached: options.detached,
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
    const child = nativeSpawn(command, args, descriptors.length
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
if (spec.variant === "parent-retained-diagnostic") {
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
      if (fs.existsSync(spec.markerPath + ".started.json")) { release("probe-start"); return; }
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
function report(event, extra = {}) {
  const record = {
    event, observerPid: process.pid, launcherPid: parent.pid, parentExit, ...output,
    invocation: read(spec.invocationPath), started: read(spec.markerPath + ".started.json"),
    survived: read(spec.markerPath + ".survived.json"),
    diagnosticStdout: readOutput(spec.stdoutPath), diagnosticStderr: readOutput(spec.stderrPath),
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

export async function runObservedStartupLaunch(params: {
  proofRoot: string;
  harnessPath: string;
  observerPath: string;
  scriptPath: string;
  markerPath: string;
  parentPidPath: string;
  probePath: string;
  mode: "batch" | "direct";
  runtimeModuleUrl: URL;
  env: GatewayServiceEnv;
  timeoutMs: number;
  lifetime: ReturnType<typeof createFixtureLifetime>;
  signal: AbortSignal;
}): Promise<{ launcherPid: number; childPid: number }> {
  async function run(
    variant: "unchanged-stdio-control" | "file-backed-diagnostic" | "parent-retained-diagnostic",
  ) {
    for (const suffix of ["", ".started.json", ".survived.json", ".release"]) {
      await fs.rm(params.markerPath + suffix, { force: true });
    }
    const prefix = path.join(params.proofRoot, `${params.mode}-${variant}`);
    const specPath = `${prefix}.json`;
    await fs.writeFile(
      specPath,
      JSON.stringify({
        ...params,
        lifetime: undefined,
        signal: undefined,
        runtimeModuleUrl: params.runtimeModuleUrl.href,
        variant,
        invocationPath: `${prefix}.invocation.json`,
        stdoutPath: `${prefix}.stdout.log`,
        stderrPath: `${prefix}.stderr.log`,
        launcherCwd: process.cwd(),
        outputLimit: OUTPUT_LIMIT,
        env: {
          APPDATA: params.env.APPDATA,
          OPENCLAW_CONFIG_PATH: params.env.OPENCLAW_CONFIG_PATH,
          OPENCLAW_PROFILE: params.env.OPENCLAW_PROFILE,
          OPENCLAW_STATE_DIR: params.env.OPENCLAW_STATE_DIR,
        },
      }),
    );
    params.signal.throwIfAborted();
    const launched = spawnWindowsJobChild(process.execPath, [params.observerPath, specPath], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      windowsHide: true,
    });
    assert.ok(launched, "Startup observation requires the native Windows Job owner");
    const { child, job } = launched;
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => {
        child.once("close", (code, signal) => resolve({ code, signal }));
      },
    );
    const exited = closed.then(({ code, signal }) => {
      throw new Error(`Startup observer exited before its checkpoint (${code}, ${signal})`);
    });
    void exited.catch(() => {});
    const messages = on(child, "message");
    const stopErrors: unknown[] = [];
    const stop = () => {
      try {
        job.stop();
      } catch (error) {
        stopErrors.push(error);
      }
    };
    let output = "";
    for (const stream of [child.stdout, child.stderr]) {
      stream?.on("error", (error) => {
        stopErrors.push(error);
        stop();
      });
      stream?.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        if (Buffer.byteLength(output) > OUTPUT_LIMIT) {
          output = output.slice(0, OUTPUT_LIMIT);
          stop();
        }
      });
    }
    params.signal.addEventListener("abort", stop, { once: true });
    if (params.signal.aborted) {
      stop();
    }
    // The previous fixture allowed 30 s for the parent and another 30 s for its marker.
    const deadline = setTimeout(stop, params.timeoutMs * 2);
    const evidence: Record<string, unknown> = {
      mode: params.mode,
      variant,
      ancestorJob: "outer observer retains inherited descendants",
      probeReleaseGate: "after survival, within the original probe deadline",
      scriptPath: params.scriptPath,
      scriptEncoding: "encodeWindowsLauncherScript(cmd)",
    };
    const publish = () => fs.writeFile(`${prefix}.observation.json`, JSON.stringify(evidence));
    try {
      await params.lifetime.track(Promise.race([job.ready, exited]));
      params.signal.throwIfAborted();
      let record: z.infer<typeof observation>;
      for (;;) {
        const next = await params.lifetime.track(Promise.race([messages.next(), exited]));
        assert.ok(!next.done);
        if (!job.isControlMessage(next.value[0])) {
          record = observation.parse(next.value[0]);
          break;
        }
      }
      const members = job.inspect();
      const bytes = await fs.readFile(params.scriptPath);
      assert.ok(bytes.length <= OUTPUT_LIMIT, "Startup script exceeded the diagnostic bound");
      Object.assign(evidence, {
        members,
        jobLauncherPid: child.pid,
        observerCommandPid: job.commandPid,
        cmdMembershipAtCheckpoint:
          params.mode === "batch" && record.invocation?.pid
            ? { pid: record.invocation.pid, present: members.includes(record.invocation.pid) }
            : null,
        scriptBase64: bytes.toString("base64"),
        record,
        output,
        scriptDeclaredCodePage:
          /(?:^|\r?\n)@?chcp\s+(\d+)/iu.exec(bytes.toString("latin1"))?.[1] ?? null,
      });
      await publish();
      console.info("[windows-startup-observer]", JSON.stringify(evidence));
      assert.equal(record.observerPid, job.commandPid, "Checkpoint came from another observer");
      assert.ok(members.includes(record.observerPid), "Outer observer escaped the owned Job");
      if (record.event === "survived") {
        assert.ok(
          record.childPid && members.includes(record.childPid),
          "Detached probe escaped the owned Job",
        );
        assert.ok(
          record.launcherPid && !members.includes(record.launcherPid),
          "Short-lived launcher is still alive",
        );
        assert.ok(record.invocation, "Owner invocation was not recorded");
        assert.equal(record.invocation.spawnObserved, true, "Owner spawn was not observed");
        assert.equal(record.invocation.detached, true);
        assert.equal(record.invocation.originalStdio, "ignore");
        assert.deepEqual(record.started?.argv.slice(1), [
          params.probePath,
          params.markerPath,
          params.parentPidPath,
        ]);
        assert.equal(record.started?.pid, record.childPid);
        assert.equal(
          record.started?.ppid,
          params.mode === "direct" ? record.launcherPid : record.invocation.pid,
        );
        if (params.mode === "direct") {
          assert.equal(record.invocation.pid, record.childPid);
        }
        child.send({ release: true });
        assert.deepEqual(await params.lifetime.track(closed), { code: 0, signal: null });
      }
      return record;
    } catch (error) {
      evidence.observationError = String(error).slice(0, OUTPUT_LIMIT);
      throw error;
    } finally {
      let membersBeforeStop: number[] | undefined;
      try {
        membersBeforeStop = job.inspect();
      } catch (error) {
        stopErrors.push(error);
      }
      stop();
      try {
        await params.lifetime.verifyCleanup(async () => {
          const extinction = await job.certify();
          await closed;
          evidence.cleanup = {
            membersBeforeStop,
            termination: "outer Job stop after observation",
            extinction: {
              ...extinction,
              ...("cause" in extinction
                ? { cause: String(extinction.cause).slice(0, OUTPUT_LIMIT) }
                : {}),
            },
            errors: stopErrors.map((error) => String(error).slice(0, OUTPUT_LIMIT)),
          };
          evidence.output = output;
          await publish();
          console.info(
            "[windows-startup-observer-cleanup]",
            JSON.stringify({ mode: params.mode, variant, cleanup: evidence.cleanup }),
          );
          assert.deepEqual(extinction, { status: "confirmed" });
          assert.equal(stopErrors.length, 0, "Startup Job stop failed");
        });
      } finally {
        clearTimeout(deadline);
        params.signal.removeEventListener("abort", stop);
        await messages.return();
      }
    }
  }
  const control = await run("unchanged-stdio-control");
  if (control.event === "failed") {
    const failure = new Error(
      `Startup fallback ${params.mode} failed with unchanged stdio; diagnostic cannot qualify it`,
      { cause: control },
    );
    if (!params.signal.aborted) {
      try {
        const fileBacked = await run("file-backed-diagnostic");
        if (fileBacked.event === "failed" && !params.signal.aborted) {
          await run("parent-retained-diagnostic");
        }
      } catch (diagnosticError) {
        throw new AggregateError(
          [failure, diagnosticError],
          "Startup control failed; diagnostic also failed",
          { cause: diagnosticError },
        );
      }
    }
    throw failure;
  }
  return {
    launcherPid: identity.parse(control.launcherPid),
    childPid: identity.parse(control.childPid),
  };
}
