import { beforeEach, expect, test, vi } from "vitest";

const { execFile } = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFile,
}));
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  platform: () => "darwin",
}));

import {
  collectGatewayProcessDiagnostics,
  summarizeGatewayLanes,
  summarizeGatewayLogs,
  summarizeIOSBuildTiming,
} from "../../scripts/lib/ios-release-e2e-diagnostics.js";

beforeEach(() => {
  execFile.mockReset();
});

test("retains build task timings without exporting script names or raw build output", () => {
  expect(
    summarizeIOSBuildTiming(`
PRIVATE-TOKEN /private/source/path
Build Timing Summary
SwiftCompile (280 tasks) | 123.45 seconds
PhaseScriptExecution (1 task) | 0.007 seconds
PRIVATE-TOKEN (1 task) | 99 seconds
CodeSign (2 tasks) | 0.12 seconds
`),
  ).toEqual([
    { task: "SwiftCompile", tasks: 280, seconds: 123.45 },
    { task: "PhaseScriptExecution", tasks: 1, seconds: 0.007 },
    { task: "CodeSign", tasks: 2, seconds: 0.12 },
  ]);
});

test("projects only numeric worker and lane totals", () => {
  expect(
    summarizeGatewayLanes({
      workerCount: 5,
      workerPoolCount: 2,
      workerPools: [{ workerCount: 2, script: "/private/credentials" }, { workerCount: 1 }],
      lanes: [
        { lane: "secret-token", activeCount: 1, queuedCount: 2, maxConcurrent: 3, draining: true },
        { activeCount: 4, queuedCount: 5, maxConcurrent: 6, draining: false },
      ],
      dynamic: {
        laneCount: 2,
        activeCount: 1,
        queuedCount: 3,
        queuedLaneCount: 1,
        token: "secret-token",
      },
    }),
  ).toEqual({
    outcome: "captured",
    workerCount: 5,
    workerPoolCount: 2,
    pooledWorkerCount: 3,
    activeCount: 5,
    queuedCount: 7,
    maxConcurrent: 9,
    drainingLaneCount: 1,
    dynamic: { laneCount: 2, activeCount: 1, queuedCount: 3, queuedLaneCount: 1 },
  });
  expect(summarizeGatewayLanes(undefined)).toEqual({ outcome: "unavailable" });
});

test("exports only known Gateway events, numeric timing, and cleanup flags", () => {
  const events = summarizeGatewayLogs(`
18:01:02 [ws] ← req device.pair.setupCode conn=secret-token
18:01:03 [ws] → res ✓ device.pair.setupCode 7123ms bytes=secret-token
18:01:04 [ws] ⇄ res ✓ device.pair.setupStatus 2ms id=secret-token
SQLite worker admission delayed {"queueDepth":3,"waitMs":1000,"token":"secret-token"}
memory pressure: level=critical reason=rss_threshold secret-token
liveness heartbeat delayed: overdue=1200ms elapsed=6200ms; secret-token
service child cleanup identity lost: private-path secret-token
service child cleanup did not complete before its hard deadline; pending: {"closingReceipt":true,"stdoutEnd":false,"token":"secret-token"}
arbitrary secret-token and /private/home/credentials
`);
  expect(events).toEqual([
    { event: "setup-code-received" },
    { event: "setup-code-responded", durationMs: 7123 },
    { event: "setup-status-responded", durationMs: 2 },
    { event: "sqlite-worker-admission-delayed", queueDepth: 3, waitMs: 1000 },
    { event: "memory-critical" },
    { event: "liveness-heartbeat-delayed", overdueMs: 1200, elapsedMs: 6200 },
    { event: "process-cleanup-identity-lost" },
    { event: "process-cleanup-deadline", pending: { closingReceipt: true, stdoutEnd: false } },
  ]);
  expect(summarizeGatewayLogs("req device.pair.setupCode\n".repeat(100))).toHaveLength(32);
});

test("projects process and sample output without exporting paths or credentials", async () => {
  execFile.mockImplementation((command, _args, _options, callback) => {
    callback(
      null,
      command === "/bin/ps"
        ? " 12.3 2048 S+\n"
        : `Process: node secret-token /private/credentials
Call graph:
    + 80 sqlite3_step (in libsqlite3.dylib)
    + 70 __psynch_cvwait (in libsystem_kernel.dylib)
    + 50 v8::internal::Compile (in node)
    + 40 uv__io_poll (in node)
    + 30 pread (in libsystem_kernel.dylib)
    + 20 node::SpinEventLoop (in node)
    + 10 secret-token (in /private/credentials)
Binary Images: secret-token`,
    );
  });
  const result = await collectGatewayProcessDiagnostics(123, { sample: true });
  expect(result.process).toEqual({
    outcome: "captured",
    cpuPercent: 12.3,
    rssBytes: 2097152,
    state: "S",
  });
  expect(result.sample).toEqual({
    outcome: "captured",
    frameCount: 7,
    frameCounts: { sqlite: 1, filesystem: 1, locks: 1, poll: 1, v8: 1, node: 1, other: 1 },
  });
  expect(result.host.totalMemoryBytes).toBeGreaterThan(0);
  expect(JSON.stringify(result)).not.toMatch(/secret-token|\/private\//u);
});

test("unavailable observations remain bounded diagnostic outcomes without raw errors", async () => {
  execFile.mockImplementation((_command, _args, _options, callback) => {
    callback(new Error("secret-token /private/credentials"), "private output");
  });
  const result = await collectGatewayProcessDiagnostics(123, { sample: true });
  expect(result.process).toEqual({ outcome: "unavailable" });
  expect(result.sample).toEqual({ outcome: "unavailable" });
  expect(JSON.stringify(result)).not.toMatch(/secret-token|private/u);
  execFile.mockClear();
  expect((await collectGatewayProcessDiagnostics(undefined)).process).toEqual({
    outcome: "unavailable",
  });
  expect(execFile).not.toHaveBeenCalled();
});
