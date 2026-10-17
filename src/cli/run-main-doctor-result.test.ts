import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import {
  installPrivateUpdateHandoffStore,
  writePrivateUpdateHandoffChildGuard,
} from "../../test/helpers/private-update-handoff-store.js";
import { withRuntimePreload } from "../../test/helpers/runtime-preload.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { isChildProcessTreeAlive } from "../process/child-process-tree.js";
import { withCommandProcessScope } from "../process/exec-spawn.js";
import { tryRunDoctorResultBridge } from "./run-main-doctor-result.js";

const directories = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.exitCode = undefined;
});

it
  .skipIf(process.platform === "win32")
  .each([
    "normal",
    "interrupted",
    "unsettled",
    "completed-cleanup",
    "plain-nonzero",
    "required-refusal",
    "required-error",
  ])("joins the real stdout Doctor IPC parent and child (%s)", async (mode) => {
  const root = fs.realpathSync(directories.make("doctor-stdout-"));
  const privateTmp = path.join(root, "private-tmp");
  fs.mkdirSync(privateTmp, { mode: 0o700 });
  const { databasePath } = installPrivateUpdateHandoffStore(privateTmp);
  const childGuard = writePrivateUpdateHandoffChildGuard(databasePath, privateTmp);
  const source = path.resolve("src");
  const fixture = path.join(root, "doctor.mjs");
  const identity = path.join(root, "writer-pid");
  const stale = path.join(root, "-.processes");
  const staleBytes =
    '{"nonce":"previous-fixture","pid":123,"runId":"previous-interrupted-doctor","slots":[]}';
  fs.writeFileSync(stale, staleBytes);
  const moduleUrl = (relative: string) => pathToFileURL(path.join(source, relative)).href;
  fs.writeFileSync(
    fixture,
    `
      import fs from 'node:fs';
      const mode = ${JSON.stringify(mode)};
      const resultPath = process.env.OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH;
      let custody;
      let withCommandProcessScope, spawnCommand;
      if (['normal','interrupted','unsettled'].includes(mode)) {
        const owner = await import(${JSON.stringify(moduleUrl("infra/update-doctor-process-custody.ts"))});
        ({withCommandProcessScope,spawnCommand}=await import(${JSON.stringify(moduleUrl("process/exec-spawn.ts"))}));
        if (mode === 'normal') {
          process.env.OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH = '-';
          let refused = false;
          try { await owner.retainUpdateDoctorProcesses(); }
          catch (error) {
            if (error.message !== 'Doctor process custody does not match its delegated invocation.') throw error;
            refused = true;
          } finally { process.env.OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH = resultPath; }
          if (!refused) throw new Error('Legacy stdout custody unexpectedly accepted the stale receipt');
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
      if (${JSON.stringify(mode)} === 'unsettled') {
        custody.reserve([process.execPath, '-e', 'process.stdin.resume()']);
        writeResult({status:'ok'});
      } else if (${JSON.stringify(mode)} === 'interrupted') {
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
  let childEnv = childGuard({ ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") });
  childEnv = withRuntimePreload(childEnv, path.resolve("scripts/tsx.mjs"));
  for (const key of ["NODE_OPTIONS", "BUN_OPTIONS", "OPENCLAW_STATE_DIR"]) {
    vi.stubEnv(key, childEnv[key]);
  }
  vi.stubEnv("OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH", "-");
  const controller = new AbortController();
  let output = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    output += String(chunk);
    if (mode === "interrupted" && output.includes("fixture-writer-ready")) {
      controller.abort();
    }
    // A writable can accept bytes while asking its producer to wait for drain.
    // That backpressure must not cancel the owned Doctor process.
    return mode !== "normal";
  });
  let stderr = "";
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });
  vi.spyOn(process, "cwd").mockReturnValue(root);
  await withCommandProcessScope(
    () =>
      tryRunDoctorResultBridge([process.execPath, fixture, "doctor", "--fix", "--non-interactive"]),
    controller.signal,
  ).catch((error: unknown) => {
    if (mode === "unsettled") {
      expect(error).toMatchObject({ code: "ERR_COMMAND_PROCESS_CLEANUP_UNCERTAIN" });
    } else if (mode !== "interrupted") {
      throw error;
    }
  });
  const line = output
    .split("\n")
    .findLast((item) => item.startsWith("OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH="));
  if (mode === "plain-nonzero" || mode === "interrupted") {
    expect(line, output).toBeUndefined();
    expect(process.exitCode).toBe(1);
    expect(fs.readFileSync(stale, "utf8")).toBe(staleBytes);
    expect(fs.readdirSync(privateTmp).filter((name) => name.endsWith(".json.processes"))).toEqual(
      [],
    );
    if (mode === "interrupted") {
      expect(fs.existsSync(identity), stderr).toBe(true);
      expect(isChildProcessTreeAlive({ pid: Number(fs.readFileSync(identity, "utf8")) })).toBe(
        false,
      );
    }
    return;
  }
  expect(line, output).toBeDefined();
  const result = JSON.parse(line!.slice("OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH=".length));
  expect(fs.readFileSync(stale, "utf8")).toBe(staleBytes);
  const receipts = fs.readdirSync(privateTmp).filter((name) => name.endsWith(".json.processes"));
  if (mode === "normal") {
    expect(output).toContain("fixture-legacy-refusal");
    expect(result, stderr).toMatchObject({
      status: "ok",
      warnings: ["conditional fixture warning"],
    });
    expect(receipts).toEqual([]);
  } else if (mode === "unsettled") {
    expect(result).toMatchObject({
      status: "error",
      failureFacts: [expect.objectContaining({ code: "doctor-processes-unsettled" })],
    });
    expect(receipts).toHaveLength(1);
  } else if (mode === "completed-cleanup") {
    expect(result).toMatchObject({
      status: "ok",
      warnings: expect.arrayContaining([
        "conditional fixture warning",
        expect.stringContaining("every tracked process group stopped"),
      ]),
    });
    expect(process.exitCode).toBe(0);
    expect(receipts).toEqual([]);
  } else if (mode === "required-error") {
    expect(result.status).toBe("error");
    expect(process.exitCode).toBe(1);
    expect(receipts).toEqual([]);
  } else if (mode === "required-refusal") {
    expect(result.maintenanceRefusal).toMatchObject({ reason: "agent-database-in-use" });
    expect(process.exitCode).toBe(1);
    expect(receipts).toEqual([]);
  }
});
