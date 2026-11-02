import { execFileSync } from "node:child_process";
import { once } from "node:events";
import {
  appendFile,
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  type DesktopProofSourceStatus,
  desktopProofAssets,
  desktopProofCommit,
  desktopProofSource,
  desktopProofSshdFailure,
  desktopProofTestReport,
  desktopResizeStages,
  exportDesktopResizeProof,
  inspectDesktopSshdRuntimeDirectory,
  readDesktopProofGatewayCloses,
  readDesktopProofPhase,
  readDesktopProofSource,
  readDesktopProofNodeStreamCloses,
  readDesktopProofTestReport,
  sanitizeDesktopResizeProof,
  withDesktopProofCleanup,
} from "../../scripts/lib/desktop-resize-proof.mts";
import { hasUnjoinedWork } from "../../scripts/lib/managed-child-process.mts";
import { acquireTestPortBlock } from "../../src/test-utils/port-claims.js";
import type { DesktopClient } from "../../ui/src/components/desktop/desktop-client.ts";
import {
  observeDesktopEndpointPackets,
  observeDesktopProofRfbLifecycle,
} from "../../ui/src/e2e/desktop-resize-real.test-support.ts";
import { runQaGatewayFixture } from "../helpers/qa-gateway-cleanup.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, lstat: vi.fn(actual.lstat), open: vi.fn(actual.open) };
});

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.unstubAllGlobals());
const head = "a".repeat(40);
const base = "b".repeat(40);
const merge = "c".repeat(40);
const tree = "d".repeat(40);
const size = { width: 1200, height: 850 };
const assets = {
  "index-fixture.js": "e".repeat(64),
  "desktop-panel-fixture.js": "f".repeat(64),
  "novnc-fixture.js": "a".repeat(64),
};
const writeJson = (file: string, value: unknown) => writeFile(file, JSON.stringify(value));
const fixtureFile = (prefix: string, name: string) => path.join(dirs.make(prefix), name);
const repeat = <T>(value: T, length: number) => Array.from({ length }, () => value);
const events = <T>(values: T[], omitted = 0) => ({ events: values, omitted });
const expectRedacted = (value: unknown, forbidden: RegExp) =>
  expect(JSON.stringify(value)).not.toMatch(forbidden);
const reportAssertion = (report: ReturnType<typeof desktopProofTestReport>) =>
  report.files[0]?.assertions[0];
const projectViewer = (value: unknown) =>
  reportAssertion(
    desktopProofTestReport(rawTestReport(undefined, { desktopViewerResizeFailure: value })),
  )?.viewerResize;
const gitFixture = (cwd: string) => (args: string[], input?: string) =>
  execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
    cwd,
    input,
    timeout: 10_000,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test Author",
      GIT_AUTHOR_EMAIL: "author@example.invalid",
      GIT_COMMITTER_NAME: "Test Committer",
      GIT_COMMITTER_EMAIL: "committer@example.invalid",
      GIT_NO_LAZY_FETCH: "1",
      GIT_NO_REPLACE_OBJECTS: "1",
    },
  });
const phaseResult = (status: string, lastObservedPhase: string | null = null) => ({
  status,
  lastObservedPhase,
  owners: null,
});
async function exportFixture() {
  const root = dirs.make("desktop-export-");
  const input = path.join(root, "input");
  const output = path.join(root, "public");
  await mkdir(input);
  return { root, input, output };
}
function sourceReader(run: (args: string[]) => Buffer, checkout = head) {
  const receipt = { phase: "preflight", sourceStatus: null as DesktopProofSourceStatus | null };
  return {
    receipt,
    read: () =>
      readDesktopProofSource(
        async (label, args) => {
          receipt.phase = label;
          return run(args);
        },
        { checkout },
        (value) => {
          receipt.sourceStatus = value;
        },
      ),
  };
}
function sourceAdmissionFixture(status: string, tracked: string[]) {
  const replies: Record<string, string> = {
    "rev-parse": `${head}\n`,
    "cat-file": `tree ${tree}\nparent ${base}\n\nfixture\n`,
    "ls-tree": `${tracked.join("\0")}\0`,
    status,
  };
  return {
    replies,
    ...sourceReader((args) => {
      const reply = replies[args[0]!];
      if (reply === undefined) {
        throw new Error("Git command failed with private details");
      }
      return Buffer.from(reply);
    }),
  };
}
const rawTestReport = (
  message = "AssertionError: private-token",
  metadata: Record<string, unknown> = {},
) => ({
  success: true,
  numTotalTests: 1,
  numFailedTests: 1,
  numFailedTestSuites: 1,
  snapshot: { private: "secret" },
  testResults: [
    {
      name: "/private/workspace/ui/src/e2e/desktop-resize.real-gateway.e2e.test.ts",
      status: "failed",
      message: "",
      assertionResults: [
        {
          title: "private-title",
          fullName: "private-title",
          status: "failed",
          location: { line: 120, column: 3 },
          meta: { desktopProofPhase: "node-admission", password: "private-token", ...metadata },
          failureMessages: [message],
        },
      ],
    },
  ],
});
const viewerFailure = {
  expected: size,
  lastFramebuffer: { width: 900, height: 500 },
  snapshotStatus: "available",
  pageClosed: false,
  canvasCount: 1,
  snapshotFramebuffer: { width: 900, height: 500 },
  socketCount: 2,
  latestReadyState: 1,
  socketCloses: [{ socketIndex: 0, code: 4000, wasClean: true, category: "takeover" }],
  nodeStreamCloses: [{ trigger: "target-close", closeCode: 1005 }],
};
const proof = (carrier: "node" | "ssh" = "node") => ({
  carrier,
  gateway: { execution: "built-process", readiness: "readyz", minimal: false },
  node:
    carrier === "node"
      ? {
          deviceId: "private-node-id",
          passwordAbsentFromObserve: true,
          disconnectClosedViewer: true,
        }
      : null,
  observer: {
    evidence: "endpoint-marker-brackets",
    keyboardForwardedBytes: 0,
    resizeForwardedBytes: 0,
  },
  assets,
  samples: desktopResizeStages.map((stage) => ({ stage, ...size })),
  pixels: { distinctSampledColors: 100 },
  provenance: { privatePath: "/private/fixture" },
  hello: { token: "private-token" },
});

it("binds real-client callbacks to the exact socket and preserves recovery callbacks after factory restoration", async () => {
  type Options = Parameters<DesktopClient["connect"]>[0];
  const sockets: Array<{ url: string }> = [];
  const browser = {
    desktopProofSockets: sockets,
    location: { href: "https://fixture.invalid/" },
  };
  vi.stubGlobal("window", browser);
  let observed: Options | undefined;
  const result = Promise.resolve({} as Awaited<ReturnType<DesktopClient["connect"]>>);
  const client = {
    connect: vi.fn(function (this: unknown, options: Options) {
      expect(this).toBe(client);
      observed = options;
      return result;
    }),
  };
  const factory = vi.fn(function (this: unknown) {
    expect(this).toBe(panel);
    return client;
  });
  const panel = { desktopClientFactory: factory };
  observeDesktopProofRfbLifecycle(panel as unknown as Element);
  const snapshot = () =>
    Reflect.get(browser, "desktopProofRfbLifecycle")() as {
      events: Array<{
        socketIndex: number | null;
        phase: string;
        connectedObserved: boolean;
      }>;
      omitted: number;
    };
  const detail = { clean: false, reason: "private-reason" };
  const callbacks: string[] = [];
  const options: Options = {
    target: {} as HTMLElement,
    viewOnly: true,
    isCurrent: () => true,
    wsUrl: "/desktop/observe?token=private-token",
    gatewayUrl: "wss://fixture.invalid/base",
    onConnect() {
      expect(this).toBe(options);
      callbacks.push("connected");
      expect(snapshot().events.at(-1)?.phase).toBe("connected");
    },
    onDisconnect(value) {
      expect(this).toBe(options);
      expect(value).toBe(detail);
      callbacks.push("disconnected");
    },
    onSecurityFailure(value) {
      expect(this).toBe(options);
      expect(value).toEqual({ status: 2, reason: "private-reason" });
      callbacks.push("security");
    },
  };
  expect(panel.desktopClientFactory().connect(options)).toBe(result);
  expect(panel.desktopClientFactory).toBe(factory);
  expect(snapshot().events[0]?.socketIndex).toBeNull();
  sockets.push({ url: "wss://fixture.invalid/desktop/observe?token=earlier" });
  sockets.push({ url: "wss://fixture.invalid/desktop/observe?token=private-token" });
  sockets.push({ url: "wss://fixture.invalid/desktop/observe?token=later" });
  observed!.onConnect!();
  observed!.onSecurityFailure!({ status: 2, reason: "private-reason" });
  observed!.onDisconnect!(detail);
  expect(callbacks).toEqual(["connected", "security", "disconnected"]);
  expect(
    snapshot().events.map((event) => [event.socketIndex, event.phase, event.connectedObserved]),
  ).toEqual([
    [1, "connecting", false],
    [1, "connected", true],
    [1, "security-failure", true],
    [1, "disconnected", true],
  ]);
  expectRedacted(snapshot(), /private|token|reason|url|fixture/u);
  sockets.push(sockets[1]!);
  expect(snapshot().events.every((event) => event.socketIndex === null)).toBe(true);
  await result;
});

it.each(["upstream", "client", "fixture"] as const)(
  "records the tap's first %s terminal event before cascading close",
  async (side) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("missing fixture address");
    }
    const tap = await observeDesktopEndpointPackets(address.port, new AbortController().signal);
    const accepted = once(server, "connection");
    const client = net.connect({ host: "127.0.0.1", port: tap.port });
    const [upstream] = (await accepted) as [net.Socket];
    try {
      expect(tap.terminalSnapshot()).toEqual({ events: [], omitted: 0 });
      if (side === "fixture") {
        await tap.close();
      } else {
        (side === "upstream" ? upstream : client).end();
      }
      await vi.waitFor(() => expect(tap.terminalSnapshot().events).toHaveLength(1));
      expect(tap.terminalSnapshot().events[0]).toMatchObject({
        connectionIndex: 0,
        side,
        event: side === "fixture" ? "cleanup" : "end",
      });
      await tap.close();
      expect(tap.terminalSnapshot().events).toHaveLength(1);
    } finally {
      client.destroy();
      upstream.destroy();
      await tap.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  },
);

it("projects bounded gateway owner facts and never publishes raw identity or stderr", async () => {
  const file = fixtureFile("desktop-gateway-log-", "gateway.log");
  const record = (message: string, metadata: unknown) =>
    JSON.stringify({ "0": '{"subsystem":"gateway/desktop"}', "1": metadata, "2": message });
  const lines = repeat(
    record("desktop observer closed", {
      trigger: "stream-close",
      cleanupCode: 1000,
      closeCode: 1000,
      sourceKey: "private-worker",
      streamId: "private-stream",
      ownerEpoch: 3,
    }),
    10,
  );
  lines.push(
    record("desktop SSH tunnel exited", {
      code: null,
      signal: "SIGTERM",
      stopRequested: true,
      stderr: "private-error",
    }),
  );
  await writeFile(file, lines.join("\n"));
  const value = await readDesktopProofGatewayCloses(file);
  expect(value?.observerCloses?.events).toHaveLength(8);
  expect(value?.observerCloses?.omitted).toBe(2);
  expect(value?.sshTunnelExits).toEqual(
    events([{ code: null, signal: "SIGTERM", stopRequested: true }]),
  );
  expectRedacted(value, /private|sourceKey|streamId|ownerEpoch|stderr/u);
  expect(await readDesktopProofGatewayCloses(file + ".missing")).toBeNull();
});

it("keeps the tap off a port claimed before its listener binds", async () => {
  const upstream = await acquireTestPortBlock({ offsets: [0] });
  const createServer = net.createServer;
  // Model the kernel choosing another fixture's claimed but unbound port.
  const createServerSpy = vi.spyOn(net, "createServer").mockImplementation((...args) => {
    const server = createServer(...args);
    const listen = server.listen.bind(server);
    server.listen = (...listenArgs) => {
      if (listenArgs[0] === 0) {
        listenArgs[0] = upstream.port;
      }
      return Reflect.apply(listen, server, listenArgs);
    };
    return server;
  });
  let closeTap: (() => Promise<void>) | undefined;
  await runQaGatewayFixture(
    async () => {
      const tap = await observeDesktopEndpointPackets(upstream.port, new AbortController().signal);
      closeTap = tap.close;
      expect(tap.port).not.toBe(upstream.port);
    },
    () => createServerSpy.mockRestore(),
    () => closeTap?.(),
    () => upstream.release(),
  );
});

it("projects SSH, tap and RFB diagnostics with closed fields and explicit omitted counts", () => {
  const endpoint = {
    connectionIndex: 2,
    side: "upstream",
    event: "error",
    errorCategory: "reset",
    hadError: null,
  };
  const rfb = {
    ordinal: 4,
    socketIndex: 2,
    phase: "disconnected",
    connectedObserved: false,
    clean: false,
    securityStatus: null,
  };
  const diagnostic = {
    ...viewerFailure,
    endpointCloses: events([{ ...endpoint, address: "private-host" }], 3),
    rfbLifecycle: events([{ ...rfb, url: "https://private.invalid/token" }], 1),
    gatewayCloses: {
      observerCloses: events([]),
      sshTunnelExits: events([]),
    },
  };
  expect(projectViewer(diagnostic)).toMatchObject({
    endpointCloses: events([endpoint], 3),
    rfbLifecycle: events([rfb], 1),
  });
  expectRedacted(projectViewer(diagnostic), /private|token|address|url/u);
  for (const override of [
    { endpointCloses: events(repeat(endpoint, 9)) },
    { endpointCloses: events([{ ...endpoint, side: "private-host" }]) },
    { rfbLifecycle: events([rfb], -1) },
    { rfbLifecycle: events([{ ...rfb, socketIndex: -1 }]) },
    { rfbLifecycle: events([{ ...rfb, phase: "private-error" }]) },
    {
      gatewayCloses: {
        observerCloses: events([{ trigger: "private-error", cleanupCode: 1000, closeCode: 1000 }]),
        sshTunnelExits: null,
      },
    },
  ]) {
    expect(() => projectViewer({ ...diagnostic, ...override })).toThrow();
  }
  const absent = { endpointCloses: null, rfbLifecycle: null, gatewayCloses: null };
  expect(projectViewer({ ...viewerFailure, ...absent })).toMatchObject(absent);
});

it("retains the last eight node closes from a 1 MiB structured log", async () => {
  const file = fixtureFile("desktop-node-log-", "node.log");
  const record = (streamKind: string, closeCode: number) =>
    JSON.stringify({
      "0": '{"subsystem":"node-host/stream"}',
      "1": { streamKind, trigger: "target-close", closeCode, privateDetail: "private-node-data" },
      "2": "node stream closed",
    });
  await writeFile(
    file,
    [
      record("portal", 1000),
      ...Array.from({ length: 10 }, (_, index) => record("desktop", 1000 + index)),
    ].join("\n"),
  );
  await appendFile(file, Buffer.alloc(1024 * 1024 - (await stat(file)).size, 32));
  const closes = await readDesktopProofNodeStreamCloses(file);
  expect(closes).toEqual(
    Array.from({ length: 8 }, (_, index) => ({
      trigger: "target-close",
      closeCode: 1002 + index,
    })),
  );
  expectRedacted(closes, /private|portal|streamKind/u);
});

it("leaves unavailable node diagnostics empty without replacing the test failure", async () => {
  const root = dirs.make("desktop-node-log-bounds-");
  const file = path.join(root, "node.log");
  expect(await readDesktopProofNodeStreamCloses(file)).toBeNull();
  await writeFile(file, Buffer.alloc(1024 * 1024 + 1));
  expect(await readDesktopProofNodeStreamCloses(file)).toBeNull();
  await writeFile(file, '{"partial":');
  expect(await readDesktopProofNodeStreamCloses(file)).toEqual([]);
  const link = path.join(root, "linked.log");
  await symlink(file, link);
  expect(await readDesktopProofNodeStreamCloses(link)).toBeNull();
});

it("bounds a node log that grows after admission and closes the read handle", async () => {
  const file = fixtureFile("desktop-node-log-growth-", "node.log");
  await writeFile(file, "{}\n");
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const handle = await actual.open(file, "r");
  const read = vi.spyOn(handle, "read");
  const close = vi.spyOn(handle, "close");
  vi.mocked(lstat).mockImplementationOnce(async () => {
    const admitted = await actual.lstat(file);
    await appendFile(file, Buffer.alloc(1024 * 1024, 32));
    return admitted;
  });
  vi.mocked(open).mockResolvedValueOnce(handle);
  try {
    expect(await readDesktopProofNodeStreamCloses(file)).toBeNull();
    expect(read).toHaveBeenCalled();
    let actualBytes = 0;
    for (const result of read.mock.results) {
      if (result.type === "return") {
        actualBytes += (await result.value).bytesRead;
      }
    }
    expect(actualBytes).toBeLessThanOrEqual(1024 * 1024);
    expect(close).toHaveBeenCalledTimes(1);
  } finally {
    vi.mocked(lstat).mockImplementation(actual.lstat);
    vi.mocked(open).mockImplementation(actual.open);
    read.mockRestore();
    close.mockRestore();
    await handle.close();
  }
});

it("records sshd runtime directory facts without modifying missing or unsafe paths", async () => {
  const root = dirs.make("desktop-sshd-runtime-");
  const directory = path.join(root, "runtime");
  expect(await inspectDesktopSshdRuntimeDirectory(directory)).toEqual({
    status: "missing",
    symlink: null,
    directory: null,
    rootOwned: null,
    groupOrWorldWritable: null,
  });
  await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
  await mkdir(directory, { mode: 0o700 });
  expect(await inspectDesktopSshdRuntimeDirectory(directory)).toMatchObject({
    status: "present",
    symlink: false,
    directory: true,
    rootOwned: (await stat(directory)).uid === 0,
    groupOrWorldWritable: process.platform === "win32" ? expect.any(Boolean) : false,
  });
  const link = path.join(root, "runtime-link");
  await symlink(directory, link, "dir");
  expect(await inspectDesktopSshdRuntimeDirectory(link)).toMatchObject({
    symlink: true,
    directory: true,
  });
  if (process.platform !== "win32") {
    await chmod(directory, 0o770);
    expect(await inspectDesktopSshdRuntimeDirectory(directory)).toMatchObject({
      groupOrWorldWritable: true,
    });
    expect((await stat(directory)).mode & 0o777).toBe(0o770);
  }
  const file = path.join(root, "not-a-directory");
  await writeFile(file, "private contents");
  expect(await inspectDesktopSshdRuntimeDirectory(file)).toMatchObject({ directory: false });
});

it.each([
  ["Missing privilege separation directory: /private/runtime\r\n", "privsep-directory-missing"],
  [
    "/private/runtime must be owned by root and not group or world-writable.\r\n",
    "privsep-directory-permissions",
  ],
  ["Privilege separation user private-user does not exist\r\n", "privsep-user-missing"],
  ["sshd: no hostkeys available -- exiting.\n", "host-key-unavailable"],
  ["private config failed at private path", "unclassified"],
  ["x".repeat(64 * 1024 + 1), "output-too-large"],
])("exports only a fixed sshd failure category (%#)", (stderr, category) => {
  expect(desktopProofSshdFailure(stderr)).toBe(category);
  expect(desktopProofSshdFailure(stderr)).not.toMatch(/private|runtime|user$/u);
});

it("publishes fixed phases and known failure locations, not raw reporter content", () => {
  const result = desktopProofTestReport(
    rawTestReport(
      "AssertionError: private-token actual=secret expected=password\n at /private/workspace/test/e2e/qa-lab/runtime/skill-library-node-process.ts:42:9\n at /private/secret.ts:1:2\n https://private.invalid/token",
    ),
  );
  expect(result.failedTests).toBe(1);
  expect(result.files).toHaveLength(1);
  expect(result.files[0]?.file).toBe("ui/src/e2e/desktop-resize.real-gateway.e2e.test.ts");
  expect(result.files[0]?.assertions).toHaveLength(1);
  expect(reportAssertion(result)).toMatchObject({
    index: 0,
    phase: "node-admission",
    declarationLocation: { line: 120, column: 3 },
    failures: [
      {
        category: "AssertionError",
        failureLocations: [
          {
            file: "test/e2e/qa-lab/runtime/skill-library-node-process.ts",
            line: 42,
            column: 9,
          },
        ],
      },
    ],
  });
  expectRedacted(result, /private|token|secret|password|actual|expected|success|title|https/u);
});

it("retains native desktop file and case timing without publishing private reporter fields", async () => {
  const file = fixtureFile("desktop-timing-report-", "report.json");
  const log = path.join(path.dirname(file), "test-node.log");
  const report = rawTestReport();
  Object.assign(report.testResults[0]!, { startTime: 1000, endTime: 1025 });
  Object.assign(report.testResults[0]!.assertionResults[0]!, { duration: 25.5 });
  await writeJson(file, report);
  await writeFile(
    log,
    [
      "private stdout",
      "[vitest:module] " +
        JSON.stringify({
          file: "ui/src/e2e/desktop-resize.real-gateway.e2e.test.ts",
          project: "private-project",
          diagnostic: { duration: 72.25, collectDuration: 14.5, privateData: "private-token" },
        }),
    ].join("\n"),
  );
  const result = await readDesktopProofTestReport(file, log);
  expect(result.files[0]?.timing).toEqual({ executionMs: 72.25, collectionMs: 14.5 });
  expect(reportAssertion(result)?.durationMs).toBe(25.5);
  expectRedacted(result, /private|token|stdout|project|startTime|endTime|privateData/u);
});

it("leaves unavailable or invalid desktop timing unknown without changing failure evidence", async () => {
  const file = fixtureFile("desktop-timing-missing-", "report.json");
  const log = path.join(path.dirname(file), "test-node.log");
  const report = rawTestReport();
  await writeJson(file, report);
  const unchanged = await readDesktopProofTestReport(file);
  expect(unchanged.files[0]?.timing).toBeNull();
  expect(reportAssertion(unchanged)?.durationMs).toBeNull();
  const record = {
    file: "ui/src/e2e/desktop-resize.real-gateway.e2e.test.ts",
    diagnostic: { duration: 12, collectDuration: 4 },
  };
  const line = "[vitest:module] " + JSON.stringify(record);
  for (const text of [
    "private partial stdout\n[vitest:module] {",
    line + "\n[vitest:module] {",
    line + "\n" + line,
    "[vitest:module] " + JSON.stringify({ ...record, file: "/private/other.test.ts" }),
    ...[-1, null, "private-token", 720_001].map(
      (duration) =>
        "[vitest:module] " +
        JSON.stringify({ ...record, diagnostic: { duration, collectDuration: 4 } }),
    ),
  ]) {
    await writeFile(log, text);
    expect(await readDesktopProofTestReport(file, log)).toEqual(unchanged);
  }
  expect(await readDesktopProofTestReport(file, log + ".missing")).toEqual(unchanged);
  for (const duration of [-1, Infinity, Number.NaN, "private-token", 720_001]) {
    const value = rawTestReport();
    Object.assign(value.testResults[0]!.assertionResults[0]!, { duration });
    expect(reportAssertion(desktopProofTestReport(value))?.durationMs).toBeNull();
  }
});

it.each([
  ["Error: Test timed out in 120000ms.\nprivate pending operation", "test-timeout"],
  ["Error: Hook timed out in 60000ms.\nprivate pending operation", "hook-timeout"],
  ["Error: a timeout might have happened after 174000ms", "test-error"],
])("classifies only the emitted timeout contract: %s", (message, category) => {
  const result = desktopProofTestReport(rawTestReport(message));
  expect(reportAssertion(result)?.failures[0]?.category).toBe(category);
});

it("retains bounded viewer failure diagnostics with an unavailable snapshot", async () => {
  const diagnostics = {
    ...viewerFailure,
    snapshotStatus: "unavailable",
    pageClosed: true,
    canvasCount: null,
    snapshotFramebuffer: null,
    socketCount: null,
    latestReadyState: null,
    socketCloses: null,
  };
  const file = fixtureFile("desktop-viewer-report-", "report.json");
  await writeJson(
    file,
    rawTestReport(undefined, {
      desktopViewerResizeFailure: {
        ...diagnostics,
        expected: { ...diagnostics.expected, privateText: "private-token" },
        nodeStreamCloses: diagnostics.nodeStreamCloses.map((event) => ({
          ...event,
          privateDetail: "private-node-data",
        })),
        html: "private-dom",
        socketUrl: "https://example.invalid/private-token",
        error: "private-error",
      },
    }),
  );
  const report = await readDesktopProofTestReport(file);
  expect(reportAssertion(report)).toMatchObject({ viewerResize: diagnostics });
  expectRedacted(report, /private|token|password|html|socketUrl|https/u);
});

it.each([
  { pageClosed: 0 },
  { latestReadyState: 4 },
  { nodeStreamCloses: [{ trigger: "private-token", closeCode: 1000 }] },
  { nodeStreamCloses: repeat(viewerFailure.nodeStreamCloses[0], 9) },
  { socketCloses: repeat(viewerFailure.socketCloses[0], 9) },
  {
    socketCloses: [
      { ...viewerFailure.socketCloses[0], category: "control-taken:private-operator" },
    ],
  },
  { expected: { width: Infinity, height: 850 } },
])("rejects invalid viewer diagnostic bounds: %j", (override) => {
  expect(() => projectViewer({ ...viewerFailure, ...override })).toThrow();
});

it("rejects unknown report files and excessive counts, and ignores unknown metadata phases", () => {
  const report = rawTestReport();
  report.testResults[0]!.assertionResults[0]!.meta.desktopProofPhase = "private-token";
  expect(reportAssertion(desktopProofTestReport(report))?.phase).toBe("unknown");
  expect(() => desktopProofTestReport({ ...report, numTotalTests: 17 })).toThrow();
  report.testResults[0]!.name = "/private/other.test.ts";
  expect(() => desktopProofTestReport(report)).toThrow();
});

it("projects only known phases from bounded regular checkpoints", async () => {
  const file = fixtureFile("desktop-private-phase-", "desktop-phase.json");
  const root = path.dirname(file);
  expect(await readDesktopProofPhase(file)).toEqual(phaseResult("unavailable"));
  await writeJson(file, { lastObservedPhase: "file-loaded", secret: "private" });
  expect(await readDesktopProofPhase(file)).toEqual(phaseResult("available", "file-loaded"));
  const link = path.join(root, "linked-phase.json");
  await symlink(file, link);
  expect(await readDesktopProofPhase(link)).toEqual(phaseResult("invalid"));
  expect(await readDesktopProofPhase(root)).toEqual(phaseResult("invalid"));
  for (const content of ["{", '{"lastObservedPhase":"private-token"}', "x".repeat(1025)]) {
    await writeFile(file, content);
    expect(await readDesktopProofPhase(file)).toEqual(phaseResult("invalid"));
  }
});

it("projects explicit resource ownership without inferring detached-process cleanup", async () => {
  const file = fixtureFile("desktop-process-ownership-", "desktop-phase.json");
  for (const gateway of ["not-started", "owned", "closed"] as const) {
    await writeJson(file, {
      lastObservedPhase: "gateway-start",
      owners: { gateway, endpointTap: "owned", privatePath: "/private/fixture" },
      startupAtAbort: { currentPhase: "private-token" },
    });
    expect(await readDesktopProofPhase(file)).toEqual({
      status: "available",
      lastObservedPhase: "gateway-start",
      owners: { gateway, endpointTap: "owned" },
    });
  }
  for (const owners of [
    null,
    { gateway: "closed" },
    { gateway: "private", endpointTap: "closed" },
  ]) {
    await writeJson(file, { lastObservedPhase: "gateway-start", owners });
    expect((await readDesktopProofPhase(file)).owners).toBeNull();
  }
});

it("accepts only bounded regular reporter files", async () => {
  const root = dirs.make("desktop-private-report-");
  const file = path.join(root, "report.json");
  await writeJson(file, rawTestReport());
  expect((await readDesktopProofTestReport(file)).failedTests).toBe(1);
  const link = path.join(root, "report-link.json");
  await symlink(file, link);
  await expect(readDesktopProofTestReport(link)).rejects.toThrow("regular file");
  await writeFile(file, "{");
  await expect(readDesktopProofTestReport(file)).rejects.toThrow();
  await writeFile(file, Buffer.alloc(8 * 1024 * 1024 + 1));
  await expect(readDesktopProofTestReport(file)).rejects.toThrow("bounded");
});

it("retains child ownership when both private logging and export fail", async () => {
  const child = Object.assign(new Error("child cleanup failed"), {
    processTreeState: "live",
    code: "EPROCESSGROUP_CLEANUP_FAILED",
  });
  const logging = new Error("log write failed");
  const exporting = new Error("export failed");
  let unjoined = false;
  const record = (error: unknown) => {
    unjoined ||= hasUnjoinedWork(error);
  };
  const failure = await withDesktopProofCleanup(
    () =>
      withDesktopProofCleanup(
        async () => {
          throw child;
        },
        async () => {
          expect(unjoined).toBe(true);
          throw logging;
        },
        record,
      ),
    async () => {
      expect(unjoined).toBe(true);
      throw exporting;
    },
    record,
  ).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(AggregateError);
  const aggregate = failure as AggregateError;
  expect(aggregate.errors[0].errors).toEqual([child, logging]);
  expect(aggregate.errors[1]).toBe(exporting);
  expect(hasUnjoinedWork(failure)).toBe(true);
  expect(unjoined).toBe(true);
});

it.each(["entries", "bytes"] as const)(
  "shares the %s budget across node and SSH",
  async (limit) => {
    const { root, input } = await exportFixture();
    const data = JSON.stringify(assets);
    await writeFile(path.join(input, "served-assets.json"), data);
    const budget = {
      entries: limit === "entries" ? 255 : 0,
      bytes: limit === "bytes" ? 64 * 1024 ** 2 - Buffer.byteLength(data) : 0,
    };
    await exportDesktopResizeProof(input, path.join(root, "node"), "node", budget);
    await expect(
      exportDesktopResizeProof(input, path.join(root, "ssh"), "ssh", budget),
    ).rejects.toThrow(/bound/u);
  },
);

it("records canonical dirty paths before refusing source admission at source-clean", async () => {
  const tracked = ["src/edited.ts", "src/deleted.ts", 'src/space and "quote".ts'];
  const status = [
    ` M ${tracked[0]}\0`,
    `D  ${tracked[1]}\0`,
    `MM ${tracked[2]}\0`,
    "A  staged-private.txt\0",
    "?? untracked-private\n M src/edited.ts\0",
  ].join("");
  const fixture = sourceAdmissionFixture(status, tracked);
  await expect(fixture.read()).rejects.toMatchObject({ code: "ERR_ASSERTION" });
  expect(fixture.receipt).toEqual({
    phase: "source-clean",
    sourceStatus: {
      head,
      bytes: Buffer.byteLength(status),
      totalEntries: 5,
      entries: [
        { status: " M", path: tracked[0] },
        { status: "D ", path: tracked[1] },
        { status: "MM", path: tracked[2] },
      ],
      omittedEntries: 2,
    },
  });
  expectRedacted(fixture.receipt, /private/u);
});

it("clears earlier source status before a failed recheck", async () => {
  const fixture = sourceAdmissionFixture("", ["src/edited.ts"]);
  await fixture.read();
  expect(fixture.receipt.sourceStatus).not.toBeNull();
  delete fixture.replies["rev-parse"];
  await expect(fixture.read()).rejects.toThrow("Git command failed");
  expect(fixture.receipt.sourceStatus).toBeNull();
  expectRedacted(fixture.receipt, /private/u);
});

it("does not decode paths beyond the status byte budget or publish unsafe canonical names", async () => {
  const names = [
    "src/\nprivate.ts",
    "../private.ts",
    "/private.ts",
    "src/\\private.ts",
    `src/${"é".repeat(255)}.ts`,
    "src/late.ts",
  ];
  const status =
    names
      .slice(0, -1)
      .map((name) => ` M ${name}\0`)
      .join("") + `?? ${"private".repeat(10_000)}\0 M src/late.ts\0`;
  const fixture = sourceAdmissionFixture(status, names);
  await expect(fixture.read()).rejects.toMatchObject({ code: "ERR_ASSERTION" });
  expect(fixture.receipt.sourceStatus).toMatchObject({
    totalEntries: 7,
    entries: [],
    omittedEntries: 7,
  });
  expectRedacted(fixture.receipt, /private|late|é/u);
});

it("uses real NUL status without leaking either private additions or a rename destination", async () => {
  const root = dirs.make("desktop-source-status-");
  const git = gitFixture(root);
  git(["init", "--quiet"]);
  await writeFile(path.join(root, "tracked.txt"), "tracked contents\n");
  git(["add", "--", "tracked.txt"]);
  const objectTree = git(["write-tree"]).toString().trim();
  const checkout = git(["commit-tree", objectTree, "-m", "source fixture"]).toString().trim();
  git(["update-ref", "HEAD", checkout]);
  git(["config", "status.renames", "true"]);
  const { receipt, read } = sourceReader(git, checkout);
  await expect(read()).resolves.toMatchObject({ head: checkout, tree: objectTree });
  await rename(path.join(root, "tracked.txt"), path.join(root, "renamed-private.txt"));
  await writeFile(path.join(root, "staged-private.txt"), "private contents\n");
  git(["add", "--all"]);
  await writeFile(path.join(root, "untracked-private.txt"), "private contents\n");
  await expect(read()).rejects.toMatchObject({ code: "ERR_ASSERTION" });
  expect(receipt).toMatchObject({
    phase: "source-clean",
    sourceStatus: {
      head: checkout,
      totalEntries: 4,
      entries: [{ status: "D ", path: "tracked.txt" }],
      omittedEntries: 3,
    },
  });
  expectRedacted(receipt, /private/u);
});

it.each([
  [{ checkout: head, head, base }, "pr-head"],
  [{ checkout: head }, "checkout"],
] as const)("distinguishes literal head proof: %j", (expected, kind) => {
  expect(desktopProofSource({ head, tree, parents: [base] }, expected).kind).toBe(kind);
});

it("reads actual merge parents at a depth-one Git boundary without conflating the event base", async () => {
  const root = dirs.make("desktop-shallow-source-");
  const runGit = gitFixture(root);
  const git = (args: string[], input?: string) => runGit(args, input).toString().trim();
  git(["init", "--quiet"]);
  const objectTree = git(["mktree"], "");
  const commit = (message: string, ...parents: string[]) =>
    git(["commit-tree", objectTree, ...parents.flatMap((parent) => ["-p", parent]), "-m", message]);
  const eventBase = commit("event base");
  const testedBase = commit("tested base", eventBase);
  const prHead = commit("PR head", eventBase);
  const checkout = commit("test merge", testedBase, prHead);
  git(["update-ref", "HEAD", checkout]);
  await writeFile(path.join(root, ".git", "shallow"), `${checkout}\n`);
  expect(git(["rev-parse", "--is-shallow-repository"])).toBe("true");
  expect(git(["show", "-s", "--format=%P", "HEAD"])).toBe("");
  const observedHead = git(["rev-parse", "--verify", "HEAD"]);
  const actual = desktopProofCommit(observedHead, git(["cat-file", "commit", observedHead]));
  expect(desktopProofSource(actual, { checkout, head: prHead, base: eventBase })).toEqual({
    head: checkout,
    tree: objectTree,
    parents: [testedBase, prHead],
    kind: "pr-merge",
    prHead,
    prEventBase: eventBase,
    testedBase,
  });
});

it.each([
  { parents: [base, merge], expected: { checkout: merge, head, base } },
  { parents: [base, head], expected: { checkout: base, head, base } },
  { parents: [base, head], expected: { checkout: merge, head } },
])("rejects source drift and unbound PR parents: %j", ({ parents, expected }) => {
  expect(() => desktopProofSource({ head: merge, tree, parents }, expected)).toThrow();
});

it("exports only named SSH facts", () => {
  const safe = sanitizeDesktopResizeProof(proof("ssh"), "ssh");
  expectRedacted(safe, /private|hello|token|deviceId/u);
  expect(safe.carrier).toBe("ssh");
  expect(safe.samples).toHaveLength(5);
});

it("rejects incomplete or failed node proof", () => {
  const node = { passwordAbsentFromObserve: true, disconnectClosedViewer: false };
  expect(() => sanitizeDesktopResizeProof({ ...proof(), node }, "node")).toThrow();
});

it("rejects asset paths and non-digests", () => {
  expect(() => desktopProofAssets({ "../index.js": "e".repeat(64) })).toThrow();
  expect(() => desktopProofAssets({ "index.js": "private" })).toThrow();
  expect(() => desktopProofAssets({ "control-ui-boot-shared.js": "e".repeat(64) })).toThrow();
});

it("exports a complete bounded allowlist without raw diagnostics or metadata", async () => {
  const { input, output } = await exportFixture();
  const nested = path.join(input, "desktop-suite");
  await mkdir(nested, { recursive: true });
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
    "base64",
  );
  await writeFile(path.join(nested, "01-fit.png"), png);
  for (const stage of desktopResizeStages) {
    await writeFile(path.join(nested, `${stage}.png`), png);
    await writeJson(path.join(nested, `${stage}-geometry.json`), {
      stage,
      expected: size,
      guest: size,
      canvas: size,
      matchOffered: true,
      hello: { token: "private" },
    });
  }
  await writeJson(path.join(nested, "served-assets.json"), assets);
  await writeJson(path.join(nested, "resize-proof.json"), proof());
  await writeFile(path.join(nested, "connection-diagnostics.json"), "private-token");
  const exported = await exportDesktopResizeProof(input, output, "node");
  expect(exported.complete).toBe(true);
  expect(exported.proof?.assets).toEqual(assets);
  expect(await readdir(output)).toHaveLength(13);
  expect(await readFile(path.join(output, "resize-proof.json"), "utf8")).not.toMatch(
    /private|hello|deviceId/u,
  );
  expect(await readFile(path.join(output, "02-panel-geometry.json"), "utf8")).not.toContain(
    "hello",
  );
});

it("rejects symlinks instead of publishing their targets", async () => {
  const { root, input, output } = await exportFixture();
  await writeFile(path.join(root, "secret"), "private-token");
  await symlink(path.join(root, "secret"), path.join(input, "resize-proof.json"));
  await expect(exportDesktopResizeProof(input, output, "node")).rejects.toThrow("regular-file");
});
