import "../test-utils/prepare-compiled-subprocesses.js";
import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createEmptyCostUsageTotals } from "../infra/session-cost-usage-totals.js";
import type { CostUsageSummary } from "../infra/session-cost-usage.js";
import { withEnvAsync } from "../test-utils/env.js";
import { registerGatewayCli } from "./gateway-cli.js";

type DiscoveredBeacon = Awaited<
  ReturnType<typeof import("../infra/bonjour-discovery.js").discoverGatewayBeacons>
>[number];
const defaultCallGateway = async (): Promise<unknown> => ({ ok: true });
const callGateway = vi.fn<(opts: unknown) => Promise<unknown>>(defaultCallGateway);
const formatGatewayAuthErrorJson = vi.fn();
const formatGatewayClientRequestErrorJson = vi.fn();
const formatGatewayTransportErrorJson = vi.fn();
const setVerbose = vi.fn();
const discoverGatewayBeacons = vi.fn<(opts: unknown) => Promise<DiscoveredBeacon[]>>(
  async () => [],
);
const gatewayStatusCommand = vi.fn<(opts: unknown) => Promise<void>>(async () => {});

const mocks = await vi.hoisted(async () => {
  const { createCliRuntimeMock } = await import("./test-runtime-mock.js");
  return createCliRuntimeMock(vi);
});

const { runtimeLogs, runtimeErrors, defaultRuntime } = mocks;

vi.mock(
  new URL("../../gateway/call.ts", new URL("./gateway-cli/call.ts", import.meta.url)).href,
  () => ({
    buildGatewayConnectionDetails: () => ({
      message: "Gateway mode: local\nGateway target: ws://127.0.0.1:18789",
      url: "ws://127.0.0.1:18789",
    }),
    buildGatewayProbeConnectionDetails: () => ({
      preauthHandshakeTimeoutMs: 1000,
      tlsFingerprint: undefined,
      url: "ws://127.0.0.1:18789",
    }),
    callGateway: (opts: unknown) => callGateway(opts),
    formatGatewayAuthErrorJson: (error: unknown) => formatGatewayAuthErrorJson(error),
    formatGatewayClientRequestErrorJson: (error: unknown) =>
      formatGatewayClientRequestErrorJson(error),
    formatGatewayTransportErrorJson: (error: unknown) => formatGatewayTransportErrorJson(error),
    isGatewayCredentialsRequiredError: () => false,
    randomIdempotencyKey: () => "rk_test",
  }),
);

vi.mock("../globals.js", () => ({
  info: (msg: string) => msg,
  isVerbose: () => false,
  setVerbose: (enabled: boolean) => setVerbose(enabled),
}));

vi.mock("../runtime.js", async () => ({
  ...(await vi.importActual<typeof import("../runtime.js")>("../runtime.js")),
  defaultRuntime: mocks.defaultRuntime,
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
    isLoaded: vi.fn().mockResolvedValue(true),
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

let gatewayProgram: Command;

function createGatewayProgram() {
  const program = new Command();
  program.exitOverride();
  registerGatewayCli(program);
  return program;
}

async function runGatewayCommand(args: string[]) {
  await gatewayProgram.parseAsync(["gateway", ...args], { from: "user" });
}

async function expectGatewayExit(args: string[]) {
  await expect(runGatewayCommand(args)).rejects.toThrow("__exit__:1");
}

function expectGatewayCall(expected: Record<string, unknown>) {
  expect(callGateway).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(expected));
}

async function expectJsonValidationFailure(args: string[], message: unknown) {
  await expectGatewayExit([...args, "--json"]);
  expect(callGateway).not.toHaveBeenCalled();
  expect(defaultRuntime.writeJson).toHaveBeenCalledWith({
    ok: false,
    error: { type: "cli_error", message },
  });
  expect(runtimeErrors).toHaveLength(0);
}

describe("gateway-cli coverage", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  beforeEach(() => {
    gatewayProgram = createGatewayProgram();
    callGateway.mockReset();
    callGateway.mockImplementation(defaultCallGateway);
    runtimeLogs.length = 0;
    runtimeErrors.length = 0;
    for (const mock of Object.values(defaultRuntime)) {
      mock.mockClear();
    }
    for (const mock of [
      formatGatewayAuthErrorJson,
      formatGatewayClientRequestErrorJson,
      formatGatewayTransportErrorJson,
    ]) {
      mock.mockReset().mockReturnValue(null);
    }
  });

  it("registers call/health commands and routes to callGateway", async () => {
    await runGatewayCommand(["call", "health", "--params", '{"x":1}', "--json"]);

    expect(callGateway).toHaveBeenCalledTimes(1);
    expect(runtimeLogs.join("\n")).toContain('"ok": true');
  });

  it("renders gateway request failures without the client error class in human mode", async () => {
    const error = Object.assign(new Error("invalid audit.activity.list params"), {
      name: "GatewayClientRequestError",
      gatewayCode: "INVALID_REQUEST",
    });
    callGateway.mockRejectedValueOnce(error);

    await expectGatewayExit(["call", "audit.activity.list"]);

    expect(runtimeErrors.join("\n")).toContain("invalid audit.activity.list params");
    expect(runtimeErrors.join("\n")).not.toContain("GatewayClientRequestError");
  });

  it("registers gateway probe and routes to gatewayStatusCommand", async () => {
    gatewayStatusCommand.mockClear();

    await runGatewayCommand(["probe", "--json"]);

    expect(gatewayStatusCommand).toHaveBeenCalledTimes(1);
  });

  it("registers gateway stability and routes to diagnostics RPC", async () => {
    await runGatewayCommand(["stability", "--limit", "5", "--type", "payload.large", "--json"]);

    expectGatewayCall({
      method: "diagnostics.stability",
      localPortOverride: undefined,
      params: { limit: 5, type: "payload.large" },
    });
  });

  it("scopes usage-cost to a specific agent via --agent", async () => {
    await runGatewayCommand(["usage-cost", "--agent", "alpha", "--days", "7", "--json"]);

    expectGatewayCall({ method: "usage.cost", params: { days: 7, agentId: "alpha" } });
  });

  it("prints the provider/model breakdown for missing costs", async () => {
    callGateway.mockResolvedValue({
      updatedAt: 1,
      days: 7,
      daily: [],
      totals: {
        ...createEmptyCostUsageTotals(),
        input: 12,
        totalTokens: 12,
        missingCostEntries: 12,
        missingCostByModel: {
          "openai/gpt-5.6-sol": 10,
          "openai-codex/gpt-5.5": 2,
        },
      },
      cacheStatus: { status: "fresh", cachedFiles: 1, pendingFiles: 0, staleFiles: 0 },
    });

    await runGatewayCommand(["usage-cost", "--days", "7"]);

    expect(runtimeLogs.join("\n")).toContain(
      "Missing cost: 12 (openai/gpt-5.6-sol 10, openai-codex/gpt-5.5 2)",
    );
  });

  it("preserves the first unavailable partial usage-cost result", async () => {
    const totals: CostUsageSummary["totals"] = {
      ...createEmptyCostUsageTotals(),
      input: 100,
      totalTokens: 100,
      totalCost: 0.1,
      inputCost: 0.1,
      usageReport: { state: "unavailable" },
    };
    const summary: CostUsageSummary = {
      updatedAt: 1,
      days: 7,
      daily: [{ date: "2026-09-01", ...totals }],
      totals,
      cacheStatus: { status: "partial", cachedFiles: 1, pendingFiles: 2, staleFiles: 2 },
    };
    callGateway.mockResolvedValue(summary);

    await runGatewayCommand(["usage-cost", "--all-agents", "--days", "7"]);

    expectGatewayCall({
      method: "usage.cost",
      params: { days: 7, agentScope: "all" },
      timeoutMs: 10_000,
    });
    const output = runtimeLogs.join("\n");
    const figures = "unavailable (known subtotal: $0.10 · 100 tokens)";
    expect(output).toContain(`Latest day: 2026-09-01 · ${figures}`);
    expect(output).toContain(
      `Usage totals may be incomplete (partial). Run this command again later.\nTotal: ${figures}`,
    );
  });

  it.each([
    {
      args: ["usage-cost", "--agent", "alpha", "--all-agents"],
      message: "Use --agent or --all-agents, not both",
    },
    { args: ["usage-cost", "--days", "7d"], message: expect.stringContaining("Invalid --days") },
    { args: ["health", "--timeout", "abc"], message: expect.stringContaining("Invalid --timeout") },
    {
      args: ["call", "system-presence", "--params", "not-json"],
      message: "--params must be valid JSON.",
    },
  ])("rejects invalid $args before calling Gateway", async ({ args, message }) => {
    await expectJsonValidationFailure(args, message);
  });

  it.each([
    {
      command: "health",
      reject: callGateway,
      format: formatGatewayTransportErrorJson,
      error: new Error("gateway closed (1006)"),
      detail: { type: "gateway_transport_error", kind: "closed", message: "gateway closed (1006)" },
      suppressed: "gateway closed",
    },
    {
      command: "stability",
      reject: callGateway,
      format: formatGatewayClientRequestErrorJson,
      error: Object.assign(new Error("unauthorized role: operator"), {
        name: "GatewayClientRequestError",
        gatewayCode: "INVALID_REQUEST",
      }),
      detail: {
        type: "gateway_request_error",
        code: "INVALID_REQUEST",
        message: "unauthorized role: operator",
        retryable: false,
      },
      suppressed: "unauthorized role",
    },
    {
      command: "discover",
      reject: discoverGatewayBeacons,
      format: formatGatewayTransportErrorJson,
      error: new Error("gateway transport unavailable"),
      detail: {
        type: "gateway_transport_error",
        kind: "closed",
        message: "gateway transport unavailable",
      },
      suppressed: undefined,
    },
  ])(
    "writes gateway $command failures as JSON",
    async ({ command, reject, format, error, detail, suppressed }) => {
      const payload = {
        ok: false,
        error: detail,
        ...(command === "health"
          ? { gateway: { url: "ws://127.0.0.1:18789", urlSource: "local loopback" } }
          : {}),
      };
      reject.mockRejectedValueOnce(error);
      format.mockReturnValueOnce(payload);
      await expectGatewayExit([command, "--json"]);
      expect(format).toHaveBeenCalledWith(error);
      expect(defaultRuntime.writeJson).toHaveBeenCalledWith(payload);
      if (suppressed) {
        expect(runtimeErrors.join("\n")).not.toContain(suppressed);
      } else {
        expect(runtimeErrors).toHaveLength(0);
      }
    },
  );

  it("prints the latest stability bundle without calling Gateway", async () => {
    callGateway.mockClear();
    const tempDir = tempDirs.make("openclaw-gateway-cli-bundle-");
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
        openclawVersion: "2026.4.22-beta.1+fixture",
        buildId: "2026.4.22-abcdef012345-2026-04-22T12-00-00.000Z",
        commit: "abcdef0",
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
            totalAvailableSizeBytes: 8192,
            usedHeapSizeBytes: 1536,
            heapSizeLimitBytes: 4096,
          },
          activeResources: { total: 2, byType: { Timeout: 2 } },
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
        events: [
          {
            seq: 1,
            ts: Date.parse("2026-04-22T12:00:00.000Z"),
            type: "payload.large",
            surface: "gateway.http.json",
            action: "rejected",
            bytes: 2048,
          },
        ],
        summary: {
          byType: {}, // Selection rebuilds the summary from events.
        },
      },
    };
    fs.mkdirSync(bundleDir, { recursive: true });
    fs.writeFileSync(bundlePath, `${JSON.stringify(bundle, null, 2)}\n`, "utf8");

    await withEnvAsync({ OPENCLAW_STATE_DIR: tempDir }, async () => {
      await runGatewayCommand([
        "--port",
        "19096",
        "stability",
        "--bundle",
        "latest",
        "--url",
        "ws://127.0.0.1:19096",
      ]);
    });

    const output = runtimeLogs.join("\n");
    expect(callGateway).not.toHaveBeenCalled();
    expect(output).toContain("Stability bundle");
    expect(output).toContain("gateway.restart_startup_failed");
    expect(output).toContain("openclaw=2026.4.22-beta.1+fixture");
    expect(output).toContain("build=2026.4.22-abcdef012345-2026-04-22T12-00-00.000Z");
    expect(output).toContain("commit=abcdef0");
    expect(output).toContain("Memory pressure");
    expect(output).toContain("rss_threshold");
    expect(output).toContain("Largest session files");
    expect(output).toContain("agents/<agent>/sessions/<session>.jsonl");
    expect(output).toContain("payload.large");
    expect(output).toContain("gateway.http.json");
  });

  it.each([
    {
      name: "gateway diagnostics",
      args: ["diagnostics", "export"],
      timeoutMs: 3000,
      json: true,
    },
    {
      name: "offline stability",
      args: ["--port", "19097", "stability", "--bundle", "latest", "--export"],
      timeoutMs: 10_000,
      json: true,
    },
    {
      name: "human gateway diagnostics",
      args: ["diagnostics", "export"],
      timeoutMs: 3000,
      json: false,
    },
  ])(
    "writes $name export with a service-owned health snapshot",
    async ({ args, timeoutMs, json }) => {
      callGateway.mockClear();
      const tempDir = tempDirs.make("openclaw-gateway-cli-support-");
      const outputPath = path.join(tempDir, "diagnostics.zip");
      await withEnvAsync(
        { OPENCLAW_STATE_DIR: tempDir, OPENCLAW_TEST_FILE_LOG: undefined },
        async () => {
          await runGatewayCommand([...args, "--output", outputPath, ...(json ? ["--json"] : [])]);
        },
      );

      expectGatewayCall({ method: "health", timeoutMs, localPortOverride: undefined });
      expect(fs.existsSync(outputPath)).toBe(true);
      const output = runtimeLogs.join("\n");
      expect(output).toContain("diagnostics.zip");
      if (json) {
        expect(output).toContain('"path"');
        expect(output).toContain('"payloadFree": true');
      } else {
        expect(runtimeLogs).toEqual([
          "Diagnostics export",
          `Path: ${outputPath}`,
          expect.stringMatching(/^Size: /),
          expect.stringMatching(/^Files: \d+$/),
          "Privacy: payload-free stability, sanitized logs/status/health/config",
        ]);
        expect(defaultRuntime.writeJson).not.toHaveBeenCalled();
      }
    },
  );

  it("gateway diagnostics export redacts namespaced paths in the ZIP across repeated exports", async () => {
    const stateDir = tempDirs.make("openclaw-gateway-redaction-");
    const configPath = path.join(stateDir, "openclaw.json");
    const logPath = path.join(stateDir, "input.log");
    const userProfile = "C:\\Users\\support-user";
    const cases = [
      [
        `mkdir '\\\\?\\${stateDir}${path.sep}agents'`,
        `mkdir '$OPENCLAW_STATE_DIR${path.sep}agents'`,
      ],
      [
        `failed at \\\\?\\${userProfile}\\Documents\\error.txt`,
        "failed at ~\\Documents\\error.txt",
      ],
      [
        "failed at \\\\?\\c:\\users\\support-user\\Documents\\error.txt",
        "failed at ~\\Documents\\error.txt",
      ],
      [
        `failed at \\\\.\\${userProfile}\\Documents\\error.txt`,
        "failed at ~\\Documents\\error.txt",
      ],
      [`\\\\?\\${userProfile}\\Documents\\error.txt`, "~\\Documents\\error.txt"],
      ["scanned \\\\?\\D:\\unrelated\\root", "scanned \\\\?\\D:\\unrelated\\root"],
      ["\\\\?\\UNC\\server\\share\\config.json", "\\\\?\\UNC\\server\\share\\config.json"],
      ["\\\\.\\pipe\\openclaw-gateway", "\\\\.\\pipe\\openclaw-gateway"],
    ] as const;
    fs.writeFileSync(
      configPath,
      JSON.stringify({ logging: { file: logPath }, plugins: { enabled: false } }),
    );
    fs.writeFileSync(logPath, cases.map(([msg]) => JSON.stringify({ msg })).join("\n") + "\n");
    const expected = cases.map(([, msg]) => JSON.stringify({ msg })).join("\n") + "\n";

    await withEnvAsync(
      {
        HOME: stateDir,
        USERPROFILE: userProfile,
        OPENCLAW_HOME: stateDir,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: configPath,
        OPENCLAW_TEST_FILE_LOG: "1",
      },
      async () => {
        // A relative namespace suffix must not acquire the current home prefix.
        const cwd = vi.spyOn(process, "cwd").mockReturnValue(userProfile);
        try {
          for (const filename of ["first.zip", "second.zip"]) {
            const outputPath = path.join(stateDir, filename);
            await runGatewayCommand(["diagnostics", "export", "--output", outputPath, "--json"]);
            const zip = await JSZip.loadAsync(fs.readFileSync(outputPath));
            const logs = await zip.file("logs/openclaw-sanitized.jsonl")?.async("string");
            expect(logs).toBe(expected);
            if (logs === undefined) {
              throw new Error("Diagnostics export is missing sanitized logs");
            }
            const config = await zip.file("config/shape.json")?.async("string");
            expect(config).toContain('"parseOk": true');
            expect(config).toContain(
              `"path": ${JSON.stringify(`$OPENCLAW_STATE_DIR${path.sep}openclaw.json`)}`,
            );
            fs.writeFileSync(logPath, logs);
          }
        } finally {
          cwd.mockRestore();
        }
      },
    );
  });

  it("rejects an explicitly empty gateway diagnostics export --log-bytes", async () => {
    const flag = "--log-bytes";
    callGateway.mockClear();
    const tempDir = tempDirs.make("openclaw-gateway-cli-empty-");
    const outputPath = path.join(tempDir, "diagnostics.zip");
    await withEnvAsync(
      { OPENCLAW_STATE_DIR: tempDir, OPENCLAW_TEST_FILE_LOG: undefined },
      async () => {
        await expectGatewayExit([
          "diagnostics",
          "export",
          flag,
          "",
          "--output",
          outputPath,
          "--json",
        ]);
      },
    );

    expect(defaultRuntime.writeJson).toHaveBeenCalledWith({
      ok: false,
      error: { type: "cli_error", message: `${flag} must be a positive integer.` },
    });
    expect(runtimeErrors).toHaveLength(0);
    expect(callGateway).not.toHaveBeenCalled();
    expect(fs.existsSync(outputPath)).toBe(false);
  });

  it.each([
    {
      name: "prefers the resolved service address over TXT hints",
      beacon: {
        instanceName: "Studio gateway",
        host: "studio.openclaw.internal",
        port: 18789,
        lanHost: "untrusted.example.test",
        tailnetDns: "untrusted.tailnet.test",
        gatewayPort: 12345,
      } satisfies DiscoveredBeacon,
      wsUrl: "ws://studio.openclaw.internal:18789",
    },
    {
      name: "uses the secure scheme advertised by a TLS gateway",
      beacon: {
        instanceName: "Secure gateway",
        host: "secure.openclaw.internal",
        port: 18789,
        gatewayTls: true,
      } satisfies DiscoveredBeacon,
      wsUrl: "wss://secure.openclaw.internal:18789",
    },
    {
      name: "does not construct a URL from unresolved TXT hints",
      beacon: {
        instanceName: "Unresolved gateway",
        lanHost: "unresolved.openclaw.internal",
        gatewayPort: 18789,
      } satisfies DiscoveredBeacon,
      wsUrl: null,
    },
  ])("gateway discovery JSON $name", async ({ beacon, wsUrl }) => {
    discoverGatewayBeacons.mockResolvedValueOnce([beacon]);

    await runGatewayCommand(["discover", "--json"]);

    expect(defaultRuntime.writeJson).toHaveBeenCalledWith(
      expect.objectContaining({
        count: 1,
        beacons: [{ ...beacon, wsUrl }],
      }),
    );
  });

  it("forwards the resolved Gateway port in discovery SSH tunnel hints", async () => {
    const port = 29443;
    discoverGatewayBeacons.mockResolvedValueOnce([
      {
        instanceName: "Remote gateway",
        host: "gateway.example",
        port,
        gatewayPort: 41111,
        sshPort: 2222,
      },
    ]);

    await runGatewayCommand(["discover"]);

    const output = runtimeLogs.join("\n");
    expect(output).toContain(`ws://gateway.example:${port}`);
    expect(output).toContain(`ssh -N -L 18789:127.0.0.1:${port} <user>@gateway.example -p 2222`);
  });
});
