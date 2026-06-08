// Gateway CLI coverage tests cover gateway command branches and output modes.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withEnvOverride } from "../config/test-helpers.js";
import { GatewayLockError } from "../infra/gateway-lock.js";
import { registerGatewayCli } from "./gateway-cli.js";

type DiscoveredBeacon = Awaited<
  ReturnType<typeof import("../infra/bonjour-discovery.js").discoverGatewayBeacons>
>[number];

const callGateway = vi.fn<(opts: unknown) => Promise<unknown>>(async () => ({ ok: true }));
const formatGatewayTransportErrorJson = vi.fn();
const startGatewayServer = vi.fn<
  (port: number, opts?: unknown) => Promise<{ close: () => Promise<void> }>
>(async () => ({
  close: vi.fn(async () => {}),
}));
const setVerbose = vi.fn();
const forceFreePortAndWait = vi.fn<
  (port: number) => Promise<{ killed: unknown[]; waitedMs: number; escalatedToSigkill: boolean }>
>(async () => ({
  killed: [],
  waitedMs: 0,
  escalatedToSigkill: false,
}));
const serviceIsLoaded = vi.fn().mockResolvedValue(true);
const discoverGatewayBeacons = vi.fn<(opts: unknown) => Promise<DiscoveredBeacon[]>>(
  async () => [],
);
const gatewayStatusCommand = vi.fn<(opts: unknown) => Promise<void>>(async () => {});
const inspectPortUsage = vi.fn(async (_port: number) => ({ status: "free" as const }));
const formatPortDiagnostics = vi.fn((_diagnostics: unknown) => [] as string[]);

const mocks = await vi.hoisted(async () => {
  const { createCliRuntimeMock } = await import("./test-runtime-mock.js");
  return createCliRuntimeMock(vi);
});

const { runtimeLogs, runtimeErrors, defaultRuntime } = mocks;

vi.mock(
  new URL("../../gateway/call.ts", new URL("./gateway-cli/call.ts", import.meta.url)).href,
  () => ({
    callGateway: (opts: unknown) => callGateway(opts),
    formatGatewayTransportErrorJson: (error: unknown) => formatGatewayTransportErrorJson(error),
    randomIdempotencyKey: () => "rk_test",
  }),
);

vi.mock("../gateway/server.js", () => ({
  startGatewayServer: (port: number, opts?: unknown) => startGatewayServer(port, opts),
}));

vi.mock("../globals.js", () => ({
  info: (msg: string) => msg,
  isVerbose: () => false,
  setVerbose: (enabled: boolean) => setVerbose(enabled),
}));

vi.mock("../runtime.js", async () => ({
  ...(await vi.importActual<typeof import("../runtime.js")>("../runtime.js")),
  defaultRuntime: mocks.defaultRuntime,
}));

vi.mock("./ports.js", () => ({
  forceFreePortAndWait: (port: number) => forceFreePortAndWait(port),
}));

vi.mock("../daemon/service.js", () => ({
  resolveGatewayService: () => ({
    label: "LaunchAgent",
    loadedText: "loaded",
    notLoadedText: "not loaded",
    stage: vi.fn(),
    install: vi.fn(),
    uninstall: vi.fn(),
    stop: vi.fn(),
    restart: vi.fn(),
    isLoaded: serviceIsLoaded,
    readCommand: vi.fn(),
    readRuntime: vi.fn().mockResolvedValue({ status: "running" }),
  }),
}));

vi.mock("../daemon/program-args.js", () => ({
  resolveGatewayProgramArguments: async () => ({
    programArguments: ["/bin/node", "cli", "gateway", "--port", "18789"],
  }),
}));

vi.mock("../infra/bonjour-discovery.js", async () => ({
  ...(await vi.importActual<typeof import("../infra/bonjour-discovery.js")>(
    "../infra/bonjour-discovery.js",
  )),
  discoverGatewayBeacons: (opts: unknown) => discoverGatewayBeacons(opts),
}));

vi.mock("../commands/gateway-status.js", () => ({
  gatewayStatusCommand: (opts: unknown) => gatewayStatusCommand(opts),
}));

vi.mock("../infra/ports.js", () => ({
  inspectPortUsage: (port: number) => inspectPortUsage(port),
  formatPortDiagnostics: (diagnostics: unknown) => formatPortDiagnostics(diagnostics),
}));

let gatewayProgram: Command;

function createGatewayProgram() {
  const program = new Command();
  program.exitOverride();
  registerGatewayCli(program);
  return program;
}

async function runGatewayCommand(args: string[]) {
  await gatewayProgram.parseAsync(args, { from: "user" });
}

async function expectGatewayExit(args: string[]) {
  await expect(runGatewayCommand(args)).rejects.toThrow("__exit__:1");
}

function firstMockArg(mock: { mock: { calls: ReadonlyArray<ReadonlyArray<unknown>> } }): unknown {
  const call = mock.mock.calls[0];
  if (!call) {
    throw new Error("expected mock to have at least one call");
  }
  return call[0];
}

describe("gateway-cli coverage", () => {
  beforeEach(() => {
    gatewayProgram = createGatewayProgram();
    runtimeLogs.length = 0;
    runtimeErrors.length = 0;
    defaultRuntime.log.mockClear();
    defaultRuntime.error.mockClear();
    defaultRuntime.writeStdout.mockClear();
    defaultRuntime.writeJson.mockClear();
    defaultRuntime.exit.mockClear();
    startGatewayServer.mockClear();
    inspectPortUsage.mockClear();
    formatPortDiagnostics.mockClear();
    formatGatewayTransportErrorJson.mockReset();
    formatGatewayTransportErrorJson.mockReturnValue(null);
  });

  it("registers call/health commands and routes to callGateway", async () => {
    callGateway.mockClear();

    await runGatewayCommand(["gateway", "call", "health", "--params", '{"x":1}', "--json"]);

    expect(callGateway).toHaveBeenCalledTimes(1);
    expect(runtimeLogs.join("\n")).toContain('"ok": true');
  });

  it("registers gateway probe and routes to gatewayStatusCommand", async () => {
    gatewayStatusCommand.mockClear();

    await runGatewayCommand(["gateway", "probe", "--json"]);

    expect(gatewayStatusCommand).toHaveBeenCalledTimes(1);
  });

  it("registers gateway stability and routes to diagnostics RPC", async () => {
    callGateway.mockClear();

    await runGatewayCommand([
      "gateway",
      "stability",
      "--limit",
      "5",
      "--type",
      "payload.large",
      "--json",
    ]);

    expect(callGateway).toHaveBeenCalledTimes(1);
    const stabilityCall = firstMockArg(callGateway) as { method?: string; params?: unknown };
    expect(stabilityCall?.method).toBe("diagnostics.stability");
    expect(stabilityCall?.params).toEqual({
      limit: 5,
      type: "payload.large",
    });
  });

  it("prints channel turn delivery SLA failures in gateway stability output", async () => {
    callGateway.mockClear();
    callGateway.mockResolvedValueOnce({
      generatedAt: "2026-06-03T12:00:00.000Z",
      capacity: 1000,
      count: 4,
      dropped: 0,
      firstSeq: 1,
      lastSeq: 4,
      events: [
        {
          seq: 4,
          ts: Date.parse("2026-06-03T12:00:03.000Z"),
          type: "channel.turn.event",
          channel: "telegram",
          turnId: "turn-test",
          messageId: "msg-test",
          action: "delivery.failed",
          reason: "missing_visible_delivery",
          visibleDeliveryRequired: true,
          visibleDeliverySent: false,
          completionAllowed: false,
          receivedToTurnStartMs: 12_000,
        },
      ],
      summary: {
        byType: { "channel.turn.event": 4 },
        sessions: {
          attention: {
            longRunning: 0,
            stalled: 1,
            stuck: 0,
            recoveryRequested: 0,
            recoveryCompleted: 0,
            byClassification: {
              blocked_tool_call: 1,
            },
            byActiveWorkKind: {
              tool_call: 1,
            },
            recent: [
              {
                seq: 3,
                ts: Date.parse("2026-06-03T12:00:02.000Z"),
                type: "session.stalled",
                sessionKey: "agent:main:telegram:direct:owner",
                state: "processing",
                reason: "blocked_tool_call",
                classification: "blocked_tool_call",
                activeWorkKind: "tool_call",
                toolName: "home_assistant",
                ageMs: 90_000,
                queueDepth: 1,
              },
            ],
          },
        },
        queues: {
          enqueued: 2,
          dequeued: 2,
          slowDequeues: 1,
          maxWaitMs: 12_500,
          maxQueueSize: 3,
          byLane: {
            session: {
              enqueued: 1,
              dequeued: 1,
              slowDequeues: 1,
              maxWaitMs: 12_500,
              maxQueueSize: 3,
            },
            main: {
              enqueued: 1,
              dequeued: 1,
              slowDequeues: 0,
              maxWaitMs: 250,
              maxQueueSize: 1,
            },
          },
          recentSlow: [
            {
              seq: 2,
              ts: Date.parse("2026-06-03T12:00:01.000Z"),
              lane: "session",
              waitMs: 12_500,
              queueSize: 2,
            },
          ],
        },
        recommendations: [
          {
            code: "inspect_missing_delivery",
            priority: "high",
            source: "channel_turns",
            reason: "missing_visible_delivery",
            count: 1,
            guidance:
              "Inspect the visible channel dispatch path; direct DMs must record delivery.sent before the turn is considered healthy.",
          },
          {
            code: "clear_queue_pressure",
            priority: "medium",
            source: "queues",
            reason: "slow_queue_dequeue",
            metric: "waitMs",
            valueMs: 12_500,
            count: 1,
            guidance:
              "Inspect queue/session pressure, stale work, and overlapping background jobs; direct control messages should not wait behind long work.",
          },
        ],
        controlLane: {
          status: "degraded",
          reasons: ["missing_visible_delivery", "queue_pressure", "blocked_tool_call"],
          deliveryRequired: 1,
          deliverySent: 0,
          deliveryFailed: 1,
          missingVisibleDelivery: 1,
          slowIngress: 0,
          slowQueue: 1,
          slowVisibleDelivery: 0,
          slowPreDeliveryTools: 0,
          blockedSessions: 1,
          stuckSessions: 0,
          maxQueueWaitMs: 12_500,
          maxReceiveToStartMs: 12_000,
          maxStartToDeliveryMs: 2_500,
          guidance:
            "Direct-control lane is degraded; inspect delivery, queue/session pressure, or blocked tools before treating physical-control turns as healthy.",
        },
        channelTurns: {
          totalEvents: 4,
          deliveryRequired: 1,
          deliverySent: 0,
          deliveryFailed: 1,
          invalidCompletions: 1,
          missingVisibleDelivery: 1,
          byChannel: {
            telegram: {
              deliveryRequired: 1,
              deliverySent: 0,
              deliveryFailed: 1,
              invalidCompletions: 1,
              missingVisibleDelivery: 1,
            },
          },
          recentFailures: [
            {
              seq: 4,
              ts: Date.parse("2026-06-03T12:00:03.000Z"),
              channel: "telegram",
              turnId: "turn-test",
              messageId: "msg-test",
              reason: "missing_visible_delivery",
            },
          ],
          latency: {
            receivedToTurnStartMs: {
              count: 1,
              slowCount: 1,
              latestMs: 12_000,
              maxMs: 12_000,
              p95Ms: 12_000,
            },
            startToDeliveryMs: {
              count: 1,
              slowCount: 0,
              latestMs: 2_500,
              maxMs: 2_500,
              p95Ms: 2_500,
            },
            bottleneck: {
              phase: "queue",
              metric: "receivedToTurnStartMs",
              maxMs: 12_000,
              slowCount: 1,
              count: 1,
            },
            recentSlow: [
              {
                seq: 4,
                ts: Date.parse("2026-06-03T12:00:03.000Z"),
                channel: "telegram",
                turnId: "turn-test",
                messageId: "msg-test",
                metric: "receivedToTurnStartMs",
                valueMs: 12_000,
              },
            ],
          },
          health: {
            status: "degraded",
            issues: [
              {
                code: "missing_visible_delivery",
                level: "degraded",
                message: "Direct channel turn required a visible reply but none was recorded.",
                count: 1,
                guidance:
                  "Treat direct DM delivery as unhealthy; inspect message(action=send) dispatch before declaring the turn complete.",
              },
              {
                code: "slow_receive_to_turn_start",
                level: "warning",
                message: "A received channel message waited too long before a turn started.",
                metric: "receivedToTurnStartMs",
                valueMs: 12_000,
                count: 1,
                guidance:
                  "Inspect queue/session pressure and background work; direct control messages should get a fast turn or cancellation path.",
              },
            ],
          },
        },
      },
    });

    await runGatewayCommand(["gateway", "stability"]);

    const output = runtimeLogs.join("\n");
    expect(output).toContain("Channel turns");
    expect(output).toContain("required=1");
    expect(output).toContain("failed=1");
    expect(output).toContain("missingVisible=1");
    expect(output).toContain("health=degraded");
    expect(output).toContain("telegram=required:1/sent:0/failed:1/missing:1");
    expect(output).toContain("Health issues:");
    expect(output).toContain("degraded:missing_visible_delivery");
    expect(output).toContain("warning:slow_receive_to_turn_start");
    expect(output).toContain(
      "warning:slow_receive_to_turn_start receivedToTurnStartMs=12000ms count=1",
    );
    expect(output).toContain("Latency:");
    expect(output).toContain(
      "Latency bottleneck: phase=queue metric=receivedToTurnStartMs max=12000ms slow=1/1",
    );
    expect(output).toContain("receivedToStart latest:12000ms/max:12000ms/p95:12000ms/slow:1/1");
    expect(output).toContain("receivedToTurnStartMs=12000ms");
    expect(output).toContain("receivedToStart=12000ms");
    expect(output).toContain("reason=missing_visible_delivery");
    expect(output).toContain(
      "Session attention: longRunning=0 stalled=1 stuck=0 recoveryRequested=0 recoveryCompleted=0",
    );
    expect(output).toContain("Classifications: blocked_tool_call:1");
    expect(output).toContain("Active work: tool_call:1");
    expect(output).toContain(
      "session.stalled session=agent:main:telegram:direct:owner classification=blocked_tool_call reason=blocked_tool_call activeWork=tool_call tool=home_assistant age=90000ms queueDepth=1",
    );
    expect(output).toContain("Queues: enqueued=2 dequeued=2 slow=1 maxWait=12500ms maxQueue=3");
    expect(output).toContain("session=enq:1/deq:1/slow:1/maxWait:12500ms/maxQueue:3");
    expect(output).toContain("main=enq:1/deq:1/slow:0/maxWait:250ms/maxQueue:1");
    expect(output).toContain("Recent slow queue waits:");
    expect(output).toContain("lane=session wait=12500ms queueSize=2");
    expect(output).toContain("Control lane: status=degraded");
    expect(output).toContain(
      "Reasons: missing_visible_delivery, queue_pressure, blocked_tool_call",
    );
    expect(output).toContain(
      "Metrics: maxQueueWait=12500ms, maxReceiveToStart=12000ms, maxStartToDelivery=2500ms",
    );
    expect(output).toContain("Runtime recommendations:");
    expect(output).toContain("high:inspect_missing_delivery source=channel_turns");
    expect(output).toContain(
      "medium:clear_queue_pressure source=queues reason=slow_queue_dequeue metric=waitMs value=12500ms count=1",
    );
    expect(output).not.toContain("chat text");
  });

  it("writes JSON for gateway health transport failures in JSON mode", async () => {
    const error = new Error("gateway closed (1006)");
    const payload = {
      ok: false,
      error: {
        type: "gateway_transport_error",
        kind: "closed",
        message: "gateway closed (1006)",
      },
      gateway: {
        url: "ws://127.0.0.1:18789",
        urlSource: "local loopback",
      },
    };
    callGateway.mockRejectedValueOnce(error);
    formatGatewayTransportErrorJson.mockReturnValueOnce(payload);

    await expectGatewayExit(["gateway", "health", "--json"]);

    expect(formatGatewayTransportErrorJson).toHaveBeenCalledWith(error);
    expect(defaultRuntime.writeJson).toHaveBeenCalledWith(payload);
    expect(runtimeErrors.join("\n")).not.toContain("gateway closed");
  });

  it("prints the latest stability bundle without calling Gateway", async () => {
    callGateway.mockClear();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-gateway-cli-bundle-"));
    try {
      const bundleDir = path.join(tempDir, "logs", "stability");
      const bundlePath = path.join(
        bundleDir,
        "openclaw-stability-2026-04-22T12-00-00-000Z-123-test.json",
      );
      const bundle = {
        version: 1,
        generatedAt: "2026-04-22T12:00:00.000Z",
        reason: "gateway.restart_startup_failed",
        process: {
          pid: 123,
          platform: process.platform,
          arch: process.arch,
          node: process.versions.node,
          uptimeMs: 2000,
        },
        host: { hostname: "test-host" },
        evidence: {
          memoryPressure: {
            level: "critical",
            reason: "rss_threshold",
            memory: {
              rssBytes: 4096,
              heapTotalBytes: 2048,
              heapUsedBytes: 1536,
              externalBytes: 128,
              arrayBuffersBytes: 64,
            },
            thresholdBytes: 3000,
            heapStatistics: {
              totalHeapSizeBytes: 2048,
              totalHeapSizeExecutableBytes: 256,
              totalPhysicalSizeBytes: 2048,
              totalAvailableSizeBytes: 8192,
              usedHeapSizeBytes: 1536,
              heapSizeLimitBytes: 4096,
              mallocedMemoryBytes: 32,
              externalMemoryBytes: 128,
            },
            activeResources: {
              total: 2,
              byType: { Timeout: 2 },
            },
            topSessionFiles: [
              {
                relativePath: "agents/<agent>/sessions/<session>.jsonl",
                sizeBytes: 4096,
                mtimeMs: Date.parse("2026-04-22T12:00:00.000Z"),
              },
            ],
          },
        },
        snapshot: {
          generatedAt: "2026-04-22T12:00:00.000Z",
          capacity: 1000,
          count: 1,
          dropped: 0,
          firstSeq: 1,
          lastSeq: 1,
          events: [
            {
              seq: 1,
              ts: Date.parse("2026-04-22T12:00:00.000Z"),
              type: "payload.large",
              surface: "gateway.http.json",
              action: "rejected",
              bytes: 2048,
              limitBytes: 1024,
            },
          ],
          summary: {
            byType: { "payload.large": 1 },
            payloadLarge: {
              count: 1,
              rejected: 1,
              truncated: 0,
              chunked: 0,
              bySurface: { "gateway.http.json": 1 },
            },
          },
        },
      };
      fs.mkdirSync(bundleDir, { recursive: true });
      fs.writeFileSync(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");

      await withEnvOverride({ OPENCLAW_STATE_DIR: tempDir }, async () => {
        await runGatewayCommand(["gateway", "stability", "--bundle", "latest"]);
      });

      const output = runtimeLogs.join("\n");
      expect(callGateway).not.toHaveBeenCalled();
      expect(output).toContain("Stability bundle");
      expect(output).toContain("gateway.restart_startup_failed");
      expect(output).toContain("Memory pressure");
      expect(output).toContain("rss_threshold");
      expect(output).toContain("Largest session files");
      expect(output).toContain("agents/<agent>/sessions/<session>.jsonl");
      expect(output).toContain("payload.large");
      expect(output).toContain("gateway.http.json");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("writes gateway diagnostics export with a best-effort health snapshot", async () => {
    callGateway.mockClear();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-gateway-cli-support-"));
    try {
      const outputPath = path.join(tempDir, "diagnostics.zip");
      await withEnvOverride(
        { OPENCLAW_STATE_DIR: tempDir, OPENCLAW_TEST_FILE_LOG: undefined },
        async () => {
          await runGatewayCommand([
            "gateway",
            "diagnostics",
            "export",
            "--output",
            outputPath,
            "--json",
          ]);
        },
      );

      expect(callGateway).toHaveBeenCalledTimes(1);
      const healthCall = firstMockArg(callGateway) as { method?: string; timeoutMs?: number };
      expect(healthCall?.method).toBe("health");
      expect(healthCall?.timeoutMs).toBe(3000);
      expect(fs.existsSync(outputPath)).toBe(true);
      const output = runtimeLogs.join("\n");
      expect(output).toContain('"path"');
      expect(output).toContain("diagnostics.zip");
      expect(output).toContain('"payloadFree": true');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it.each([
    ["--log-lines", "5000x"],
    ["--log-bytes", "1mb"],
  ])("rejects partial gateway diagnostics export %s", async (flag, value) => {
    callGateway.mockClear();

    await expectGatewayExit(["gateway", "diagnostics", "export", flag, value, "--json"]);

    expect(runtimeErrors.join("\n")).toContain(`${flag} must be a positive integer`);
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("registers gateway discover and prints json output", async () => {
    discoverGatewayBeacons.mockClear();
    discoverGatewayBeacons.mockResolvedValueOnce([
      {
        instanceName: "Studio (OpenClaw)",
        displayName: "Studio",
        domain: "openclaw.internal.",
        host: "studio.openclaw.internal",
        port: 18789,
        lanHost: "studio.local",
        tailnetDns: "studio.tailnet.ts.net",
        gatewayPort: 18789,
        sshPort: 22,
      },
    ]);

    await runGatewayCommand(["gateway", "discover", "--json"]);

    expect(discoverGatewayBeacons).toHaveBeenCalledTimes(1);
    const out = runtimeLogs.join("\n");
    expect(out).toContain('"beacons"');
    expect(out).toContain("ws://");
  });

  it("validates gateway discover timeout", async () => {
    discoverGatewayBeacons.mockClear();
    await expectGatewayExit(["gateway", "discover", "--timeout", "0"]);

    expect(runtimeErrors.join("\n")).toContain("gateway discover failed:");
    expect(discoverGatewayBeacons).not.toHaveBeenCalled();
  });

  it("fails gateway call on invalid params JSON", async () => {
    callGateway.mockClear();
    await expectGatewayExit(["gateway", "call", "status", "--params", "not-json"]);

    expect(callGateway).not.toHaveBeenCalled();
    expect(runtimeErrors.join("\n")).toContain("Gateway call failed:");
  });

  it("validates gateway call timeout before opening a transport", async () => {
    callGateway.mockClear();
    await expectGatewayExit(["gateway", "call", "health", "--timeout", "nope", "--json"]);

    expect(callGateway).not.toHaveBeenCalled();
    expect(runtimeErrors.join("\n")).toContain("Invalid --timeout");
  });

  it("validates gateway ports before starting", async () => {
    await expectGatewayExit(["gateway", "--port", "0", "--token", "test-token"]);
  });

  it("reports force-free port failures", async () => {
    forceFreePortAndWait.mockImplementationOnce(async () => {
      throw new Error("boom");
    });
    await expectGatewayExit([
      "gateway",
      "--port",
      "18789",
      "--token",
      "test-token",
      "--force",
      "--allow-unconfigured",
    ]);
  });

  it("reports gateway start failures without leaking signal listeners", async () => {
    startGatewayServer.mockRejectedValueOnce(new Error("nope"));
    const beforeSigterm = new Set(process.listeners("SIGTERM"));
    const beforeSigint = new Set(process.listeners("SIGINT"));
    await expectGatewayExit([
      "gateway",
      "--port",
      "18789",
      "--token",
      "test-token",
      "--allow-unconfigured",
    ]);
    for (const listener of process.listeners("SIGTERM")) {
      if (!beforeSigterm.has(listener)) {
        process.removeListener("SIGTERM", listener);
      }
    }
    for (const listener of process.listeners("SIGINT")) {
      if (!beforeSigint.has(listener)) {
        process.removeListener("SIGINT", listener);
      }
    }
  });

  it("prints stop hints on GatewayLockError when service is loaded", async () => {
    await withEnvOverride(
      {
        LAUNCH_JOB_LABEL: undefined,
        LAUNCH_JOB_NAME: undefined,
        XPC_SERVICE_NAME: undefined,
        OPENCLAW_LAUNCHD_LABEL: undefined,
        OPENCLAW_SYSTEMD_UNIT: undefined,
        INVOCATION_ID: undefined,
        SYSTEMD_EXEC_PID: undefined,
        JOURNAL_STREAM: undefined,
        OPENCLAW_WINDOWS_TASK_NAME: undefined,
        OPENCLAW_SERVICE_MARKER: undefined,
        OPENCLAW_SERVICE_KIND: undefined,
      },
      async () => {
        serviceIsLoaded.mockResolvedValue(true);
        startGatewayServer.mockRejectedValueOnce(
          new GatewayLockError("another gateway instance is already listening"),
        );
        await expect(
          runGatewayCommand(["gateway", "--token", "test-token", "--allow-unconfigured"]),
        ).rejects.toThrow("__exit__:0");

        expect(startGatewayServer).toHaveBeenCalledTimes(1);
        expect(runtimeErrors.join("\n")).toContain("Gateway failed to start:");
        expect(runtimeErrors.join("\n")).toContain("gateway stop");
      },
    );
  });

  it("keeps exit 1 for gateway bind failures wrapped as GatewayLockError", async () => {
    runtimeLogs.length = 0;
    runtimeErrors.length = 0;
    serviceIsLoaded.mockResolvedValue(true);
    startGatewayServer.mockRejectedValueOnce(
      new GatewayLockError("failed to bind gateway socket on ws://127.0.0.1:18789: Error: boom"),
    );

    await expectGatewayExit(["gateway", "--token", "test-token", "--allow-unconfigured"]);

    expect(runtimeErrors.join("\n")).toContain("failed to bind gateway socket");
  });

  it("keeps exit 1 for gateway lock acquisition failures", async () => {
    runtimeLogs.length = 0;
    runtimeErrors.length = 0;
    serviceIsLoaded.mockResolvedValue(true);
    startGatewayServer.mockRejectedValueOnce(
      new GatewayLockError("failed to acquire gateway lock at /tmp/openclaw/gateway.lock"),
    );

    await expectGatewayExit(["gateway", "--token", "test-token", "--allow-unconfigured"]);

    expect(runtimeErrors.join("\n")).toContain("failed to acquire gateway lock");
  });

  it("uses env/config port when --port is omitted", async () => {
    await withEnvOverride({ OPENCLAW_GATEWAY_PORT: "19001" }, async () => {
      runtimeLogs.length = 0;
      runtimeErrors.length = 0;
      startGatewayServer.mockClear();

      startGatewayServer.mockRejectedValueOnce(new Error("nope"));
      await expectGatewayExit(["gateway", "--token", "test-token", "--allow-unconfigured"]);

      expect(startGatewayServer).toHaveBeenCalledTimes(1);
      const startCall = startGatewayServer.mock.calls[0];
      expect(startCall?.[0]).toBe(19001);
      expect(typeof startCall?.[1]).toBe("object");
    });
  });
});
