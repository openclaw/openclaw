import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPluginRuntimeStore } from "../plugin-sdk/runtime-store.js";
import { createUnavailableRuntime } from "../plugins/api-builder.js";
import { createPluginRecord } from "../plugins/loader-records.js";
import { PluginInstance } from "../plugins/plugin-instance.js";
import { projectPluginContributions } from "../plugins/registry-contributions.js";
import { adoptPluginRegistryRecords } from "../plugins/registry-lifecycle.js";
import type { PluginGatewayDiscoveryServiceRegistration } from "../plugins/registry-types.js";
import { createEmptyPluginRegistry, createPluginRegistry } from "../plugins/registry.js";
import { createDeferredCore } from "../shared/deferred.js";
import { captureFullEnv } from "../test-utils/env.js";
import { createGatewayPluginRuntimeGeneration } from "./server-plugin-runtime-generation.js";

type WriteWideAreaGatewayZone = typeof import("../infra/widearea-dns.js").writeWideAreaGatewayZone;
type ResolveWideAreaDiscoveryDomain =
  typeof import("../infra/widearea-dns.js").resolveWideAreaDiscoveryDomain;

const mocks = vi.hoisted(() => ({
  pickPrimaryTailnetIPv4: vi.fn(() => "100.64.0.10"),
  pickPrimaryTailnetIPv6: vi.fn(() => undefined as string | undefined),
  resolveWideAreaDiscoveryDomain: vi.fn<ResolveWideAreaDiscoveryDomain>(() => "openclaw.internal."),
  writeWideAreaGatewayZone: vi.fn<WriteWideAreaGatewayZone>(async () => ({
    changed: true,
    zonePath: "/tmp/openclaw.internal.db",
  })),
  formatBonjourInstanceName: vi.fn((name: string) => `${name} (OpenClaw)`),
  resolveBonjourCliPath: vi.fn(() => "/usr/local/bin/openclaw"),
  resolveTailnetDnsHint: vi.fn(async () => "gateway.tailnet.example.ts.net"),
}));

vi.mock("../infra/tailnet.js", () => ({
  pickPrimaryTailnetIPv4: mocks.pickPrimaryTailnetIPv4,
  pickPrimaryTailnetIPv6: mocks.pickPrimaryTailnetIPv6,
}));

vi.mock("../infra/widearea-dns.js", () => ({
  resolveWideAreaDiscoveryDomain: mocks.resolveWideAreaDiscoveryDomain,
  writeWideAreaGatewayZone: mocks.writeWideAreaGatewayZone,
}));

vi.mock("./server-discovery.js", () => ({
  formatBonjourInstanceName: mocks.formatBonjourInstanceName,
  resolveBonjourCliPath: mocks.resolveBonjourCliPath,
  resolveTailnetDnsHint: mocks.resolveTailnetDnsHint,
}));

const { startGatewayDiscovery } = await import("./server-discovery-runtime.js");
type Advertise = PluginGatewayDiscoveryServiceRegistration["service"]["advertise"];

const createPluginOwner = () =>
  createGatewayPluginRuntimeGeneration({ getServices: () => null, setServices: () => {} });

const makeLogs = () => ({
  info: vi.fn(),
  warn: vi.fn(),
});

type DiscoveryOptions = Partial<Parameters<typeof startGatewayDiscovery>[0]>;
function startDiscovery(
  gatewayDiscoveryServices: readonly PluginGatewayDiscoveryServiceRegistration[],
  overrides: DiscoveryOptions = {},
) {
  return startGatewayDiscovery({
    machineDisplayName: "Lab Mac",
    port: 18789,
    tailscaleMode: "off",
    pluginRuntimeClaim: createPluginOwner().currentClaim(),
    logDiscovery: makeLogs(),
    gatewayDiscoveryServices,
    ...overrides,
  });
}

const makeDiscoveryService = (
  id: string,
  params: { pluginId?: string; stop?: () => void | Promise<void>; advertise?: Advertise } = {},
) => {
  const advertise = params.advertise ?? vi.fn(async () => ({ stop: params.stop }));
  return {
    pluginId: params.pluginId ?? id,
    pluginName: params.pluginId ?? id,
    source: "test",
    id: id.trim(),
    service: { id, advertise },
    advertise,
  };
};

function latestZoneParams(): Parameters<WriteWideAreaGatewayZone>[0] {
  const call = mocks.writeWideAreaGatewayZone.mock.lastCall;
  if (!call) {
    throw new Error("Expected wide-area gateway zone to be written");
  }
  return call[0];
}

function useDevelopmentDiscoveryEnv() {
  process.env.NODE_ENV = "development";
  delete process.env.VITEST;
}

function startStuckDiscovery(timeoutMs: string) {
  vi.useFakeTimers();
  process.env.OPENCLAW_GATEWAY_DISCOVERY_ADVERTISE_TIMEOUT_MS = timeoutMs;

  const service = makeDiscoveryService("stuck-discovery", {
    advertise: vi.fn(() => new Promise<void>(() => {})),
  });
  const logs = makeLogs();

  const resultPromise = startDiscovery([service], {
    discovery: { mdns: { mode: "full" } },
    logDiscovery: logs,
  });

  return { logs, resultPromise };
}

function deferredAdvertisement(id: string, phase: "pending" | "ready" = "pending") {
  const result = createDeferredCore<{ stop: () => void }>();
  const started = createDeferredCore();
  const stop = vi.fn();
  const acquire: Advertise = () => {
    started.resolve();
    return phase === "pending" ? result.promise : Promise.resolve({ stop });
  };
  const advertise = vi.fn<Advertise>(acquire);
  return {
    ...makeDiscoveryService(id, { advertise }),
    advertise,
    acquire,
    stop,
    started: started.promise,
    resolve: () => result.resolve({ stop }),
  };
}

async function startTimedDiscovery(
  services: readonly PluginGatewayDiscoveryServiceRegistration[],
  options: DiscoveryOptions = {},
) {
  vi.useFakeTimers();
  process.env.OPENCLAW_GATEWAY_DISCOVERY_ADVERTISE_TIMEOUT_MS = "10";
  const starting = startDiscovery(services, options);
  await vi.advanceTimersByTimeAsync(10);
  return starting;
}

describe("startGatewayDiscovery", () => {
  const envSnapshot = captureFullEnv();
  beforeEach(useDevelopmentDiscoveryEnv);

  afterEach(() => {
    vi.useRealTimers();
    envSnapshot.restore();
    vi.clearAllMocks();
    mocks.resolveTailnetDnsHint.mockReset();
    mocks.resolveTailnetDnsHint.mockResolvedValue("gateway.tailnet.example.ts.net");
  });

  it("preserves getter discovery descriptors in their projected scope", async () => {
    const builder = createPluginRegistry({
      logger: { ...makeLogs(), error() {} },
      runtime: createUnavailableRuntime("setup-only", "native-discovery"),
      activateGlobalSideEffects: false,
    });
    const record = createPluginRecord({
      id: "native-discovery",
      source: "test",
      origin: "workspace",
      enabled: true,
      configSchema: false,
    });
    builder.registry.plugins.push(record);
    const instance = new PluginInstance(record.id, { record, registry: builder.registry });
    const store = createPluginRuntimeStore<object>("discovery runtime missing");
    const runtime = {};
    const calls: Array<{ phase: string; value: number; runtime: object | null }> = [];
    class NativeAdvertisement extends Date {
      readonly id = "native-discovery";
      async advertise() {
        calls.push({ phase: "advertise", value: this.getTime(), runtime: store.tryGetRuntime() });
        return this;
      }
      stop() {
        calls.push({ phase: "stop", value: this.getTime(), runtime: store.tryGetRuntime() });
      }
    }
    const service = new NativeAdvertisement(37);
    let reads = 0;
    Object.defineProperty(service, "id", {
      get() {
        if (reads++ > 0) {
          throw new Error("discovery id must only be read at admission");
        }
        return " native-discovery ";
      },
    });
    instance.run(() => {
      store.setRuntime(runtime);
      builder.createApi(record, { config: {} }).registerGatewayDiscoveryService(service);
    });
    const registry = createEmptyPluginRegistry();
    registry.plugins.push(record);
    projectPluginContributions(builder.registry, record, registry);
    adoptPluginRegistryRecords(registry);
    expect(registry.gatewayDiscoveryServices).toHaveLength(1);
    expect(registry.gatewayDiscoveryServices[0]?.service).toBe(service);
    expect(record.gatewayDiscoveryServiceIds).toEqual(["native-discovery"]);
    let discovery: Awaited<ReturnType<typeof startDiscovery>> | undefined;
    try {
      discovery = await startDiscovery(registry.gatewayDiscoveryServices);
      await discovery.stop();
      expect(calls).toEqual([
        { phase: "advertise", value: 37, runtime },
        { phase: "stop", value: 37, runtime },
      ]);
      expect(calls.every((call) => call.runtime === runtime)).toBe(true);
    } finally {
      await discovery?.stop();
      await instance.dispose();
    }
  });

  it("starts registered local discovery services with gateway advertisement context", async () => {
    process.env.OPENCLAW_SSH_PORT = "2222";

    const stopped: string[] = [];
    const bonjour = makeDiscoveryService("bonjour", {
      stop: () => {
        stopped.push("bonjour");
      },
    });
    const peer = makeDiscoveryService("peer-discovery", {
      pluginId: "peer",
      stop: () => {
        stopped.push("peer");
      },
    });
    const logs = makeLogs();

    const result = await startDiscovery([bonjour, peer], {
      discovery: { mdns: { mode: "full" } },
      gatewayTls: { enabled: true, fingerprintSha256: "abc123" },
      gatewayDirectReachable: true,
      tailscaleMode: "serve",
      logDiscovery: logs,
    });

    expect(bonjour.advertise).toHaveBeenCalledWith({
      machineDisplayName: "Lab Mac",
      gatewayPort: 18789,
      gatewayTlsEnabled: true,
      gatewayTlsFingerprintSha256: "abc123",
      gatewayDirectReachable: true,
      sshPort: 2222,
      tailnetDns: "gateway.tailnet.example.ts.net",
      cliPath: "/usr/local/bin/openclaw",
      minimal: false,
    });
    expect(peer.advertise).toHaveBeenCalledTimes(1);
    expect(logs.warn).not.toHaveBeenCalled();

    await result.stop();
    expect(stopped).toEqual(["peer", "bonjour"]);
  });

  it("omits invalid SSH discovery ports", async () => {
    process.env.OPENCLAW_SSH_PORT = "2222abc";
    const service = makeDiscoveryService("bonjour");
    await startDiscovery([service], {
      discovery: { mdns: { mode: "full" } },
      tailscaleMode: "serve",
    });
    expect(service.advertise).toHaveBeenCalledWith(expect.objectContaining({ sshPort: undefined }));
  });

  it("uses the default discovery timeout for partial timeout env values", async () => {
    const { logs, resultPromise } = startStuckDiscovery("10abc");

    await vi.advanceTimersByTimeAsync(10);
    expect(logs.warn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(4_990);
    const result = await resultPromise;

    expect(logs.warn.mock.calls).toEqual([
      [
        "gateway discovery service timed out after 5000ms (stuck-discovery, plugin=stuck-discovery); continuing startup",
      ],
    ]);
    await result.stop();
  });

  it("waits for delayed discovery when the configured timeout exceeds Node's timer range", async () => {
    process.env.OPENCLAW_GATEWAY_DISCOVERY_ADVERTISE_TIMEOUT_MS = "2147483648";

    const stop = vi.fn();
    const service = makeDiscoveryService("slow-discovery", {
      advertise: vi.fn(async () => {
        await new Promise((resolve) => {
          setTimeout(resolve, 50);
        });
        return { stop };
      }),
    });
    const logs = makeLogs();

    const startedAt = Date.now();
    const result = await startDiscovery([service], {
      discovery: { mdns: { mode: "full" } },
      logDiscovery: logs,
    });
    const elapsedMs = Date.now() - startedAt;

    await result.stop();

    expect(elapsedMs).toBeGreaterThanOrEqual(25);
    expect(logs.warn).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("skips local discovery services for truthy OPENCLAW_DISABLE_BONJOUR values", async () => {
    process.env.OPENCLAW_DISABLE_BONJOUR = "yes";

    const service = makeDiscoveryService("bonjour");
    const result = await startDiscovery([service], {
      discovery: { mdns: { mode: "full" } },
      tailscaleMode: "serve",
    });

    expect(service.advertise).not.toHaveBeenCalled();
    await result.stop();
  });

  it("logs a warning and skips zone writes when wide-area config is invalid", async () => {
    // Keep real domain validation at the Gateway boundary.
    const widearea = await vi.importActual<typeof import("../infra/widearea-dns.js")>(
      "../infra/widearea-dns.js",
    );
    mocks.resolveWideAreaDiscoveryDomain.mockImplementationOnce(
      widearea.resolveWideAreaDiscoveryDomain,
    );

    const logs = makeLogs();

    const result = await startDiscovery([], {
      discovery: { mdns: { mode: "off" }, wideArea: { domain: "foo/bar" } },
      gatewayTls: { enabled: false },
      tailscaleMode: "serve",
      logDiscovery: logs,
    });

    expect(mocks.writeWideAreaGatewayZone).not.toHaveBeenCalled();
    expect(logs.warn.mock.calls).toEqual([
      [
        "wide-area discovery was requested without a domain; set discovery.wideArea.domain to enable unicast DNS-SD",
      ],
    ]);
    await result.stop();
  });

  it("replaces advertisements and wide-area metadata across live mode changes", async () => {
    process.env.OPENCLAW_SSH_PORT = "2222";
    const stop = vi.fn();
    const service = makeDiscoveryService("bonjour", { stop });
    const discovery = await startDiscovery([service], {
      discovery: { mdns: { mode: "off" }, wideArea: { domain: "openclaw.internal." } },
      gatewayTls: { enabled: true, fingerprintSha256: "fingerprint" },
      gatewayDirectReachable: true,
      tailscaleMode: "serve",
    });

    for (const mode of ["minimal", "full", "minimal", "off"] as const) {
      await discovery.update({ mdnsMode: mode });
      const full = mode === "full";
      expect(latestZoneParams()).toMatchObject({
        domain: "openclaw.internal.",
        gatewayPort: 18789,
        gatewayTlsEnabled: true,
        gatewayTlsFingerprintSha256: "fingerprint",
        gatewayDirectReachable: true,
        cliPath: full ? "/usr/local/bin/openclaw" : undefined,
        sshPort: full ? 2222 : undefined,
      });
    }
    expect(service.advertise).toHaveBeenCalledTimes(3);
    expect(stop).toHaveBeenCalledTimes(3);
    expect(service.advertise).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ minimal: false, sshPort: 2222 }),
    );
    await discovery.update({ mdnsMode: undefined });
    expect(service.advertise).toHaveBeenLastCalledWith(
      expect.objectContaining({ minimal: true, cliPath: undefined, sshPort: undefined }),
    );
    await discovery.update({ mdnsMode: "minimal" });
    expect(service.advertise).toHaveBeenCalledTimes(4);
    await discovery.stop();
    await discovery.stop();
    expect(stop).toHaveBeenCalledTimes(4);
  });

  it.each(["ready", "pending"] as const)(
    "replaces a %s advertisement when the served TLS fingerprint changes",
    async (phase) => {
      const old = deferredAdvertisement("bonjour", phase);
      const oldStop = old.stop;
      const nextStop = vi.fn();
      const advertise = old.advertise
        .mockImplementationOnce(old.acquire)
        .mockResolvedValue({ stop: nextStop });
      const discovery = await startTimedDiscovery([old], {
        discovery: { mdns: { mode: "full" }, wideArea: { domain: "openclaw.internal." } },
        gatewayTls: { enabled: true, fingerprintSha256: "old-fingerprint" },
      });
      try {
        await discovery.update({ gatewayTlsFingerprintSha256: "next-fingerprint" });
        expect(advertise).toHaveBeenCalledTimes(2);
        expect(advertise).toHaveBeenLastCalledWith(
          expect.objectContaining({
            gatewayTlsEnabled: true,
            gatewayTlsFingerprintSha256: "next-fingerprint",
            minimal: false,
          }),
        );
        expect(latestZoneParams().gatewayTlsFingerprintSha256).toBe("next-fingerprint");
        expect(oldStop).toHaveBeenCalledTimes(phase === "ready" ? 1 : 0);

        old.resolve();
        await vi.advanceTimersByTimeAsync(0);
        expect(oldStop).toHaveBeenCalledOnce();
        expect(nextStop).not.toHaveBeenCalled();

        await discovery.update({ gatewayTlsFingerprintSha256: "next-fingerprint" });
        expect(advertise).toHaveBeenCalledTimes(2);
        expect(mocks.writeWideAreaGatewayZone).toHaveBeenCalledTimes(2);
      } finally {
        old.resolve();
        await vi.advanceTimersByTimeAsync(0);
        await discovery.stop();
      }
      expect(oldStop).toHaveBeenCalledOnce();
      expect(nextStop).toHaveBeenCalledOnce();
    },
  );

  it.each(["ready", "pending"] as const)(
    "retains an unchanged %s advertisement across selective replacement",
    async (phase) => {
      const retained = deferredAdvertisement("retained", phase);
      const retainedStop = retained.stop;
      const changedStop = vi.fn();
      const changed = makeDiscoveryService("changed", { stop: changedStop });
      const pluginOwner = createPluginOwner();
      const discovery = await startTimedDiscovery([changed, retained], {
        pluginRuntimeClaim: pluginOwner.currentClaim(),
      });
      const reservation = pluginOwner.reserve();
      try {
        await discovery.update({ gatewayDiscoveryServices: [retained] });
        expect(changedStop).toHaveBeenCalledOnce();
        expect(retainedStop).not.toHaveBeenCalled();
        const next = makeDiscoveryService("changed");
        reservation.commit();
        const updating = discovery.update(
          { gatewayDiscoveryServices: [next, retained] },
          reservation.claim,
        );
        await vi.advanceTimersByTimeAsync(10);
        await updating;
        retained.resolve();
        await vi.advanceTimersByTimeAsync(0);
        expect(retained.advertise).toHaveBeenCalledOnce();
        expect(retainedStop).not.toHaveBeenCalled();
        expect(next.advertise).toHaveBeenCalledOnce();
      } finally {
        reservation.reject();
        retained.resolve();
        await vi.advanceTimersByTimeAsync(0);
        await discovery.stop();
      }
      expect(retainedStop).toHaveBeenCalledOnce();
    },
  );

  it.each(["throw", "reject", "handle"] as const)(
    "retries a rejected advertisement on explicit update without repeating acquired work (%s)",
    async (failure) => {
      const stop = vi.fn();
      const failureError = new Error("advertisement unavailable");
      const advertise = vi.fn<Advertise>(() => Promise.resolve({ stop }));
      advertise.mockImplementationOnce(() => {
        if (failure === "throw") {
          throw failureError;
        }
        if (failure === "reject") {
          return Promise.reject(failureError);
        }
        return Promise.resolve({
          get stop(): () => void {
            throw failureError;
          },
        });
      });
      const service = makeDiscoveryService("retry", { advertise });
      const retainedStop = vi.fn();
      const retained = makeDiscoveryService("retained", { stop: retainedStop });
      const logs = makeLogs();
      const discovery = await startDiscovery([service, retained], {
        logDiscovery: logs,
      });
      try {
        expect(advertise).toHaveBeenCalledOnce();
        expect(logs.warn).toHaveBeenCalledWith(expect.stringContaining(failureError.message));
        for (let update = 0; update < 2; update++) {
          await discovery.update({ gatewayDiscoveryServices: [service, retained] });
          expect(advertise).toHaveBeenCalledTimes(failure === "handle" ? 1 : 2);
          expect(retained.advertise).toHaveBeenCalledOnce();
          expect(stop).not.toHaveBeenCalled();
          expect(retainedStop).not.toHaveBeenCalled();
        }
      } finally {
        await discovery.stop();
      }
      expect(stop).toHaveBeenCalledTimes(failure === "handle" ? 0 : 1);
      expect(retainedStop).toHaveBeenCalledOnce();
    },
  );

  it.each(["off", "shutdown"] as const)(
    "stops a timed-out advertiser that finishes after %s without resurrecting it",
    async (action) => {
      const late = deferredAdvertisement("late");
      const stop = late.stop;
      const discovery = await startTimedDiscovery([late]);
      if (action === "off") {
        await discovery.update({ mdnsMode: "off" });
      } else {
        await discovery.stop();
      }
      late.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(stop).toHaveBeenCalledOnce();
      await discovery.stop();
      expect(stop).toHaveBeenCalledOnce();
    },
  );

  it.each([
    { action: "replacement", olderGeneration: false, boundary: "stop" },
    { action: "shutdown", olderGeneration: false, boundary: "stop" },
    { action: "replacement", olderGeneration: true, boundary: "stop" },
    { action: "shutdown", olderGeneration: true, boundary: "stop" },
    { action: "replacement", olderGeneration: false, boundary: "DNS" },
    { action: "off", olderGeneration: false, boundary: "DNS" },
    { action: "replacement", olderGeneration: false, boundary: "advertise" },
  ] as const)(
    "drains cleanup acquired during $boundary before $action (older generation: $olderGeneration)",
    async ({ action, olderGeneration, boundary }) => {
      const lateAdvertisement = createDeferredCore<{ stop: () => Promise<void> }>();
      const activeStopping = createDeferredCore();
      const activeStopped = createDeferredCore();
      const metadata = createDeferredCore<string>();
      const lateStopped = createDeferredCore();
      const stopLate = vi.fn(() => lateStopped.promise);
      const next = makeDiscoveryService("next");
      const pause = () => {
        activeStopping.resolve();
        return activeStopped.promise;
      };
      const active = makeDiscoveryService(
        "active",
        boundary === "advertise" ? { advertise: pause } : { stop: pause },
      );
      const discovery = await startTimedDiscovery(
        [
          makeDiscoveryService("late", { advertise: () => lateAdvertisement.promise }),
          ...(boundary === "stop" && !olderGeneration ? [active] : []),
        ],
        action === "off" ? { discovery: { wideArea: { domain: "openclaw.internal." } } } : {},
      );
      if (olderGeneration) {
        await discovery.update({ gatewayDiscoveryServices: [active] });
      }
      if (boundary === "DNS") {
        mocks.resolveTailnetDnsHint.mockImplementationOnce(() => {
          activeStopping.resolve();
          return metadata.promise;
        });
      }
      let settled = false;
      const transition = (
        action === "replacement"
          ? discovery.update({
              gatewayDiscoveryServices: boundary === "advertise" ? [active, next] : [next],
            })
          : action === "off"
            ? discovery.update({ mdnsMode: "off" })
            : discovery.stop()
      ).then(() => {
        settled = true;
      });
      try {
        await activeStopping.promise;
        lateAdvertisement.resolve({ stop: stopLate });
        await vi.advanceTimersByTimeAsync(0);
        activeStopped.resolve();
        metadata.resolve("gateway.tailnet.example.ts.net");
        await vi.advanceTimersByTimeAsync(0);

        expect(stopLate).toHaveBeenCalledOnce();
        expect(settled).toBe(false);
        expect(next.advertise).not.toHaveBeenCalled();

        lateStopped.resolve();
        await transition;
        expect(settled).toBe(true);
        expect(next.advertise).toHaveBeenCalledTimes(action === "replacement" ? 1 : 0);
      } finally {
        activeStopped.resolve();
        metadata.resolve("gateway.tailnet.example.ts.net");
        lateAdvertisement.resolve({ stop: stopLate });
        lateStopped.resolve();
        await transition;
        await discovery.stop();
      }
      expect(stopLate).toHaveBeenCalledOnce();
    },
  );

  it("fences pending metadata resolution before advertising or writing a stale zone", async () => {
    const service = makeDiscoveryService("bonjour");
    const discovery = await startDiscovery([service], {
      discovery: { mdns: { mode: "off" }, wideArea: { domain: "openclaw.internal." } },
      tailscaleMode: "serve",
    });
    const resolving = createDeferredCore();
    const dns = createDeferredCore<string>();
    mocks.resolveTailnetDnsHint.mockImplementationOnce(() => {
      resolving.resolve();
      return dns.promise;
    });
    const full = discovery.update({ mdnsMode: "full" });
    await resolving.promise;
    const off = discovery.update({ mdnsMode: "off" });
    dns.resolve("gateway.tailnet.example.ts.net");
    await Promise.all([full, off]);
    expect(service.advertise).not.toHaveBeenCalled();
    expect(mocks.writeWideAreaGatewayZone).toHaveBeenCalledTimes(2);
    expect(latestZoneParams().cliPath).toBeUndefined();
    await discovery.stop();
    await discovery.update({ mdnsMode: "full" });
    expect(service.advertise).not.toHaveBeenCalled();
    expect(mocks.writeWideAreaGatewayZone).toHaveBeenCalledTimes(2);
  });

  it("consumes a shared advertisement once when overlapping updates retire it", async () => {
    const entered = createDeferredCore();
    const released = createDeferredCore();
    const stop = vi.fn(() => {
      entered.resolve();
      return released.promise;
    });
    const service = makeDiscoveryService("retained", { stop });
    const discovery = await startDiscovery([service]);
    const retaining = discovery.update({ gatewayDiscoveryServices: [service] });
    const disabling = discovery.update({ mdnsMode: "off" });
    try {
      await entered.promise;
      expect(stop).toHaveBeenCalledOnce();
      released.resolve();
      await Promise.all([retaining, disabling]);
      expect(stop).toHaveBeenCalledOnce();
      expect(service.advertise).toHaveBeenCalledOnce();
    } finally {
      released.resolve();
      await Promise.all([retaining, disabling]);
      await discovery.stop();
    }
    expect(stop).toHaveBeenCalledOnce();
  });

  it.each(["reject", "replace", "shutdown"] as const)(
    "settles a plugin reservation after an in-flight advertisement: %s",
    async (action) => {
      const pluginOwner = createPluginOwner();
      const old = deferredAdvertisement("old");
      const oldStop = old.stop;
      const peer = makeDiscoveryService("peer");
      const discovery = await startDiscovery([], {
        pluginRuntimeClaim: pluginOwner.currentClaim(),
        discovery: { mdns: { mode: "off" } },
      });
      await discovery.update({ gatewayDiscoveryServices: [old, peer] }, pluginOwner.currentClaim());
      const enabling = discovery.update({ mdnsMode: "full" });
      await old.started;
      const replacement = pluginOwner.reserve();
      old.resolve();
      await enabling;
      expect(oldStop).not.toHaveBeenCalled();
      expect(peer.advertise).not.toHaveBeenCalled();

      if (action === "reject") {
        replacement.reject();
        await vi.waitFor(() => expect(peer.advertise).toHaveBeenCalledOnce());
        expect(old.advertise).toHaveBeenCalledOnce();
        expect(oldStop).not.toHaveBeenCalled();
      } else if (action === "replace") {
        replacement.commit();
        // Runtime policy commits before the replacement registry is available.
        await discovery.update({ mdnsMode: "minimal" });
        expect(oldStop).toHaveBeenCalledOnce();
        expect(old.advertise).toHaveBeenCalledOnce();
        const next = makeDiscoveryService("next");
        await discovery.update({ gatewayDiscoveryServices: [next] }, replacement.claim);
        expect(next.advertise).toHaveBeenCalledWith(
          expect.objectContaining({ minimal: true, cliPath: undefined, sshPort: undefined }),
        );
      } else {
        await discovery.stop();
        replacement.reject();
        await pluginOwner.currentClaim().waitForUnblocked();
      }
      await discovery.stop();
      expect(oldStop).toHaveBeenCalledOnce();
      if (action !== "reject") {
        expect(peer.advertise).not.toHaveBeenCalled();
      }
    },
  );

  it("retires the initial registry before a first mixed plugin and mode reload", async () => {
    const pluginOwner = createPluginOwner();
    const oldStop = vi.fn();
    const old = makeDiscoveryService("old", { stop: oldStop });
    const discovery = await startDiscovery([old], {
      discovery: { mdns: { mode: "full" } },
      pluginRuntimeClaim: pluginOwner.currentClaim(),
    });
    try {
      const replacement = pluginOwner.reserve();
      replacement.commit();
      await discovery.update({ mdnsMode: "minimal" });
      expect(oldStop).toHaveBeenCalledOnce();
      expect(old.advertise).toHaveBeenCalledOnce();
      const next = makeDiscoveryService("next");
      await discovery.update({ gatewayDiscoveryServices: [next] }, replacement.claim);
      expect(next.advertise).toHaveBeenCalledWith(expect.objectContaining({ minimal: true }));
    } finally {
      await discovery.stop();
    }
  });
});
