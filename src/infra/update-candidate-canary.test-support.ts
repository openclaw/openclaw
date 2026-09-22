import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { onTestFinished, vi } from "vitest";
import { createUpdateProgress } from "../cli/update-cli/progress.js";
import type { SpawnResult } from "../process/exec.js";
import { defaultRuntime } from "../runtime.js";
import type { UpdateStepResult } from "./update-runner-types.js";

export class FakeChild extends EventEmitter {
  pid: number;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  killed = false;
  stdout = new PassThrough();
  stderr = new PassThrough();
  constructor(pid: number) {
    super();
    this.pid = pid;
    this.once("close", (code: number | null, signal?: NodeJS.Signals | null) => {
      this.exitCode = code;
      this.signalCode = signal ?? null;
    });
  }
}

export function createCanarySnapshotResult(input: string, databasePath?: string): SpawnResult {
  const request: unknown = JSON.parse(input);
  return {
    code: 0,
    stdout: JSON.stringify(
      isRecord(request) && request.mode === "inventory"
        ? {
            databases: databasePath ? [[databasePath, { spellings: [databasePath] }]] : [],
            pluginBytes: 0,
            pluginPlan: "plugin-copy-plan.json",
          }
        : { versions: [], pluginPaths: {} },
    ),
    stderr: "",
    signal: null,
    killed: false,
    cleanup: "normal",
    termination: "exit",
  };
}

type CanaryCommandFixture = {
  pluginInventory: unknown;
  pluginErrors: boolean;
  runtimeContract: unknown;
  runtimeError: boolean;
  lintReport: { ok: boolean; checksRun: number; findings: unknown[]; warnings: unknown[] };
};

export function completeCanaryCommand(
  child: FakeChild,
  args: string[],
  readFixture: () => CanaryCommandFixture,
) {
  queueMicrotask(() => {
    const { pluginInventory, pluginErrors, runtimeContract, runtimeError, lintReport } =
      readFixture();
    if (args.includes("plugins")) {
      child.stdout.write(
        JSON.stringify(
          pluginInventory ?? {
            plugins: [],
            diagnostics: pluginErrors ? [{ level: "error", message: "incompatible plugin" }] : [],
          },
        ),
      );
    }
    if (args.includes("--check")) {
      child.stdout.write(JSON.stringify(runtimeContract));
    }
    if (args.includes("--lint")) {
      child.stdout.write(JSON.stringify(lintReport));
    }
    child.emit(
      "close",
      (runtimeError && args.includes("--check")) || (!lintReport.ok && args.includes("--lint"))
        ? 1
        : 0,
    );
  });
}

export function stubHealthyGateway() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ status: "started", ready: true })),
  );
}

export function renderSteps(steps: UpdateStepResult[]) {
  const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
  const presentation = createUpdateProgress(true);
  onTestFinished(() => {
    presentation.dispose();
    log.mockRestore();
  });
  for (const [index, step] of steps.entries()) {
    presentation.progress.onStepComplete?.({ ...step, index, total: steps.length });
  }
  return log.mock.calls.flat().join("\n");
}
