import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { on } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { spawnWindowsJobChild } from "../../scripts/lib/managed-windows-job.mts";
import type { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import { hasErrnoCode } from "../infra/errno.js";
import { buildTaskScript, encodeWindowsLauncherScript } from "./schtasks-layout.js";
import { startupArgvCaptureSource } from "./schtasks.startup-observer-fixtures.test-support.js";
import type { GatewayServiceEnv } from "./service-types.js";

const OUTPUT_LIMIT = 16 * 1024;
const identity = z.number().int().gt(1);
const observation = z
  .object({
    event: z.enum(["survived", "failed", "diagnostic-exit"]),
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
  async function run(
    variant:
      | "unchanged-stdio-control"
      | "file-backed-diagnostic"
      | "parent-retained-diagnostic"
      | "exit-tag-pathological-diagnostic"
      | "exit-tag-ascii-path-diagnostic"
      | "exit-tag-code-page-header-diagnostic"
      | "exit-tag-argv-capture-diagnostic",
    scriptPath = params.scriptPath,
    argvCapture?: {
      helperPath: string;
      helperSha256: string;
      resultPath: string;
      expectedArguments: string[];
      originalScriptSha256: string;
    },
  ) {
    const expectedExitTag = variant.startsWith("exit-tag-") ? 42 : undefined;
    const bytes = await fs.readFile(scriptPath);
    assert.ok(bytes.length <= OUTPUT_LIMIT, "Startup script exceeded the diagnostic bound");
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
        scriptPath,
        expectedExitTag,
        argvCapture,
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
          ...(scriptPath !== params.scriptPath ? { OPENCLAW_TASK_SCRIPT: scriptPath } : {}),
        },
      }),
    );
    params.signal.throwIfAborted();
    const launched = spawnWindowsJobChild(process.execPath, [params.observerPath, specPath], {
      cwd: process.cwd(),
      env: argvCapture
        ? { ...process.env, OPENCLAW_STARTUP_ARGV_RESULT: argvCapture.resultPath }
        : process.env,
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
    // The previous fixture allowed 30 s for the parent and another 30 s for its marker.
    const deadline = setTimeout(stop, params.timeoutMs * 2);
    const evidence: Record<string, unknown> = {
      mode: params.mode,
      variant,
      ancestorJob: "outer observer retains inherited descendants",
      probeReleaseGate:
        expectedExitTag === undefined
          ? "after survival, within the original probe deadline"
          : "none; observe CMD exit",
      scriptPath,
      scriptEncoding:
        expectedExitTag === undefined || argvCapture
          ? "encodeWindowsLauncherScript(cmd)"
          : "ASCII CRLF",
      ...(argvCapture ? { argvCapture } : {}),
      scriptBase64: bytes.toString("base64"),
      scriptSha256: createHash("sha256").update(bytes).digest("hex"),
      ...(expectedExitTag === undefined ? {} : { expectedExitTag, lifecycleQualification: false }),
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
      assert.deepEqual(
        await fs.readFile(scriptPath),
        bytes,
        "Observed Startup script bytes changed",
      );
      Object.assign(evidence, {
        members,
        jobLauncherPid: child.pid,
        observerCommandPid: job.commandPid,
        cmdMembershipAtCheckpoint:
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
      if (record.event === "diagnostic-exit") {
        assert.ok(record.invocation, "Exit-tag owner invocation was not recorded");
        assert.equal(record.invocation.spawnObserved, true);
        assert.equal(record.invocation.detached, true);
        assert.equal(record.invocation.originalStdio, "ignore");
        assert.equal(record.invocation.scriptPath, scriptPath);
      }
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
      }
      if (record.event === "survived" || record.event === "diagnostic-exit") {
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
        messageController.abort();
      }
    }
  }
  async function diagnoseArgvCapture(original: Buffer) {
    const variant = "exit-tag-argv-capture-diagnostic";
    const file = path.join(params.proofRoot, `${params.mode}-${variant}.observation.json`);
    const notRun = (reason: string) =>
      fs.writeFile(
        file,
        JSON.stringify({
          mode: params.mode,
          variant,
          event: "not-run",
          lifecycleQualification: false,
          scriptPath: params.scriptPath,
          reason,
        }),
      );
    let root: string;
    let canonicalRoot: string;
    try {
      root = params.lifetime.createTempDir("openclaw-startup-argv-");
      canonicalRoot = await fs.realpath(root);
    } catch (error) {
      await notRun(
        `The isolated argv helper directory is unavailable: ${String(error).slice(0, 512)}`,
      );
      return;
    }
    const helperPath = path.join(canonicalRoot, "argv-capture.cjs");
    const resultPath = path.join(canonicalRoot, "argv-result.json");
    const asciiPath = (value: string) =>
      /^[\x20-\x7e]+$/u.test(value) && !/[&|<>^%!"()]/u.test(value);
    if (![path.resolve(root), helperPath, resultPath].every(asciiPath)) {
      await notRun("The argv helper's complete isolated path is not ASCII and syntax-neutral");
      return;
    }
    const expectedArguments = [params.probePath, params.markerPath, params.parentPidPath];
    const render = (args: string[]) =>
      encodeWindowsLauncherScript({
        format: "cmd",
        content: buildTaskScript({ programArguments: [process.execPath, ...args] }),
      });
    if (!render(expectedArguments).equals(original)) {
      await notRun(
        "Current production encoding does not reproduce the saved original script bytes",
      );
      return;
    }
    const captureScript = render([helperPath, ...expectedArguments]);
    const preamble = /^@chcp [0-9]+ >nul\r\n@rem openclaw-launcher-encoding=\S+\r\n/u.exec(
      original.toString("latin1"),
    )?.[0];
    if (
      !preamble ||
      !captureScript.subarray(0, preamble.length).equals(original.subarray(0, preamble.length))
    ) {
      await notRun("The argv capture script does not retain the exact original code-page preamble");
      return;
    }
    await fs.writeFile(helperPath, startupArgvCaptureSource, { flag: "wx" });
    await fs.writeFile(params.scriptPath, captureScript);
    await run(variant, params.scriptPath, {
      helperPath,
      helperSha256: createHash("sha256").update(startupArgvCaptureSource).digest("hex"),
      resultPath,
      expectedArguments,
      originalScriptSha256: createHash("sha256").update(original).digest("hex"),
    });
    assert.deepEqual(
      await fs.readFile(helperPath),
      Buffer.from(startupArgvCaptureSource),
      "ASCII argv helper bytes changed during observation",
    );
  }
  async function diagnoseExitTag() {
    const original = await fs.readFile(params.scriptPath);
    const tagged = Buffer.from("@exit /b 42\r\n", "ascii");
    const variants = [
      "exit-tag-pathological-diagnostic",
      "exit-tag-ascii-path-diagnostic",
      "exit-tag-code-page-header-diagnostic",
      "exit-tag-argv-capture-diagnostic",
    ] as const;
    try {
      await fs.writeFile(params.scriptPath, tagged);
      const pathological = await run(variants[0]);
      if (pathological.exitTagMatched === true && !params.signal.aborted) {
        const header = /^@chcp [0-9]+ >nul\r\n/u.exec(original.toString("latin1"))?.[0];
        if (header) {
          // Keep the observed preamble bytes; this probe must not choose a code page.
          await fs.writeFile(
            params.scriptPath,
            Buffer.concat([
              original.subarray(0, header.length),
              Buffer.from("@if errorlevel 1 exit /b 43\r\n", "ascii"),
              tagged,
            ]),
          );
          const headerResult = await run(variants[2]);
          if (headerResult.exitTagMatched === true && !params.signal.aborted) {
            await diagnoseArgvCapture(original);
          }
        } else {
          await fs.writeFile(
            path.join(params.proofRoot, `${params.mode}-${variants[2]}.observation.json`),
            JSON.stringify({
              mode: params.mode,
              variant: variants[2],
              event: "not-run",
              lifecycleQualification: false,
              reason: "Original Startup script has no ASCII @chcp <page> >nul CRLF preamble",
              scriptPath: params.scriptPath,
            }),
          );
        }
      } else if (pathological.exitTagMatched !== true && !params.signal.aborted) {
        // Only the disposable script lives in the generation owner; evidence stays in proofRoot.
        const neutralRoot = params.lifetime.createTempDir("openclaw-startup-ascii-");
        const canonicalRoot = await fs.realpath(neutralRoot);
        const neutralScript = path.join(canonicalRoot, "gateway.cmd");
        const asciiPath = (value: string) =>
          /^[\x20-\x7e]+$/u.test(value) && !/[&|<>^%!"()]/u.test(value);
        if (!asciiPath(path.resolve(neutralRoot)) || !asciiPath(neutralScript)) {
          await fs.writeFile(
            path.join(params.proofRoot, `${params.mode}-${variants[1]}.observation.json`),
            JSON.stringify({
              mode: params.mode,
              variant: variants[1],
              event: "not-run",
              lifecycleQualification: false,
              reason: "The isolated owner's complete path is not ASCII and syntax-neutral",
              scriptPath: neutralScript,
            }),
          );
          return;
        }
        await fs.writeFile(neutralScript, tagged, { flag: "wx" });
        await run(variants[1], neutralScript);
      }
    } finally {
      await fs.writeFile(params.scriptPath, original);
      assert.deepEqual(
        await fs.readFile(params.scriptPath),
        original,
        "Original Startup script was not restored",
      );
      const scriptRestoration = {
        path: params.scriptPath,
        sha256: createHash("sha256").update(original).digest("hex"),
        restored: true,
      };
      for (const variant of variants) {
        const file = path.join(params.proofRoot, `${params.mode}-${variant}.observation.json`);
        const contents = await fs.readFile(file, "utf8").catch((error: unknown) => {
          if (hasErrnoCode(error, "ENOENT")) {
            return undefined;
          }
          throw error;
        });
        if (contents === undefined) {
          continue;
        }
        const evidence = z.record(z.string(), z.unknown()).parse(JSON.parse(contents));
        await fs.writeFile(file, JSON.stringify({ ...evidence, scriptRestoration }));
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
          const retained = await run("parent-retained-diagnostic");
          if (retained.event === "failed" && params.mode === "batch" && !params.signal.aborted) {
            await diagnoseExitTag();
          }
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
