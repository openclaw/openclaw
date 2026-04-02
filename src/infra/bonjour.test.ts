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
  stateRef?: { value: string };
  on?: ReturnType<typeof vi.fn>;
}) {
  const advertise = params?.advertise ?? vi.fn().mockResolvedValue(undefined);
  const destroy = params?.destroy ?? vi.fn().mockResolvedValue(undefined);
  const on = params?.on ?? vi.fn();
  createService.mockImplementation((options: Record<string, unknown>) => {
    const service = {
      advertise,
      destroy,
      on,
      getFQDN: () => `${asString(options.type, "service")}.${asString(options.domain, "local")}.`,
      getHostname: () => asString(options.hostname, "unknown"),
      getPort: () => Number(options.port ?? -1),
    };
    Object.defineProperty(service, "serviceState", {
      configurable: true,
      enumerable: true,
      get: () => params?.stateRef?.value ?? params?.serviceState ?? "announced",
      set: (value: string) => {
        if (params?.stateRef) {
          params.stateRef.value = value;
        }
      },
    });
    return service;
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

  it("logs ciao handler classifications at the bonjour caller", async () => {
    enableAdvertiserUnitMode();

    const destroy = vi.fn().mockResolvedValue(undefined);
    const advertise = vi.fn().mockResolvedValue(undefined);
    mockCiaoService({ advertise, destroy });

    const started = await startGatewayBonjourAdvertiser({
      gatewayPort: 18789,
      sshPort: 2222,
    });

    const handler = registerUnhandledRejectionHandler.mock.calls[0]?.[0] as
      | ((reason: unknown) => boolean)
      | undefined;
    expect(handler).toBeTypeOf("function");

    expect(handler?.(new Error("CIAO PROBING CANCELLED"))).toBe(true);
    expect(logDebug).toHaveBeenCalledWith(
      expect.stringContaining("ignoring unhandled ciao rejection"),
    );

    logDebug.mockClear();
    expect(
      handler?.(new Error("Reached illegal state! IPV4 address change from defined to undefined!")),
    ).toBe(true);
    expect(logWarn).toHaveBeenCalledWith(
      expect.stringContaining("suppressing ciao interface assertion"),
    );

    await started.stop();
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

    // watchdog first retries, then recreates the advertiser after the service
    // stays unhealthy across multiple 5s ticks.
    await vi.advanceTimersByTimeAsync(15_000);
    expect(advertise).toHaveBeenCalledTimes(3);
    expect(createService).toHaveBeenCalledTimes(2);

    await started.stop();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(advertise).toHaveBeenCalledTimes(3);
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

  it("suppresses ciao self-probe retry console noise while advertising", async () => {
    enableAdvertiserUnitMode();

    const destroy = vi.fn().mockResolvedValue(undefined);
    const advertise = vi.fn().mockResolvedValue(undefined);
    mockCiaoService({ advertise, destroy });

    const originalConsoleLog = console.log;
    const baseConsoleLog = vi.fn();
    console.log = baseConsoleLog as typeof console.log;

    try {
      const started = await startGatewayBonjourAdvertiser({
        gatewayPort: 18789,
        sshPort: 2222,
      });

      console.log(
        "[test._openclaw-gw._tcp.local.] failed probing with reason: Error: Can't probe for a service which is announced already. Received announcing for service test._openclaw-gw._tcp.local.. Trying again in 2 seconds!",
      );
      console.log("ordinary console line");

      expect(baseConsoleLog).toHaveBeenCalledTimes(1);
      expect(baseConsoleLog).toHaveBeenCalledWith("ordinary console line");

      await started.stop();
    } finally {
      console.log = originalConsoleLog;
    }
  });

  it("recreates the advertiser when ciao gets stuck announcing", async () => {
    enableAdvertiserUnitMode();
    vi.useFakeTimers();

    const stateRef = { value: "announcing" };
    const events: string[] = [];
    let advertiseCount = 0;
    const destroy = vi.fn().mockImplementation(async () => {
      events.push("destroy");
    });
    const advertise = vi.fn().mockImplementation(() => {
      advertiseCount += 1;
      events.push(`advertise:${advertiseCount}`);
      if (advertiseCount === 1) {
        stateRef.value = "announcing";
        return new Promise<void>(() => {});
      }
      stateRef.value = "announced";
      return Promise.resolve();
    });
    mockCiaoService({ advertise, destroy, stateRef });

    const started = await startGatewayBonjourAdvertiser({
      gatewayPort: 18789,
      sshPort: 2222,
    });

    expect(createService).toHaveBeenCalledTimes(1);
    expect(advertise).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(15_000);

    expect(logWarn).toHaveBeenCalledWith(expect.stringContaining("restarting advertiser"));
    expect(createService).toHaveBeenCalledTimes(2);
    expect(advertise).toHaveBeenCalledTimes(2);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(events).toEqual(["advertise:1", "destroy", "advertise:2"]);

    await started.stop();
    expect(destroy).toHaveBeenCalledTimes(2);
    expect(shutdown).toHaveBeenCalledTimes(2);
  });

  it("treats probing-to-announcing churn as one unhealthy window", async () => {
    enableAdvertiserUnitMode();
    vi.useFakeTimers();

    const stateRef = { value: "probing" };
    let advertiseCount = 0;
    const destroy = vi.fn().mockResolvedValue(undefined);
    const advertise = vi.fn().mockImplementation(() => {
      advertiseCount += 1;
      if (advertiseCount === 2) {
        stateRef.value = "announcing";
      }
      if (advertiseCount >= 3) {
        stateRef.value = "announced";
      }
      return Promise.resolve();
    });
    mockCiaoService({ advertise, destroy, stateRef });

    const started = await startGatewayBonjourAdvertiser({
      gatewayPort: 18789,
      sshPort: 2222,
    });

    expect(createService).toHaveBeenCalledTimes(1);
    expect(advertise).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(15_000);

    expect(logWarn).toHaveBeenCalledWith(expect.stringContaining("service stuck in announcing"));
    expect(createService).toHaveBeenCalledTimes(2);
    expect(advertise).toHaveBeenCalledTimes(3);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(shutdown).toHaveBeenCalledTimes(1);

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
