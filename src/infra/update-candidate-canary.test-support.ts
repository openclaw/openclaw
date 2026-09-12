import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { vi } from "vitest";

export class FakeChild extends EventEmitter {
  pid: number;
  stdout = new PassThrough();
  stderr = new PassThrough();
  constructor(pid: number) {
    super();
    this.pid = pid;
  }
}

export function createCanarySnapshotResult(input: string, databasePath?: string) {
  const request: unknown = JSON.parse(input);
  return {
    code: 0,
    stdout: Buffer.from(
      JSON.stringify(
        isRecord(request) && request.mode === "inventory"
          ? {
              databases: databasePath ? [[databasePath, { spellings: [databasePath] }]] : [],
              pluginBytes: 0,
              pluginPlan: "plugin-copy-plan.json",
            }
          : { versions: [], pluginPaths: {} },
      ),
    ),
    stderr: Buffer.alloc(0),
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
