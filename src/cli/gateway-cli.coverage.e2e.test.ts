import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import { withEnvOverride } from "../config/test-helpers.js";
import { createCliRuntimeCapture } from "./test-runtime-capture.js";

type DiscoveredBeacon = Awaited<
  ReturnType<typeof import("../infra/bonjour-discovery.js").discoverGatewayBeacons>
>[number];

const callGateway = vi.fn<(opts: unknown) => Promise<{ ok: true }>>(async () => ({ ok: true }));
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

const { runtimeLogs, runtimeErrors, defaultRuntime, resetRuntimeCapture } =
  createCliRuntimeCapture();

vi.mock(
  new URL("../../gateway/call.ts", new URL("./gateway-cli/call.ts", import.meta.url)).href,
  () => ({
    callGateway: (opts: unknown) => callGateway(opts),
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

vi.mock("../runtime.js", () => ({
  defaultRuntime,
}));

vi.mock("./ports.js", () => ({
  forceFreePortAndWait: (port: number) => forceFreePortAndWait(port),
}));

vi.mock("../daemon/service.js", () => ({
  resolveGatewayService: () => ({
    label: "LaunchAgent",
    loadedText: "loaded",
    notLoadedText: "not loaded",
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

vi.mock("../infra/bonjour-discovery.js", () => ({
  discoverGatewayBeacons: (opts: unknown) => discoverGatewayBeacons(opts),
}));

vi.mock("../commands/gateway-status.js", () => ({
  gatewayStatusCommand: (opts: unknown) => gatewayStatusCommand(opts),
}));

describe("gateway-cli coverage", () => {
  it("registers call/health commands and routes to callGateway", async () => {
    resetRuntimeCapture();
    callGateway.mockClear();

    const { registerGatewayCli } = await import("./gateway-cli.js");
    const program = new Command();
    program.exitOverride();
    registerGatewayCli(program);

    await program.parseAsync(["gateway", "call", "health", "--params", '{"x":1}', "--json"], {
      from: "user",
    });

    expect(callGateway).toHaveBeenCalledTimes(1);
    expect(runtimeLogs.join("\n")).toContain('"ok": true');
  }, 60_000);

  it("registers gateway probe and routes to gatewayStatusCommand", async () => {
    resetRuntimeCapture();
    gatewayStatusCommand.mockClear();

    const { registerGatewayCli } = await import("./gateway-cli.js");
    const program = new Command();
    program.exitOverride();
    registerGatewayCli(program);

    await program.parseAsync(["gateway", "probe", "--json"], { from: "user" });

    expect(gatewayStatusCommand).toHaveBeenCalledTimes(1);
  }, 60_000);

  it("registers gateway discover and prints JSON", async () => {
    resetRuntimeCapture();
    discoverGatewayBeacons.mockReset();
    discoverGatewayBeacons.mockResolvedValueOnce([
      {
        instanceName: "Studio (OpenClaw)",
        displayName: "Studio",
        domain: "local.",
        host: "studio.local",
        lanHost: "studio.local",
        tailnetDns: "studio.tailnet.ts.net",
        gatewayPort: 18789,
        sshPort: 22,
      },
    ]);

    const { registerGatewayCli } = await import("./gateway-cli.js");
    const program = new Command();
    program.exitOverride();
    registerGatewayCli(program);

    await program.parseAsync(["gateway", "discover", "--json"], {
      from: "user",
    });

    expect(discoverGatewayBeacons).toHaveBeenCalledTimes(1);
    expect(runtimeLogs.join("\n")).toContain('"beacons"');
    expect(runtimeLogs.join("\n")).toContain('"wsUrl"');
    expect(runtimeLogs.join("\n")).toContain("ws://");
  });

  it("registers gateway discover and prints human output with details on new lines", async () => {
    resetRuntimeCapture();
    discoverGatewayBeacons.mockReset();
    discoverGatewayBeacons.mockResolvedValueOnce([
      {
        instanceName: "Studio (OpenClaw)",
        displayName: "Studio",
        domain: "openclaw.internal.",
        host: "studio.openclaw.internal",
        lanHost: "studio.local",
        tailnetDns: "studio.tailnet.ts.net",
        gatewayPort: 18789,
        sshPort: 22,
      },
    ]);

    const { registerGatewayCli } = await import("./gateway-cli.js");
    const program = new Command();
    program.exitOverride();
    registerGatewayCli(program);

    await program.parseAsync(["gateway", "discover", "--timeout", "1"], {
      from: "user",
    });

    const out = runtimeLogs.join("\n");
    expect(out).toContain("Gateway Discovery");
    expect(out).toContain("Found 1 gateway(s)");
    expect(out).toContain("- Studio openclaw.internal.");
    expect(out).toContain("  tailnet: studio.tailnet.ts.net");
    expect(out).toContain("  host: studio.openclaw.internal");
    expect(out).toContain("  ws: ws://studio.openclaw.internal:18789");
  });

  it("validates gateway discover timeout", async () => {
    resetRuntimeCapture();
    discoverGatewayBeacons.mockReset();

    const { registerGatewayCli } = await import("./gateway-cli.js");
    const program = new Command();
    program.exitOverride();
    registerGatewayCli(program);

    await expect(
      program.parseAsync(["gateway", "discover", "--timeout", "0"], {
        from: "user",
      }),
    ).rejects.toThrow("__exit__:1");

    expect(runtimeErrors.join("\n")).toContain("gateway discover failed:");
    expect(discoverGatewayBeacons).not.toHaveBeenCalled();
  });

  it("fails gateway call on invalid params JSON", async () => {
    resetRuntimeCapture();
    callGateway.mockClear();

    const { registerGatewayCli } = await import("./gateway-cli.js");
    const program = new Command();
    program.exitOverride();
    registerGatewayCli(program);

    await expect(
      program.parseAsync(["gateway", "call", "status", "--params", "not-json"], { from: "user" }),
    ).rejects.toThrow("__exit__:1");

    expect(callGateway).not.toHaveBeenCalled();
    expect(runtimeErrors.join("\n")).toContain("Gateway call failed:");
  });

  it("validates gateway ports and handles force/start errors", async () => {
    resetRuntimeCapture();

    const { registerGatewayCli } = await import("./gateway-cli.js");

    // Invalid port
    const programInvalidPort = new Command();
    programInvalidPort.exitOverride();
    registerGatewayCli(programInvalidPort);
    await expect(
      programInvalidPort.parseAsync(["gateway", "--port", "0", "--token", "test-token"], {
        from: "user",
      }),
    ).rejects.toThrow("__exit__:1");

    // Force free failure
    forceFreePortAndWait.mockImplementationOnce(async () => {
      throw new Error("boom");
    });
    const programForceFail = new Command();
    programForceFail.exitOverride();
    registerGatewayCli(programForceFail);
    await expect(
      programForceFail.parseAsync(
        ["gateway", "--port", "18789", "--token", "test-token", "--force", "--allow-unconfigured"],
        { from: "user" },
      ),
    ).rejects.toThrow("__exit__:1");

    // Start failure (generic)
    startGatewayServer.mockRejectedValueOnce(new Error("nope"));
    const programStartFail = new Command();
    programStartFail.exitOverride();
    registerGatewayCli(programStartFail);
    const beforeSigterm = new Set(process.listeners("SIGTERM"));
    const beforeSigint = new Set(process.listeners("SIGINT"));
    await expect(
      programStartFail.parseAsync(
        ["gateway", "--port", "18789", "--token", "test-token", "--allow-unconfigured"],
        {
          from: "user",
        },
      ),
    ).rejects.toThrow("__exit__:1");
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
    resetRuntimeCapture();
    serviceIsLoaded.mockResolvedValue(true);

    const { GatewayLockError } = await import("../infra/gateway-lock.js");
    startGatewayServer.mockRejectedValueOnce(
      new GatewayLockError("another gateway instance is already listening"),
    );

    const { registerGatewayCli } = await import("./gateway-cli.js");
    const program = new Command();
    program.exitOverride();
    registerGatewayCli(program);

    await expect(
      program.parseAsync(["gateway", "--token", "test-token", "--allow-unconfigured"], {
        from: "user",
      }),
    ).rejects.toThrow("__exit__:1");

    expect(startGatewayServer).toHaveBeenCalled();
    expect(runtimeErrors.join("\n")).toContain("Gateway failed to start:");
    expect(runtimeErrors.join("\n")).toContain("gateway stop");
  });

  it("uses env/config port when --port is omitted", async () => {
    await withEnvOverride({ OPENCLAW_GATEWAY_PORT: "19001" }, async () => {
      resetRuntimeCapture();
      startGatewayServer.mockClear();

      const { registerGatewayCli } = await import("./gateway-cli.js");
      const program = new Command();
      program.exitOverride();
      registerGatewayCli(program);

      startGatewayServer.mockRejectedValueOnce(new Error("nope"));
      await expect(
        program.parseAsync(["gateway", "--token", "test-token", "--allow-unconfigured"], {
          from: "user",
        }),
      ).rejects.toThrow("__exit__:1");

      expect(startGatewayServer).toHaveBeenCalledWith(19001, expect.anything());
    });
  });
});
