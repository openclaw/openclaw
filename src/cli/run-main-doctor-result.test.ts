import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  installPrivateUpdateHandoffStore,
  writePrivateUpdateHandoffChildGuard,
} from "../../test/helpers/private-update-handoff-store.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { isChildProcessTreeAlive } from "../process/child-process-tree.js";
import { withCommandProcessScope } from "../process/exec-spawn.js";
import { tryRunDoctorResultBridge } from "./run-main-doctor-result.js";
import { updateExecutorNativeEntrypoints } from "./update-cli/update-command-executor-native-runtime.test-support.js";

const directories = useAutoCleanupTempDirTracker(afterEach);
const resultEnv = "OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH";
const warning = "conditional fixture warning";
const stopped = expect.stringContaining("every tracked process group stopped");
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.exitCode = undefined;
});

it.skipIf(process.platform === "win32").each([
  ["normal", { status: "ok", warnings: [warning] }, undefined],
  ["interrupted", undefined, 1],
  [
    "unsettled",
    {
      status: "error",
      failureFacts: [expect.objectContaining({ code: "doctor-processes-unsettled" })],
    },
    undefined,
  ],
  ["completed-cleanup", { status: "ok", warnings: expect.arrayContaining([warning, stopped]) }, 0],
  ["plain-nonzero", undefined, 1],
  ["required-refusal", { maintenanceRefusal: { reason: "agent-database-in-use" } }, 1],
  ["required-error", { status: "error" }, 1],
] as const)(
  "joins the real stdout Doctor IPC parent and child (%s)",
  async (mode, result, exitCode) => {
    const root = fs.realpathSync(directories.make("doctor-stdout-"));
    const privateTmp = path.join(root, "private-tmp");
    fs.mkdirSync(privateTmp, { mode: 0o700 });
    const { databasePath } = installPrivateUpdateHandoffStore(privateTmp);
    const childGuard = writePrivateUpdateHandoffChildGuard(databasePath, privateTmp);
    const fixture = path.join(root, "doctor.mjs");
    const identity = path.join(root, "writer-pid");
    const stale = path.join(root, "-.processes");
    const staleBytes =
      '{"nonce":"previous-fixture","pid":123,"runId":"previous-interrupted-doctor","slots":[]}';
    fs.writeFileSync(stale, staleBytes);
    fs.writeFileSync(
      fixture,
      `
      import fs from 'node:fs';
      import assert from 'node:assert/strict';
      const mode = ${JSON.stringify(mode)};
      const resultPath = process.env.OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH;
      let custody;
      let withCommandProcessScope, spawnCommand;
      if (['normal','interrupted','unsettled'].includes(mode)) {
        const owner = await import(${JSON.stringify(resolveRuntimeWorkerUrl(updateExecutorNativeEntrypoints.doctorCustody).href)});
        ({withCommandProcessScope,spawnCommand}=await import(${JSON.stringify(resolveRuntimeWorkerUrl(updateExecutorNativeEntrypoints.processSpawn).href)}));
        if (mode === 'normal') {
          process.env.OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH = '-';
          try {
            await assert.rejects(owner.retainUpdateDoctorProcesses(), {
              message: 'Doctor process custody does not match its delegated invocation.',
            });
          } finally { process.env.OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH = resultPath; }
          process.stdout.write('fixture-legacy-refusal\\n');
        }
        custody = await owner.retainUpdateDoctorProcesses();
      } else {
        // Empty native-work inventory, matching the existing published child IPC contract.
        const receipt = JSON.parse(fs.readFileSync(resultPath+'.processes','utf8'));
        receipt.pid = process.pid;
        fs.writeFileSync(resultPath+'.processes',JSON.stringify(receipt));
      }
      const writeResult = (result) => fs.writeFileSync(resultPath, JSON.stringify(result), {flag:'wx', mode:0o600});
      if (mode === 'unsettled') {
        custody.reserve([process.execPath, '-e', 'process.stdin.resume()']);
        writeResult({status:'ok'});
      } else if (mode === 'interrupted') {
        await withCommandProcessScope(async () => {
          const writer = spawnCommand([process.execPath, '-e', 'process.stdin.resume()'], {stdio:['pipe','ignore','ignore']});
          await new Promise((resolve, reject) => { writer.nodeChildProcess.once('spawn',resolve); writer.nodeChildProcess.once('error',reject); });
          fs.writeFileSync(${JSON.stringify(identity)}, String(writer.pid));
          process.stdout.write('fixture-writer-ready\\n');
          await writer;
        }, undefined, custody);
      } else if (mode === 'plain-nonzero') {
        process.exitCode = 7;
      } else if (mode === 'required-refusal') {
        writeResult({status:'ok',maintenanceRefusal:{kind:'deferred',reason:'agent-database-in-use'}});
        process.exitCode = 1;
      } else if (mode === 'required-error') {
        writeResult({status:'error',failureFacts:[{check:'doctor',code:'required-migration',message:'Required migration failed'}]});
        process.exitCode = 1;
      } else {
        writeResult({status:'ok',warnings:['conditional fixture warning']});
        if (mode === 'completed-cleanup') process.exitCode = 1;
      }
      custody?.[Symbol.dispose]();
      `,
    );
    const childEnv = childGuard({ ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") });
    for (const key of ["NODE_OPTIONS", "BUN_OPTIONS", "OPENCLAW_STATE_DIR"]) {
      vi.stubEnv(key, childEnv[key]);
    }
    vi.stubEnv(resultEnv, "-");
    const controller = new AbortController();
    const captured = { stdout: "", stderr: "" };
    for (const stream of ["stdout", "stderr"] as const) {
      vi.spyOn(process[stream], "write").mockImplementation((chunk) => {
        captured[stream] += String(chunk);
        if (mode === "interrupted" && captured.stdout.includes("fixture-writer-ready")) {
          controller.abort();
        }
        // Backpressure must not cancel an owned Doctor process.
        return stream !== "stdout" || mode !== "normal";
      });
    }
    vi.spyOn(process, "cwd").mockReturnValue(root);
    const argv = [process.execPath, fixture, "doctor", "--fix", "--non-interactive"];
    await withCommandProcessScope(() => tryRunDoctorResultBridge(argv), controller.signal).catch(
      (error: unknown) => {
        if (mode === "unsettled") {
          expect(error).toMatchObject({ code: "ERR_COMMAND_PROCESS_CLEANUP_UNCERTAIN" });
        } else if (mode !== "interrupted") {
          throw error;
        }
      },
    );
    const { stdout: output, stderr } = captured;
    const line = output.split("\n").findLast((item) => item.startsWith(`${resultEnv}=`));
    expect(fs.readFileSync(stale, "utf8")).toBe(staleBytes);
    expect(
      fs.readdirSync(privateTmp).filter((name) => name.endsWith(".json.processes")),
    ).toHaveLength(mode === "unsettled" ? 1 : 0);
    if (exitCode !== undefined) {
      expect(process.exitCode).toBe(exitCode);
    }
    if (!result) {
      expect(line, output).toBeUndefined();
      if (mode === "interrupted") {
        expect(isChildProcessTreeAlive({ pid: Number(fs.readFileSync(identity, "utf8")) })).toBe(
          false,
        );
      }
      return;
    }
    expect(JSON.parse(line!.slice(resultEnv.length + 1)), stderr).toMatchObject(result);
    if (mode === "normal") {
      expect(output).toContain("fixture-legacy-refusal");
    }
  },
);
