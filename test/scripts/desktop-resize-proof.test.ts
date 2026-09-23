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
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
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
import {
  resolveRuntimeWorkerArgv,
  resolveRuntimeWorkerUrl,
} from "../../src/infra/runtime-worker-url.js";
import type { DesktopClient } from "../../ui/src/components/desktop/desktop-client.ts";
import {
  observeDesktopEndpointPackets,
  observeDesktopProofRfbLifecycle,
} from "../../ui/src/e2e/desktop-resize-real.test-support.ts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { toolingNativeRuntimeEntrypoints } from "./tooling-native-runtime.test-support.js";

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
const assets = { "index-fixture.js": "e".repeat(64) };
function sourceAdmissionFixture(status: string, tracked: string[]) {
  const receipt = { phase: "preflight", sourceStatus: null as DesktopProofSourceStatus | null };
  const replies: Record<string, string> = {
    "rev-parse": `${head}\n`,
    "cat-file": `tree ${tree}\nparent ${base}\n\nfixture\n`,
    "ls-tree": `${tracked.join("\0")}\0`,
    status,
  };
  return {
    receipt,
    replies,
    read: () =>
      readDesktopProofSource(
        async (label, args) => {
          receipt.phase = label;
          const reply = replies[args[0]!];
          if (reply === undefined) {
            throw new Error("Git command failed with private details");
          }
          return Buffer.from(reply);
        },
        { checkout: head },
        (value) => {
          receipt.sourceStatus = value;
        },
      ),
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

describe("desktop proof identity and public evidence", () => {
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
          ordinal: number;
          socketIndex: number | null;
          phase: string;
          connectedObserved: boolean;
          clean: boolean | null;
          securityStatus: number | null;
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
    expect(JSON.stringify(snapshot())).not.toMatch(/private|token|reason|url|fixture/u);
    sockets.push(sockets[1]!);
    expect(snapshot().events.every((event) => event.socketIndex === null)).toBe(true);
    await result;
  });

  it("bounds RFB events without suppressing callback exceptions or inferring a completed handshake", async () => {
    vi.stubGlobal("window", {
      desktopProofSockets: [],
      location: { href: "https://fixture.invalid" },
    });
    type Options = Parameters<DesktopClient["connect"]>[0];
    let observed: Options | undefined;
    const client = {
      connect: (options: Options) => {
        observed = options;
        return Promise.resolve({} as Awaited<ReturnType<DesktopClient["connect"]>>);
      },
    };
    const factory = () => client;
    const panel = { desktopClientFactory: factory };
    observeDesktopProofRfbLifecycle(panel as unknown as Element);
    const failure = new Error("original callback failed");
    const callback = vi.fn(() => {
      throw failure;
    });
    await panel.desktopClientFactory().connect({
      target: {} as HTMLElement,
      viewOnly: true,
      isCurrent: () => true,
      wsUrl: "/desktop/observe?token=hidden",
      onDisconnect: callback,
    });
    for (let index = 0; index < 10; index++) {
      expect(() => observed!.onDisconnect!({ clean: false })).toThrow(failure);
    }
    const snapshot = Reflect.get(window, "desktopProofRfbLifecycle")();
    expect(callback).toHaveBeenCalledTimes(10);
    expect(snapshot.events).toHaveLength(8);
    expect(snapshot.omitted).toBe(3);
    expect(
      snapshot.events.every((event: { connectedObserved: boolean }) => !event.connectedObserved),
    ).toBe(true);
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
    const file = path.join(dirs.make("desktop-gateway-log-"), "gateway.log");
    const record = (message: string, metadata: unknown) =>
      JSON.stringify({ "0": '{"subsystem":"gateway/desktop"}', "1": metadata, "2": message });
    const lines = Array.from({ length: 10 }, () =>
      record("desktop observer closed", {
        trigger: "stream-close",
        cleanupCode: 1000,
        closeCode: 1000,
        sourceKey: "private-worker",
        streamId: "private-stream",
        ownerEpoch: 3,
      }),
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
    expect(value?.sshTunnelExits).toEqual({
      events: [{ code: null, signal: "SIGTERM", stopRequested: true }],
      omitted: 0,
    });
    expect(JSON.stringify(value)).not.toMatch(/private|sourceKey|streamId|ownerEpoch|stderr/u);
    await writeFile(file, Buffer.alloc(1024 * 1024, 32));
    expect(await readDesktopProofGatewayCloses(file)).toEqual({
      observerCloses: { events: [], omitted: 0 },
      sshTunnelExits: { events: [], omitted: 0 },
    });
    await writeFile(file, Buffer.alloc(1024 * 1024 + 1));
    expect(await readDesktopProofGatewayCloses(file)).toBeNull();
    expect(await readDesktopProofGatewayCloses(file + ".missing")).toBeNull();
    const link = file + ".link";
    await symlink(file, link);
    expect(await readDesktopProofGatewayCloses(link)).toBeNull();
  });

  it("bounds repeated tap closures and retains a fixed upstream error category", async () => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("missing fixture address");
    }
    // Reserve the upstream port until the tap binds so it cannot connect back to itself.
    const tap = await observeDesktopEndpointPackets(address.port, new AbortController().signal);
    const clients: net.Socket[] = [];
    try {
      expect(tap.port).not.toBe(address.port);
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      for (let index = 0; index < 10; index++) {
        const client = net.connect({ host: "127.0.0.1", port: tap.port });
        client.on("error", () => {});
        clients.push(client);
        await vi.waitFor(() =>
          expect(tap.terminalSnapshot().events.at(-1)?.connectionIndex).toBe(index),
        );
      }
      expect(tap.terminalSnapshot()).toEqual({
        events: Array.from({ length: 8 }, (_, index) => ({
          connectionIndex: index + 2,
          side: "upstream",
          event: "error",
          errorCategory: "refused",
          hadError: null,
        })),
        omitted: 2,
      });
    } finally {
      clients.forEach((client) => client.destroy());
      await tap.close();
    }
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
      endpointCloses: { events: [{ ...endpoint, address: "private-host" }], omitted: 3 },
      rfbLifecycle: { events: [{ ...rfb, url: "https://private.invalid/token" }], omitted: 1 },
      gatewayCloses: {
        observerCloses: { events: [], omitted: 0 },
        sshTunnelExits: { events: [], omitted: 0 },
      },
    };
    const project = (value: unknown) =>
      desktopProofTestReport(rawTestReport(undefined, { desktopViewerResizeFailure: value }))
        .files[0]?.assertions[0]?.viewerResize;
    expect(project(diagnostic)).toMatchObject({
      endpointCloses: { events: [endpoint], omitted: 3 },
      rfbLifecycle: { events: [rfb], omitted: 1 },
    });
    expect(JSON.stringify(project(diagnostic))).not.toMatch(/private|token|address|url/u);
    for (const override of [
      { endpointCloses: { events: Array.from({ length: 9 }, () => endpoint), omitted: 0 } },
      { endpointCloses: { events: [{ ...endpoint, side: "private-host" }], omitted: 0 } },
      { rfbLifecycle: { events: [rfb], omitted: -1 } },
      { rfbLifecycle: { events: [{ ...rfb, socketIndex: -1 }], omitted: 0 } },
      { rfbLifecycle: { events: [{ ...rfb, phase: "private-error" }], omitted: 0 } },
      {
        gatewayCloses: {
          observerCloses: {
            events: [{ trigger: "private-error", cleanupCode: 1000, closeCode: 1000 }],
            omitted: 0,
          },
          sshTunnelExits: null,
        },
      },
    ]) {
      expect(() => project({ ...diagnostic, ...override })).toThrow();
    }
    expect(
      project({ ...viewerFailure, endpointCloses: null, rfbLifecycle: null, gatewayCloses: null }),
    ).toMatchObject({ endpointCloses: null, rfbLifecycle: null, gatewayCloses: null });
  });

  it("retains node close categories from the existing JSON file logger", async () => {
    const file = path.join(dirs.make("desktop-node-log-"), "node.log");
    const loggerUrl = resolveRuntimeWorkerUrl(toolingNativeRuntimeEntrypoints.logger);
    const subsystemUrl = resolveRuntimeWorkerUrl(toolingNativeRuntimeEntrypoints.subsystemLogger);
    execFileSync(
      process.execPath,
      [
        ...resolveRuntimeWorkerArgv(loggerUrl, process.execPath).slice(0, -1),
        "--input-type=module",
        "--eval",
        `
          import { flushLogger, setLoggerOverride } from ${JSON.stringify(loggerUrl.href)};
          import { createSubsystemLogger } from ${JSON.stringify(subsystemUrl.href)};
          setLoggerOverride({ file: process.argv[1], level: "info", consoleLevel: "silent" });
          const log = createSubsystemLogger("node-host/stream");
          log.info("node stream closed", {
            streamKind: "portal", trigger: "target-close", closeCode: 1000,
          });
          for (let index = 0; index < 10; index++) {
            log.info("node stream closed", {
              streamKind: "desktop", trigger: "target-close", closeCode: 1000 + index,
              privateDetail: "private-node-data",
            });
          }
          await flushLogger();
        `,
        file,
      ],
      {
        cwd: path.resolve(import.meta.dirname, "../.."),
        env: { ...process.env, OPENCLAW_TEST_FILE_LOG: "1" },
        timeout: 15_000,
        stdio: "pipe",
      },
    );
    const closes = await readDesktopProofNodeStreamCloses(file);
    expect(closes).toEqual(
      Array.from({ length: 8 }, (_, index) => ({
        trigger: "target-close",
        closeCode: 1002 + index,
      })),
    );
    expect(JSON.stringify(closes)).not.toMatch(/private|portal|streamKind/u);
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

  it("accepts exactly 1 MiB of node diagnostics and retains the last eight closes", async () => {
    const file = path.join(dirs.make("desktop-node-log-limit-"), "node.log");
    const records = Array.from({ length: 10 }, (_, index) =>
      JSON.stringify({
        "0": '{"subsystem":"node-host/stream"}',
        "1": { streamKind: "desktop", trigger: "target-close", closeCode: 1000 + index },
        "2": "node stream closed",
      }),
    ).join("\n");
    await writeFile(file, records.padEnd(1024 * 1024, " "));
    expect(await readDesktopProofNodeStreamCloses(file)).toEqual(
      Array.from({ length: 8 }, (_, index) => ({
        trigger: "target-close",
        closeCode: 1002 + index,
      })),
    );
  });

  it("bounds a node log that grows after admission and closes the read handle", async () => {
    const file = path.join(dirs.make("desktop-node-log-growth-"), "node.log");
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

  it("keeps the UI phase contract narrower than arbitrary reporter strings", () => {
    type Phase = Exclude<
      ReturnType<typeof desktopProofTestReport>["files"][number]["assertions"][number]["phase"],
      "unknown"
    >;
    expectTypeOf<"node-admission">().toExtend<Phase>();
    expectTypeOf<"file-loaded">().toExtend<Phase>();
    expectTypeOf<"unknown">().not.toExtend<Phase>();
    expectTypeOf<"misspelled-phase">().not.toExtend<Phase>();
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

  it("preserves the sshd command failure and private log write when projection fails", async () => {
    const child = new Error("sshd-config failed");
    const projection = new Error("projection failed");
    const recorded: unknown[] = [];
    const record = (error: unknown) => {
      recorded.push(error);
    };
    let privateLogSaved = false;
    const failure = await withDesktopProofCleanup(
      async () => {
        throw child;
      },
      () =>
        withDesktopProofCleanup(
          async () => {
            expect(recorded[0]).toBe(child);
            throw projection;
          },
          async () => {
            privateLogSaved = true;
          },
          record,
        ),
      record,
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors[0]).toBe(child);
    expect((failure as AggregateError).errors[1].errors[0]).toBe(projection);
    expect(privateLogSaved).toBe(true);
  });

  it("publishes fixed phases and known failure locations, not raw reporter content", () => {
    const result = desktopProofTestReport(
      rawTestReport(
        "AssertionError: private-token actual=secret expected=password\n at /private/workspace/test/e2e/qa-lab/runtime/skill-library-node-process.ts:42:9\n at /private/secret.ts:1:2\n https://private.invalid/token",
      ),
    );
    expect(result).toMatchObject({
      failedTests: 1,
      files: [
        {
          file: "ui/src/e2e/desktop-resize.real-gateway.e2e.test.ts",
          assertions: [
            {
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
            },
          ],
        },
      ],
    });
    expect(JSON.stringify(result)).not.toMatch(
      /private|token|secret|password|actual|expected|success|title|https/u,
    );
  });

  it.each([
    ["Error: Test timed out in 120000ms.\nprivate pending operation", "test-timeout"],
    ["Error: Test timed out in 120000ms while waiting for private operation.", "test-timeout"],
    ["Error: Hook timed out in 60000ms.\nprivate pending operation", "hook-timeout"],
    ["Error: a timeout might have happened after 174000ms", "test-error"],
  ])("classifies only the emitted timeout contract: %s", (message, category) => {
    const result = desktopProofTestReport(rawTestReport(message));
    expect(result.files[0]?.assertions[0]?.failures[0]?.category).toBe(category);
  });

  it.each([
    { label: "mismatch", override: {} },
    {
      label: "missing canvas",
      override: { canvasCount: 0, lastFramebuffer: null, snapshotFramebuffer: null },
    },
    { label: "multiple canvases", override: { canvasCount: 2, snapshotFramebuffer: null } },
    { label: "no closed sockets", override: { socketCloses: [] } },
    {
      label: "closed reconnect",
      override: {
        canvasCount: 0,
        snapshotFramebuffer: null,
        socketCount: 3,
        latestReadyState: 3,
        socketCloses: [
          { socketIndex: 0, code: 1000, wasClean: true, category: "unknown" },
          { socketIndex: 1, code: 4000, wasClean: true, category: "takeover" },
          { socketIndex: 2, code: 1006, wasClean: false, category: "unknown" },
        ],
      },
    },
    {
      label: "zero framebuffer",
      override: {
        lastFramebuffer: { width: 0, height: 0 },
        snapshotFramebuffer: { width: 0, height: 0 },
      },
    },
    {
      label: "unavailable snapshot",
      override: {
        snapshotStatus: "unavailable",
        pageClosed: true,
        canvasCount: null,
        snapshotFramebuffer: null,
        socketCount: null,
        latestReadyState: null,
        socketCloses: null,
      },
    },
    {
      label: "timed-out snapshot",
      override: {
        snapshotStatus: "timed-out",
        canvasCount: null,
        snapshotFramebuffer: null,
        socketCount: null,
        latestReadyState: null,
        socketCloses: null,
      },
    },
  ])("retains bounded viewer failure diagnostics: $label", async ({ override }) => {
    const diagnostics = { ...viewerFailure, ...override };
    const root = dirs.make("desktop-viewer-report-");
    const file = path.join(root, "report.json");
    await writeFile(
      file,
      JSON.stringify(
        rawTestReport(undefined, {
          desktopViewerResizeFailure: {
            ...diagnostics,
            expected: { ...diagnostics.expected, privateText: "private-token" },
            socketCloses:
              diagnostics.socketCloses?.map((event) => ({
                ...event,
                reason: "control-taken:private-operator",
                url: "https://example.invalid/private-token",
              })) ?? null,
            nodeStreamCloses: diagnostics.nodeStreamCloses.map((event) => ({
              ...event,
              privateDetail: "private-node-data",
            })),
            html: "private-dom",
            socketUrl: "https://example.invalid/private-token",
            error: "private-error",
          },
        }),
      ),
    );
    const report = await readDesktopProofTestReport(file);
    expect(report.files[0]?.assertions[0]).toMatchObject({ viewerResize: diagnostics });
    expect(JSON.stringify(report)).not.toMatch(/private|token|password|html|socketUrl|https/u);
  });

  it.each([
    { snapshotStatus: "private-token" },
    { pageClosed: 0 },
    { canvasCount: -1 },
    { canvasCount: 10_001 },
    { socketCount: Number.NaN },
    { latestReadyState: 4 },
    { socketCloses: undefined },
    { socketCloses: "private-token" },
    { nodeStreamCloses: "private-token" },
    { nodeStreamCloses: [{ trigger: "private-token", closeCode: 1000 }] },
    { nodeStreamCloses: [{ trigger: "target-close", closeCode: 65_536 }] },
    { nodeStreamCloses: Array.from({ length: 9 }, () => viewerFailure.nodeStreamCloses[0]) },
    { socketCloses: Array.from({ length: 9 }, () => viewerFailure.socketCloses[0]) },
    ...[
      { socketIndex: -1 },
      { socketIndex: 10_000 },
      { code: 65_536 },
      { code: 1000.5 },
      { wasClean: 1 },
      { category: "control-taken:private-operator" },
    ].map((event) => ({ socketCloses: [{ ...viewerFailure.socketCloses[0], ...event }] })),
    { expected: { width: Infinity, height: 850 } },
    { lastFramebuffer: { width: 0.5, height: 0 } },
    { snapshotFramebuffer: { width: 8193, height: 0 } },
  ])("rejects invalid viewer diagnostic bounds: %j", (override) => {
    expect(() =>
      desktopProofTestReport(
        rawTestReport(undefined, {
          desktopViewerResizeFailure: { ...viewerFailure, ...override },
        }),
      ),
    ).toThrow();
  });

  it("leaves successful reporter output unchanged even with failure metadata", () => {
    const report = rawTestReport(undefined, { desktopViewerResizeFailure: viewerFailure });
    report.numFailedTests = 0;
    report.numFailedTestSuites = 0;
    report.testResults[0]!.status = "passed";
    report.testResults[0]!.assertionResults[0]!.status = "passed";
    report.testResults[0]!.assertionResults[0]!.failureMessages = [];
    expect(desktopProofTestReport(report).files[0]?.assertions[0]).toEqual({
      index: 0,
      status: "passed",
      phase: "node-admission",
      declarationLocation: { line: 120, column: 3 },
      failures: [],
    });
  });

  it("rejects unknown report files and excessive counts, and ignores unknown metadata phases", () => {
    const report = rawTestReport();
    report.testResults[0]!.assertionResults[0]!.meta.desktopProofPhase = "private-token";
    expect(desktopProofTestReport(report).files[0]?.assertions[0]?.phase).toBe("unknown");
    expect(() => desktopProofTestReport({ ...report, numTotalTests: 17 })).toThrow();
    report.testResults[0]!.name = "/private/other.test.ts";
    expect(() => desktopProofTestReport(report)).toThrow();
  });

  it("retains the observed phase and child timeout when the terminal report is missing and export fails", async () => {
    const root = dirs.make("desktop-report-failure-");
    const checkpoint = path.join(root, "desktop-phase.json");
    await writeFile(checkpoint, JSON.stringify({ lastObservedPhase: "node-admission" }));
    const child = Object.assign(new Error("test-node failed"), { code: "ETIMEDOUT" });
    const exporting = new Error("export failed");
    let lastObserved: Awaited<ReturnType<typeof readDesktopProofPhase>> | undefined;
    const recorded: unknown[] = [];
    const record = (error: unknown) => {
      recorded.push(error);
    };
    const failure = await withDesktopProofCleanup(
      async () => {
        throw child;
      },
      () =>
        withDesktopProofCleanup(
          async () => {
            expect(recorded[0]).toBe(child);
            lastObserved = await readDesktopProofPhase(checkpoint);
            await readDesktopProofTestReport(path.join(root, "missing.json"));
          },
          async () => {
            throw exporting;
          },
          record,
        ),
      record,
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    const aggregate = failure as AggregateError;
    expect(aggregate.errors[0]).toBe(child);
    expect(aggregate.errors[1].errors[0]).toMatchObject({ code: "ENOENT" });
    expect(aggregate.errors[1].errors[1]).toBe(exporting);
    expect(lastObserved).toEqual({
      status: "available",
      lastObservedPhase: "node-admission",
      owners: null,
    });
  });

  it("projects only known phases from bounded regular checkpoints", async () => {
    const root = dirs.make("desktop-private-phase-");
    const file = path.join(root, "desktop-phase.json");
    expect(await readDesktopProofPhase(file)).toEqual({
      status: "unavailable",
      lastObservedPhase: null,
      owners: null,
    });
    await writeFile(file, JSON.stringify({ lastObservedPhase: "file-loaded", secret: "private" }));
    expect(await readDesktopProofPhase(file)).toEqual({
      status: "available",
      lastObservedPhase: "file-loaded",
      owners: null,
    });
    const link = path.join(root, "linked-phase.json");
    await symlink(file, link);
    expect(await readDesktopProofPhase(link)).toEqual({
      status: "invalid",
      lastObservedPhase: null,
      owners: null,
    });
    expect(await readDesktopProofPhase(root)).toEqual({
      status: "invalid",
      lastObservedPhase: null,
      owners: null,
    });
    for (const content of ["{", '{"lastObservedPhase":"private-token"}', "x".repeat(1025)]) {
      await writeFile(file, content);
      expect(await readDesktopProofPhase(file)).toEqual({
        status: "invalid",
        lastObservedPhase: null,
        owners: null,
      });
    }
  });

  it("projects explicit resource ownership without inferring detached-process cleanup", async () => {
    const root = dirs.make("desktop-process-ownership-");
    const file = path.join(root, "desktop-phase.json");
    for (const gateway of ["not-started", "owned", "closed"] as const) {
      await writeFile(
        file,
        JSON.stringify({
          lastObservedPhase: "gateway-start",
          owners: { gateway, endpointTap: "owned", privatePath: "/private/fixture" },
          startupAtAbort: { currentPhase: "private-token" },
        }),
      );
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
      await writeFile(file, JSON.stringify({ lastObservedPhase: "gateway-start", owners }));
      expect((await readDesktopProofPhase(file)).owners).toBeNull();
    }
  });

  it("accepts only bounded regular reporter files", async () => {
    const root = dirs.make("desktop-private-report-");
    const file = path.join(root, "report.json");
    await writeFile(file, JSON.stringify(rawTestReport()));
    expect((await readDesktopProofTestReport(file)).failedTests).toBe(1);
    const link = path.join(root, "report-link.json");
    await symlink(file, link);
    await expect(readDesktopProofTestReport(link)).rejects.toThrow("regular file");
    await writeFile(file, "{");
    await expect(readDesktopProofTestReport(file)).rejects.toThrow();
    await writeFile(file, Buffer.alloc(8 * 1024 * 1024 + 1));
    await expect(readDesktopProofTestReport(file)).rejects.toThrow("bounded");
  });

  it("launches only the owned foreground window manager, without session autostart", async () => {
    const bootstrap = await readFile(
      new URL("../../scripts/test-desktop-resize-real.mts", import.meta.url),
      "utf8",
    );
    expect(bootstrap).toContain('daemon(`wm-${display}`, "openbox", ["--sm-disable"], env)');
    expect(bootstrap).not.toMatch(
      /"(?:startxfce4|xfce4-session|openbox-session|dbus-run-session|--startup)"/u,
    );
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
      const root = dirs.make("desktop-shared-budget-");
      const input = path.join(root, "input");
      await mkdir(input);
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
    expect(JSON.stringify(fixture.receipt)).not.toContain("private");
  });

  it("admits only empty status output, including when no dirty paths are publishable", async () => {
    const fixture = sourceAdmissionFixture("", ["src/edited.ts"]);
    await expect(fixture.read()).resolves.toMatchObject({ head, tree, parents: [base] });
    expect(fixture.receipt.sourceStatus).toEqual({
      head,
      bytes: 0,
      totalEntries: 0,
      entries: [],
      omittedEntries: 0,
    });
    fixture.replies.status = "?? private-only.txt\0";
    await expect(fixture.read()).rejects.toMatchObject({ code: "ERR_ASSERTION" });
    expect(fixture.receipt.sourceStatus).toMatchObject({
      totalEntries: 1,
      entries: [],
      omittedEntries: 1,
    });
  });

  it.each(["rev-parse", "cat-file", "ls-tree", "status"])(
    "clears earlier source status before a failed %s recheck",
    async (command) => {
      const fixture = sourceAdmissionFixture("", ["src/edited.ts"]);
      await fixture.read();
      expect(fixture.receipt.sourceStatus).not.toBeNull();
      delete fixture.replies[command];
      await expect(fixture.read()).rejects.toThrow("Git command failed");
      expect(fixture.receipt.sourceStatus).toBeNull();
      expect(JSON.stringify(fixture.receipt)).not.toContain("private");
    },
  );

  it("bounds published source entries and counts names omitted by privacy and size limits", async () => {
    const tracked = Array.from({ length: 34 }, (_, index) => `src/file-${index}.ts`);
    const fixture = sourceAdmissionFixture(
      tracked.map((name) => ` M ${name}\0`).join("") + "?? private-last.txt\0",
      tracked,
    );
    await expect(fixture.read()).rejects.toMatchObject({ code: "ERR_ASSERTION" });
    expect(fixture.receipt.sourceStatus?.entries).toHaveLength(32);
    expect(fixture.receipt.sourceStatus).toMatchObject({ totalEntries: 35, omittedEntries: 3 });
    expect(JSON.stringify(fixture.receipt)).not.toMatch(/file-32|file-33|private/u);
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
    expect(JSON.stringify(fixture.receipt)).not.toMatch(/private|late|é/u);
  });

  it("uses real NUL status without leaking either private additions or a rename destination", async () => {
    const root = dirs.make("desktop-source-status-");
    const git = (args: string[]) =>
      execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
        cwd: root,
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
    git(["init", "--quiet"]);
    await writeFile(path.join(root, "tracked.txt"), "tracked contents\n");
    git(["add", "--", "tracked.txt"]);
    const objectTree = git(["write-tree"]).toString().trim();
    const checkout = git(["commit-tree", objectTree, "-m", "source fixture"]).toString().trim();
    git(["update-ref", "HEAD", checkout]);
    git(["config", "status.renames", "true"]);
    const receipt = { phase: "preflight", sourceStatus: null as DesktopProofSourceStatus | null };
    const check = () =>
      readDesktopProofSource(
        async (label, args) => {
          receipt.phase = label;
          return git(args);
        },
        { checkout },
        (value) => {
          receipt.sourceStatus = value;
        },
      );
    await expect(check()).resolves.toMatchObject({ head: checkout, tree: objectTree });
    await rename(path.join(root, "tracked.txt"), path.join(root, "renamed-private.txt"));
    await writeFile(path.join(root, "staged-private.txt"), "private contents\n");
    git(["add", "--all"]);
    await writeFile(path.join(root, "untracked-private.txt"), "private contents\n");
    await expect(check()).rejects.toMatchObject({ code: "ERR_ASSERTION" });
    expect(receipt).toMatchObject({
      phase: "source-clean",
      sourceStatus: {
        head: checkout,
        totalEntries: 4,
        entries: [{ status: "D ", path: "tracked.txt" }],
        omittedEntries: 3,
      },
    });
    expect(JSON.stringify(receipt)).not.toContain("private");
  });

  it("distinguishes literal head proof from GitHub merge-tree proof", () => {
    expect(
      desktopProofSource({ head, tree, parents: [base] }, { checkout: head, head, base }).kind,
    ).toBe("pr-head");
    expect(
      desktopProofSource(
        { head: merge, tree, parents: [base, head] },
        { checkout: merge, head, base },
      ),
    ).toMatchObject({
      kind: "pr-merge",
      prHead: head,
      prEventBase: base,
      testedBase: base,
      head: merge,
    });
    expect(desktopProofSource({ head, tree, parents: [base] }, { checkout: head }).kind).toBe(
      "checkout",
    );
  });

  it("reads actual merge parents at a depth-one Git boundary without conflating the event base", async () => {
    const root = dirs.make("desktop-shallow-source-");
    const git = (args: string[], input?: string) =>
      execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
        cwd: root,
        input,
        encoding: "utf8",
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
      }).trim();
    git(["init", "--quiet"]);
    const objectTree = git(["mktree"], "");
    const eventBase = git(["commit-tree", objectTree, "-m", "event base"]);
    const testedBase = git(["commit-tree", objectTree, "-p", eventBase, "-m", "tested base"]);
    const prHead = git(["commit-tree", objectTree, "-p", eventBase, "-m", "PR head"]);
    const checkout = git([
      "commit-tree",
      objectTree,
      "-p",
      testedBase,
      "-p",
      prHead,
      "-m",
      "test merge",
    ]);
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

  it("reads only raw commit headers, not signature continuations or the message", () => {
    expect(
      desktopProofCommit(
        merge,
        `tree ${tree}\nparent ${base}\nparent ${head}\ngpgsig signature\n parent ${merge}\n\nparent ${merge}\n`,
      ),
    ).toEqual({ head: merge, tree, parents: [base, head] });
  });

  it.each([[], [base], [base, merge], [base, head, merge]].map((parents) => ({ parents })))(
    "rejects unbound actual merge parents: $parents",
    ({ parents }) => {
      expect(() =>
        desktopProofSource({ head: merge, tree, parents }, { checkout: merge, head, base }),
      ).toThrow();
    },
  );

  it.each([
    { checkout: base, head, base },
    { checkout: merge, head: base, base: head },
    { checkout: merge, head },
  ])("rejects source drift and unbound PR parents: %j", (expected) => {
    expect(() =>
      desktopProofSource({ head: merge, tree, parents: [base, head] }, expected),
    ).toThrow();
  });

  it.each(["node", "ssh"] as const)("exports only named %s facts", (carrier) => {
    const safe = sanitizeDesktopResizeProof(proof(carrier), carrier);
    expect(JSON.stringify(safe)).not.toMatch(/private|hello|token|deviceId/u);
    expect(safe.carrier).toBe(carrier);
    expect(safe.samples).toHaveLength(5);
  });

  it.each([
    { node: null },
    { node: { passwordAbsentFromObserve: true, disconnectClosedViewer: false } },
    { observer: { keyboardForwardedBytes: 1, resizeForwardedBytes: 0 } },
    { gateway: { execution: "built-process", readiness: "readyz", minimal: true } },
    { observer: { evidence: "filter-spy", keyboardForwardedBytes: 0, resizeForwardedBytes: 0 } },
    { samples: [] },
    { pixels: { distinctSampledColors: 8 } },
  ])("rejects incomplete or failed node proof: %j", (invalid) => {
    expect(() => sanitizeDesktopResizeProof({ ...proof(), ...invalid }, "node")).toThrow();
  });

  it("rejects asset paths and non-digests", () => {
    expect(() => desktopProofAssets({ "../index.js": "e".repeat(64) })).toThrow();
    expect(() => desktopProofAssets({ "index.js": "private" })).toThrow();
  });

  it("exports a complete bounded allowlist without raw diagnostics or metadata", async () => {
    const root = dirs.make("desktop-public-proof-");
    const input = path.join(root, "input");
    const output = path.join(root, "public");
    const nested = path.join(input, "desktop-suite");
    await mkdir(nested, { recursive: true });
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
      "base64",
    );
    await writeFile(path.join(nested, "01-fit.png"), png);
    for (const stage of desktopResizeStages) {
      await writeFile(path.join(nested, `${stage}.png`), png);
      await writeFile(
        path.join(nested, `${stage}-geometry.json`),
        JSON.stringify({
          stage,
          expected: size,
          guest: size,
          canvas: size,
          matchOffered: true,
          hello: { token: "private" },
        }),
      );
    }
    await writeFile(path.join(nested, "served-assets.json"), JSON.stringify(assets));
    await writeFile(path.join(nested, "resize-proof.json"), JSON.stringify(proof()));
    await writeFile(path.join(nested, "connection-diagnostics.json"), "private-token");
    expect((await exportDesktopResizeProof(input, output, "node")).complete).toBe(true);
    expect(await readdir(output)).toHaveLength(13);
    expect(await readFile(path.join(output, "resize-proof.json"), "utf8")).not.toMatch(
      /private|hello|deviceId/u,
    );
    expect(await readFile(path.join(output, "02-panel-geometry.json"), "utf8")).not.toContain(
      "hello",
    );
  });

  it("does not turn a skipped test into completed proof", async () => {
    const root = dirs.make("desktop-empty-proof-");
    const input = path.join(root, "input");
    await mkdir(input);
    expect((await exportDesktopResizeProof(input, path.join(root, "public"), "ssh")).complete).toBe(
      false,
    );
  });

  it("rejects symlinks instead of publishing their targets", async () => {
    const root = dirs.make("desktop-symlink-proof-");
    const input = path.join(root, "input");
    await mkdir(input);
    await writeFile(path.join(root, "secret"), "private-token");
    await symlink(path.join(root, "secret"), path.join(input, "resize-proof.json"));
    await expect(
      exportDesktopResizeProof(input, path.join(root, "public"), "node"),
    ).rejects.toThrow("regular-file");
  });
});
