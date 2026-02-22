import os from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as logging from "../logging.js";

const mocks = vi.hoisted(() => ({
  createService: vi.fn(),
  shutdown: vi.fn(),
  registerUnhandledRejectionHandler: vi.fn(),
  logWarn: vi.fn(),
  logDebug: vi.fn(),
}));
const { createService, shutdown, registerUnhandledRejectionHandler, logWarn, logDebug } = mocks;
const getLoggerInfo = vi.fn();

const asString = (value: unknown, fallback: string) =>
  typeof value === "string" && value.trim() ? value : fallback;

function enableAdvertiserUnitMode(hostname = "test-host") {
  // Allow advertiser to run in unit tests.
  delete process.env.VITEST;
  process.env.NODE_ENV = "development";
  vi.spyOn(os, "hostname").mockReturnValue(hostname);
  process.env.OPENCLAW_MDNS_HOSTNAME = hostname;
}

function mockCiaoService(params?: {
  advertise?: ReturnType<typeof vi.fn>;
  destroy?: ReturnType<typeof vi.fn>;
  serviceState?: string;
  on?: ReturnType<typeof vi.fn>;
}) {
  const advertise = params?.advertise ?? vi.fn().mockResolvedValue(undefined);
  const destroy = params?.destroy ?? vi.fn().mockResolvedValue(undefined);
  const on = params?.on ?? vi.fn();
  createService.mockImplementation((options: Record<string, unknown>) => {
    return {
      advertise,
      destroy,
      serviceState: params?.serviceState ?? "announced",
      on,
      getFQDN: () => `${asString(options.type, "service")}.${asString(options.domain, "local")}.`,
      getHostname: () => asString(options.hostname, "unknown"),
      getPort: () => Number(options.port ?? -1),
    };
  });
  return { advertise, destroy, on };
}

vi.mock("../logger.js", async () => {
  const actual = await vi.importActual<typeof import("../logger.js")>("../logger.js");
  return {
    ...actual,
    logWarn: (message: string) => logWarn(message),
    logDebug: (message: string) => logDebug(message),
    logInfo: vi.fn(),
    logError: vi.fn(),
    logSuccess: vi.fn(),
  };
});

vi.mock("@homebridge/ciao", () => {
  return {
    Protocol: { TCP: "tcp" },
    getResponder: () => ({
      createService,
      shutdown,
    }),
  };
});

vi.mock("./unhandled-rejections.js", () => {
  return {
    registerUnhandledRejectionHandler: (handler: (reason: unknown) => boolean) =>
      registerUnhandledRejectionHandler(handler),
  };
});

const { startGatewayBonjourAdvertiser } = await import("./bonjour.js");

describe("gateway bonjour advertiser", () => {
  type ServiceCall = {
    name?: unknown;
    hostname?: unknown;
    domain?: unknown;
    txt?: unknown;
  };

  const prevEnv = { ...process.env };

  beforeEach(() => {
    vi.spyOn(logging, "getLogger").mockReturnValue({
      info: (...args: unknown[]) => getLoggerInfo(...args),
    } as unknown as ReturnType<typeof logging.getLogger>);
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in prevEnv)) {
        delete process.env[key];
      }
    }
    for (const [key, value] of Object.entries(prevEnv)) {
      process.env[key] = value;
    }

    createService.mockClear();
    shutdown.mockClear();
    registerUnhandledRejectionHandler.mockClear();
    logWarn.mockClear();
    logDebug.mockClear();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("does not block on advertise and publishes expected txt keys", async () => {
    enableAdvertiserUnitMode();

    const destroy = vi.fn().mockResolvedValue(undefined);
    let resolveAdvertise = () => {};
    const advertise = vi.fn().mockImplementation(
      async () =>
        await new Promise<void>((resolve) => {
          resolveAdvertise = resolve;
        }),
    );
    mockCiaoService({ advertise, destroy });

    const started = await startGatewayBonjourAdvertiser({
      gatewayPort: 18789,
      sshPort: 2222,
      tailnetDns: "host.tailnet.ts.net",
      cliPath: "/opt/homebrew/bin/openclaw",
    });

    expect(createService).toHaveBeenCalledTimes(1);
    const [gatewayCall] = createService.mock.calls as Array<[Record<string, unknown>]>;
    expect(gatewayCall?.[0]?.type).toBe("openclaw-gw");
    const gatewayType = asString(gatewayCall?.[0]?.type, "");
    expect(gatewayType.length).toBeLessThanOrEqual(15);
    expect(gatewayCall?.[0]?.port).toBe(18789);
    expect(gatewayCall?.[0]?.domain).toBe("local");
    expect(gatewayCall?.[0]?.hostname).toBe("test-host");
    expect((gatewayCall?.[0]?.txt as Record<string, string>)?.lanHost).toBe("test-host.local");
    expect((gatewayCall?.[0]?.txt as Record<string, string>)?.gatewayPort).toBe("18789");
    expect((gatewayCall?.[0]?.txt as Record<string, string>)?.sshPort).toBe("2222");
    expect((gatewayCall?.[0]?.txt as Record<string, string>)?.cliPath).toBe(
      "/opt/homebrew/bin/openclaw",
    );
    expect((gatewayCall?.[0]?.txt as Record<string, string>)?.transport).toBe("gateway");

    // We don't await `advertise()`, but it should still be called for each service.
    expect(advertise).toHaveBeenCalledTimes(1);
    resolveAdvertise();
    await Promise.resolve();

    await started.stop();
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(shutdown).toHaveBeenCalledTimes(1);
  });

  it("omits cliPath and sshPort in minimal mode", async () => {
    enableAdvertiserUnitMode();

    const destroy = vi.fn().mockResolvedValue(undefined);
    const advertise = vi.fn().mockResolvedValue(undefined);
    mockCiaoService({ advertise, destroy });

    const started = await startGatewayBonjourAdvertiser({
      gatewayPort: 18789,
      sshPort: 2222,
      cliPath: "/opt/homebrew/bin/openclaw",
      minimal: true,
    });

    const [gatewayCall] = createService.mock.calls as Array<[Record<string, unknown>]>;
    expect((gatewayCall?.[0]?.txt as Record<string, string>)?.sshPort).toBeUndefined();
    expect((gatewayCall?.[0]?.txt as Record<string, string>)?.cliPath).toBeUndefined();

    await started.stop();
  });

  it("attaches conflict listeners for services", async () => {
    enableAdvertiserUnitMode();

    const destroy = vi.fn().mockResolvedValue(undefined);
    const advertise = vi.fn().mockResolvedValue(undefined);
    const onCalls: Array<{ event: string }> = [];

    const on = vi.fn((event: string) => {
      onCalls.push({ event });
    });
    mockCiaoService({ advertise, destroy, on });

    const started = await startGatewayBonjourAdvertiser({
      gatewayPort: 18789,
      sshPort: 2222,
    });

    // 1 service × 2 listeners
    expect(onCalls.map((c) => c.event)).toEqual(["name-change", "hostname-change"]);

    await started.stop();
  });

  it("cleans up unhandled rejection handler after shutdown", async () => {
    enableAdvertiserUnitMode();

    const destroy = vi.fn().mockResolvedValue(undefined);
    const advertise = vi.fn().mockResolvedValue(undefined);
    const order: string[] = [];
    shutdown.mockImplementation(async () => {
      order.push("shutdown");
    });
    mockCiaoService({ advertise, destroy });

    const cleanup = vi.fn(() => {
      order.push("cleanup");
    });
    registerUnhandledRejectionHandler.mockImplementation(() => cleanup);

    const started = await startGatewayBonjourAdvertiser({
      gatewayPort: 18789,
      sshPort: 2222,
    });

    await started.stop();

    expect(registerUnhandledRejectionHandler).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["shutdown", "cleanup"]);
  });

  it("logs advertise failures and retries via watchdog", async () => {
    enableAdvertiserUnitMode();
    vi.useFakeTimers();

    const destroy = vi.fn().mockResolvedValue(undefined);
    const advertise = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom")) // initial advertise fails
      .mockResolvedValue(undefined); // watchdog retry succeeds
    mockCiaoService({ advertise, destroy, serviceState: "unannounced" });

    const started = await startGatewayBonjourAdvertiser({
      gatewayPort: 18789,
      sshPort: 2222,
    });

    // initial advertise attempt happens immediately
    expect(advertise).toHaveBeenCalledTimes(1);

    // allow promise rejection handler to run
    await Promise.resolve();
    expect(logWarn).toHaveBeenCalledWith(expect.stringContaining("advertise failed"));

    // watchdog should attempt re-advertise at the 60s interval tick
    await vi.advanceTimersByTimeAsync(60_000);
    expect(advertise).toHaveBeenCalledTimes(2);

    await started.stop();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(advertise).toHaveBeenCalledTimes(2);
  });

  it("handles advertise throwing synchronously", async () => {
    enableAdvertiserUnitMode();

    const destroy = vi.fn().mockResolvedValue(undefined);
    const advertise = vi.fn(() => {
      throw new Error("sync-fail");
    });
    mockCiaoService({ advertise, destroy, serviceState: "unannounced" });

    const started = await startGatewayBonjourAdvertiser({
      gatewayPort: 18789,
      sshPort: 2222,
    });

    expect(advertise).toHaveBeenCalledTimes(1);
    expect(logWarn).toHaveBeenCalledWith(expect.stringContaining("advertise threw"));

    await started.stop();
  });

  it("normalizes hostnames with domains for service names", async () => {
    // Allow advertiser to run in unit tests.
    delete process.env.VITEST;
    process.env.NODE_ENV = "development";

    vi.spyOn(os, "hostname").mockReturnValue("Mac.localdomain");

    const destroy = vi.fn().mockResolvedValue(undefined);
    const advertise = vi.fn().mockResolvedValue(undefined);
    mockCiaoService({ advertise, destroy });

    const started = await startGatewayBonjourAdvertiser({
      gatewayPort: 18789,
      sshPort: 2222,
    });

    const [gatewayCall] = createService.mock.calls as Array<[ServiceCall]>;
    expect(gatewayCall?.[0]?.name).toBe("openclaw (OpenClaw)");
    expect(gatewayCall?.[0]?.domain).toBe("local");
    expect(gatewayCall?.[0]?.hostname).toBe("openclaw");
    expect((gatewayCall?.[0]?.txt as Record<string, string>)?.lanHost).toBe("openclaw.local");

    await started.stop();
  });
});
