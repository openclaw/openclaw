import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { on } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { spawnWindowsJobChild } from "../../scripts/lib/managed-windows-job.mts";
import type { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import {
  getWindowsCmdExePath,
  getWindowsPowerShellExePath,
} from "../infra/windows-install-roots.js";
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
  const variant = "unchanged-stdio-control";
  const scriptPath = params.scriptPath;
  const bytes = await fs.readFile(scriptPath);
  assert.ok(bytes.length <= OUTPUT_LIMIT, "Startup script exceeded the evidence bound");
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
      scriptPath,
      powershellPath: getWindowsPowerShellExePath(),
      cmdPath: getWindowsCmdExePath(),
      invocationPath: `${prefix}.invocation.json`,
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
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const exited = closed.then(({ code, signal }) => {
    throw new Error(`Startup observer exited before its checkpoint (${code}, ${signal})`);
  });
  void exited.catch(() => {});
  const messageController = new AbortController();
  const messages = on(child, "message", { signal: messageController.signal });
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
  // Keep the launch and survival observation within the existing two-phase budget.
  const deadline = setTimeout(stop, params.timeoutMs * 2);
  const evidence: Record<string, unknown> = {
    mode: params.mode,
    variant,
    ancestorJob: "outer observer retains inherited descendants",
    probeReleaseGate: "after survival, within the original probe deadline",
    scriptPath,
    scriptEncoding: "encodeWindowsLauncherScript(cmd)",
    scriptBase64: bytes.toString("base64"),
    scriptSha256: createHash("sha256").update(bytes).digest("hex"),
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
    assert.deepEqual(await fs.readFile(scriptPath), bytes, "Observed Startup script bytes changed");
    Object.assign(evidence, {
      members,
      jobLauncherPid: child.pid,
      observerCommandPid: job.commandPid,
      cmdMembershipAtCheckpoint:
        params.mode === "batch" && record.event === "survived" && record.started
          ? { pid: record.started.ppid, present: members.includes(record.started.ppid) }
          : null,
      powershellMembershipAtCheckpoint:
        params.mode === "batch" && record.invocation?.pid
          ? { pid: record.invocation.pid, present: members.includes(record.invocation.pid) }
          : null,
      record,
      output,
      scriptDeclaredCodePage:
        /(?:^|\r?\n)@?chcp\s+(\d+)/iu.exec(bytes.toString("latin1"))?.[1] ?? null,
    });
    await publish();
    console.info("[windows-startup-observer]", JSON.stringify(evidence));
    assert.equal(record.observerPid, job.commandPid, "Checkpoint came from another observer");
    assert.ok(members.includes(record.observerPid), "Outer observer escaped the owned Job");
    if (record.event !== "survived") {
      throw new Error(`Startup fallback ${params.mode} did not survive its launcher`, {
        cause: record,
      });
    }
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
    assert.deepEqual(record.started?.argv.slice(1), [
      params.probePath,
      params.markerPath,
      params.parentPidPath,
    ]);
    assert.equal(record.started?.pid, record.childPid);
    if (params.mode === "direct") {
      assert.equal(record.invocation.detached, true);
      assert.equal(record.invocation.originalStdio, "ignore");
      assert.equal(record.started?.ppid, record.launcherPid);
      assert.equal(record.invocation.pid, record.childPid);
    } else {
      assert.equal(record.invocation.transport, "powershell-control");
      assert.equal(record.invocation.detached, false);
      const cmdPid = identity.parse(record.started?.ppid);
      assert.notEqual(cmdPid, record.invocation.pid);
      assert.notEqual(cmdPid, record.launcherPid);
      assert.ok(members.includes(cmdPid), "CMD parent escaped the original Job");
      assert.ok(
        record.invocation.pid && !members.includes(record.invocation.pid),
        "PowerShell creation control is still alive",
      );
      assert.equal(record.invocation.command, getWindowsPowerShellExePath());
      assert.equal(record.invocation.targetCommand, getWindowsCmdExePath());
      assert.equal(record.invocation.exitObserved, true);
      assert.equal(record.invocation.exitCode, 0);
      assert.equal(record.invocation.exitSignal, null);
      assert.equal(record.invocation.closeObserved, true);
      assert.equal(record.invocation.closeCode, 0);
      assert.equal(record.invocation.closeSignal, null);
    }
    child.send({ release: true });
    assert.deepEqual(await params.lifetime.track(closed), { code: 0, signal: null });
    return {
      launcherPid: identity.parse(record.launcherPid),
      childPid: identity.parse(record.childPid),
    };
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
      messageController.abort();
    }
  }
}
