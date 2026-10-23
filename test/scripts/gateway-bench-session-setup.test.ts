import type { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { beforeEach, expect, it, vi } from "vitest";
import { probeGatewayMemorySearch } from "../../scripts/lib/gateway-bench-session-setup.ts";

const mocks = vi.hoisted(() => ({
  resources: vi.fn(),
  stop: vi.fn(),
  run: vi.fn(),
}));
vi.mock("../../scripts/lib/gateway-bench-profile.ts", async (importOriginal) => ({
  ...(await importOriginal()),
  readGatewayResources: mocks.resources,
  startGatewayDiagnostics: async () => mocks.stop,
}));
vi.mock("../../scripts/lib/managed-child-process.mts", () => ({
  runManagedCommand: mocks.run,
}));

const params = {
  gateway: {} as ChildProcess,
  runtime: "node",
  entry: "/fixture/dist/entry.js",
  env: {},
  timeoutMs: 1000,
  onChild: vi.fn(),
};
const statsTask = {
  channel: "openclaw.worker.task",
  operation: "memoryIndex.transcript-stats",
  outcome: "ok",
  count: 1,
};

beforeEach(() => {
  vi.resetAllMocks();
  let sample = 0;
  mocks.resources.mockImplementation(async () => ({
    pid: 123,
    atMonotonicMicros: ++sample * 1000,
    process: { user: 0, system: 0 },
    mainThread: { user: 0, system: 0 },
    workers: {
      workerHeaps: [{ script: "/fixture/manager-index.worker.js", threadId: 8 }],
      workerMemoryMissing: [],
      workerLifecycle: [],
    },
  }));
  mocks.stop.mockResolvedValue({ groups: [statsTask], collectionErrors: 0, droppedEvents: 0 });
  mocks.run.mockImplementation(async ({ onReady }) => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    onReady({ stdout, stderr });
    stdout.end(JSON.stringify({ results: [] }));
    stderr.end();
    return 0;
  });
});

it("accepts an empty search only with successful Gateway stats and a retained index worker", async () => {
  await expect(probeGatewayMemorySearch(params)).resolves.toMatchObject({
    statsTaskCount: 1,
    resultCount: 0,
  });
  expect(mocks.stop).toHaveBeenCalledOnce();
  expect(params.onChild).toHaveBeenCalledOnce();
});

it.each([
  ["local fallback", []],
  ["unrelated worker", [{ ...statsTask, operation: "memorySearch.search" }]],
  ["failed stats", [{ ...statsTask, outcome: "error" }]],
])("rejects successful CLI output backed by %s", async (_name, groups) => {
  mocks.stop.mockResolvedValue({ groups, collectionErrors: 0, droppedEvents: 0 });
  await expect(probeGatewayMemorySearch(params)).rejects.toThrow(
    "did not prove successful Gateway",
  );
});

it("rejects an index worker that retired before its resource sample", async () => {
  mocks.resources.mockResolvedValue({
    workers: { workerHeaps: [], workerMemoryMissing: [], workerLifecycle: [] },
  });
  await expect(probeGatewayMemorySearch(params)).rejects.toThrow("indexing worker is absent");
});

it("stops diagnostic capture when the CLI child fails", async () => {
  const error = new Error("child deadline exceeded");
  mocks.run.mockRejectedValue(error);
  await expect(probeGatewayMemorySearch(params)).rejects.toMatchObject({ errors: [error] });
  expect(mocks.stop).toHaveBeenCalledOnce();
});

it("preserves unsettled CLI cleanup when diagnostics also fail", async () => {
  const commandError = Object.assign(new Error("CLI cleanup failed"), {
    processTreeState: "indeterminate",
  });
  const diagnosticError = new Error("Gateway disconnected");
  mocks.run.mockRejectedValue(commandError);
  mocks.stop.mockRejectedValue(diagnosticError);
  await expect(probeGatewayMemorySearch(params)).rejects.toMatchObject({
    errors: [commandError, diagnosticError],
  });
});

it.each(["replacement", "retirement"])(
  "rejects index worker %s during activation",
  async (kind) => {
    let sample = 0;
    mocks.resources.mockImplementation(async () => ({
      workers: {
        workerHeaps: [
          { script: "manager-index.worker.js", threadId: kind === "replacement" ? ++sample : 8 },
        ],
        workerMemoryMissing: [],
        workerLifecycle: [
          {
            script: "manager-index.worker.js",
            retired: [{ reason: "idle", count: kind === "retirement" ? ++sample : 0 }],
          },
        ],
      },
    }));
    await expect(probeGatewayMemorySearch(params)).rejects.toThrow("retired or changed");
  },
);
