import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UpdateCommandOptions } from "../cli/update-cli/shared.js";
import { withUpdateCommandExecutor } from "../cli/update-cli/update-command-executor.js";
import * as tempRoot from "../infra/tmp-openclaw-dir.js";
import { isChildProcessTreeAlive } from "../process/child-process-tree.js";
import type { SpawnResult } from "../process/exec-result.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { waitForPidToExit } from "../test-utils/process-tree.js";
import { runDoctorUpdateChild } from "./doctor-update.executor.test-support.js";

const exec = await vi.importActual<typeof import("../process/exec.js")>("../process/exec.js");
const runActual = exec.runUtf8CommandWithTimeout;
afterEach(() => vi.restoreAllMocks());

describe.skipIf(process.platform === "win32")("Doctor child process settlement", () => {
  it.each(["normal", "cooperative", "forced", "failed", "signal", "uncertain"] as const)(
    "preserves the real root outcome and descendant extinction: %s",
    async (scenario) =>
      withTestDir({ prefix: "doctor-child-settlement-" }, async (root) => {
        const control = path.join(root, "leases");
        fs.mkdirSync(control, { mode: 0o700 });
        vi.spyOn(tempRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
        const run: NonNullable<UpdateCommandOptions["run"]> = {
          runId: randomUUID(),
          env: { OPENCLAW_STATE_DIR: path.join(root, "state") },
        };
        const ready = path.join(root, "descendant-pid");
        const stopped = path.join(root, "descendant-stopped");
        let observed: SpawnResult | undefined;
        vi.spyOn(exec, "runUtf8CommandWithTimeout").mockImplementation(async (...args) => {
          observed = await runActual(...args);
          // An uncertain transport receipt must never be upgraded by a successful root exit.
          return scenario === "uncertain" ? { ...observed, cleanup: "uncertain" } : observed;
        });
        const descendant = `
          const fs=require("node:fs");
          process.on("SIGTERM",()=>{${scenario === "cooperative" ? 'fs.writeFileSync(process.argv[2],"stopped");process.exit(0);' : ""}});
          fs.writeFileSync(process.argv[1],String(process.pid));
          setInterval(()=>{},1000);
        `;
        const body =
          scenario === "cooperative" || scenario === "forced"
            ? `const {spawn}=await import("node:child_process");
               const child=spawn(process.execPath,["-e",payload.descendant,payload.ready,payload.stopped],{stdio:"ignore",env:{}});
               child.unref();
               while(!fs.existsSync(payload.ready) || fs.readFileSync(payload.ready,"utf8")!==String(child.pid)) await setTimeout(10);
               fence.assertCurrent();`
            : scenario === "failed"
              ? 'process.stderr.write("fixture child failure");process.exitCode=7;'
              : scenario === "signal"
                ? 'process.kill(process.pid,"SIGTERM");'
                : 'fence.assertCurrent();process.stdout.write("complete");';
        const operation = withUpdateCommandExecutor(run.runId, async (executor) => {
          run.executorFence = await executor.enter(root);
          return await runDoctorUpdateChild(run, body, { descendant, ready, stopped });
        });
        const outcome = await operation.then(
          (result) => ({ result }),
          (error: unknown) => ({ error }),
        );
        expect(observed?.pid).toEqual(expect.any(Number));
        expect(await waitForPidToExit(observed!.pid!)).toBe(true);
        expect(isChildProcessTreeAlive({ pid: observed!.pid! })).toBe(false);
        if (scenario === "cooperative" || scenario === "forced") {
          const pid = Number(fs.readFileSync(ready, "utf8"));
          expect(pid).toBeGreaterThan(0);
          expect(await waitForPidToExit(pid)).toBe(true);
          expect(observed).toMatchObject({ code: 0, termination: "exit", cleanup: scenario });
          expect(fs.existsSync(stopped)).toBe(scenario === "cooperative");
        }
        if (scenario === "normal" || scenario === "cooperative") {
          expect(outcome, JSON.stringify(observed)).toMatchObject({
            result: {
              code: 0,
              termination: "exit",
              signal: null,
              killed: false,
              cleanup:
                scenario === "cooperative"
                  ? "cooperative"
                  : expect.stringMatching(/^(normal|cooperative)$/),
            },
          });
        } else {
          expect(outcome).toMatchObject({
            error: {
              result: expect.objectContaining(
                scenario === "forced" || scenario === "uncertain"
                  ? { code: 0, cleanup: scenario, termination: "exit" }
                  : scenario === "failed"
                    ? { code: 7, termination: "exit", stderr: "fixture child failure" }
                    : { signal: "SIGTERM", termination: "signal" },
              ),
            },
          });
        }
      }),
  );
});
