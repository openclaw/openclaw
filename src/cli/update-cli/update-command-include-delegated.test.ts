import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../infra/runtime-worker-url.js";
import * as tempRoot from "../../infra/tmp-openclaw-dir.js";
import { runUtf8CommandWithTimeout } from "../../process/exec.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { updateExecutorNativeEntrypoints } from "./update-command-executor-native-runtime.test-support.js";
import {
  withUpdateCommandExecutor,
  withUpdateCommandExecutorChild,
} from "./update-command-executor.js";

afterEach(() => vi.restoreAllMocks());
const receiverUrl = resolveRuntimeWorkerUrl(updateExecutorNativeEntrypoints.includeDelegated);

it.for(["healthy", "original-owner-replaced", "include-parent-replaced"] as const)(
  "delegated candidate include effect retains original owner and directory: %s",
  async (fault, { onTestFailed }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const control = state.path("control");
      const root = state.path("install");
      fs.mkdirSync(control);
      fs.mkdirSync(root);
      vi.spyOn(tempRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
      await state.writeConfig({
        plugins: { enabled: false },
        update: { $include: "./fragments/channel.json" },
      });
      const fragmentDir = state.statePath("fragments");
      fs.mkdirSync(fragmentDir);
      const fragment = path.join(fragmentDir, "channel.json");
      const original = '{"channel":"stable"}\n';
      fs.writeFileSync(fragment, original);
      const rootRaw = fs.readFileSync(state.configPath, "utf8");
      const proceed = state.path("proceed");
      const ready = createDeferred<{
        pid: number;
        parentPid: number;
        parentOwner: string;
        candidate: string;
      }>();
      let stdout = "";
      const runId = randomUUID();
      let boundPid: number | undefined;
      const startedAt = performance.now();
      const timingsMs: Record<string, number> = { admissionStarted: 0 };
      const mark = (phase: string) => {
        timingsMs[phase] ??= performance.now() - startedAt;
      };
      let commandResult: Awaited<ReturnType<typeof runUtf8CommandWithTimeout>> | undefined;
      let commandError: unknown;
      let outcome:
        | { value: Awaited<ReturnType<typeof runUtf8CommandWithTimeout>> }
        | { error: unknown }
        | undefined = undefined;
      onTestFailed(() => {
        console.error(
          JSON.stringify({
            fault,
            boundPid,
            parentPid: process.pid,
            candidate: receiverUrl.href,
            timingsMs,
            command: commandResult
              ? {
                  code: commandResult.code,
                  signal: commandResult.signal,
                  termination: commandResult.termination,
                  timedOut:
                    commandResult.termination === "timeout" ||
                    commandResult.termination === "no-output-timeout",
                  killed: commandResult.killed,
                  cleanup: commandResult.cleanup,
                  stderr: commandResult.stderr,
                }
              : undefined,
            commandError: commandError === undefined ? undefined : formatErrorMessage(commandError),
            error:
              outcome !== undefined && "error" in outcome
                ? formatErrorMessage(outcome.error)
                : undefined,
            stdout,
          }),
        );
      });
      const work = withUpdateCommandExecutor(runId, async (owner) => {
        const fence = await owner.enter(root);
        mark("executorAdmitted");
        const pending = withUpdateCommandExecutorChild(fence, root, async (grant, bindChild) => {
          mark("childLaunchRequested");
          try {
            const result = await runUtf8CommandWithTimeout(
              [process.execPath, ...resolveRuntimeWorkerArgv(receiverUrl)],
              {
                input: JSON.stringify({ grant, proceed }),
                env: state.env,
                beforeInput: (pid) => {
                  mark("childSpawnObserved");
                  boundPid = pid;
                  bindChild(pid);
                  mark("childBound");
                },
                timeoutMs: 30_000,
                killProcessTree: true,
                requireProcessTreeExtinction: true,
                onOutputChunk: (chunk) => {
                  stdout += String(chunk);
                  const lines = stdout.split("\n");
                  const line = lines.find((value) => value.startsWith('{"ready":true'));
                  if (line) {
                    const binding = JSON.parse(line);
                    mark("readyReceived");
                    ready.resolve(binding);
                  }
                  if (
                    lines.slice(0, -1).some((value) => value.startsWith('{"result":"published"'))
                  ) {
                    mark("writeReturned");
                  }
                },
              },
            );
            commandResult = result;
            mark("commandReturned");
            return result;
          } catch (error) {
            commandError = error;
            mark("commandRejected");
            throw error;
          }
        });
        try {
          const binding = await Promise.race([
            ready.promise,
            pending.then((result) => {
              throw new Error(result.stderr || stdout || "child exited before include preparation");
            }),
          ]);
          expect(binding.pid).toBe(boundPid);
          expect(binding.pid).not.toBe(process.pid);
          expect(binding.parentPid).toBe(process.pid);
          expect(binding.candidate).toBe(receiverUrl.href);
          expect(binding.parentOwner.length).toBeGreaterThan(0);
          if (fault === "original-owner-replaced") {
            const db = new DatabaseSync(path.join(control, "managed-update-handoffs.sqlite"));
            try {
              db.prepare("UPDATE managed_update_handoffs SET owner=? WHERE install_root=?").run(
                "replacement",
                root,
              );
            } finally {
              db.close();
            }
          }
          if (fault === "include-parent-replaced") {
            fs.renameSync(fragmentDir, `${fragmentDir}-old`);
            fs.mkdirSync(fragmentDir);
            fs.writeFileSync(fragment, original);
          }
        } finally {
          mark("releaseStarted");
          fs.writeFileSync(proceed, "go");
          mark("released");
        }
        return await pending;
      });
      outcome = await work.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      mark("completed");
      if (fault === "healthy") {
        expect("value" in outcome && outcome.value.code === 0, stdout).toBe(true);
        expect(JSON.parse(fs.readFileSync(fragment, "utf8")).channel).toBe("beta");
        expect(fs.readFileSync(`${fragment}.bak`, "utf8")).toBe(original);
      } else {
        expect(stdout).toContain('"result":"refused"');
        expect(fs.readFileSync(fragment, "utf8")).toBe(original);
        expect(fs.existsSync(`${fragment}.bak`)).toBe(false);
        if (fault === "include-parent-replaced") {
          expect(fs.readFileSync(path.join(`${fragmentDir}-old`, "channel.json"), "utf8")).toBe(
            original,
          );
        }
      }
      expect(fs.readFileSync(state.configPath, "utf8")).toBe(rootRaw);
    });
  },
);
