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
  getTailnetHostname: vi.fn(async () => "gateway.tailnet.example.ts.net"),
}));

vi.mock("../infra/tailnet.js", () => ({
  pickPrimaryTailnetIPv4: mocks.pickPrimaryTailnetIPv4,
  pickPrimaryTailnetIPv6: mocks.pickPrimaryTailnetIPv6,
}));

vi.mock("../infra/widearea-dns.js", () => ({
  resolveWideAreaDiscoveryDomain: mocks.resolveWideAreaDiscoveryDomain,
  writeWideAreaGatewayZone: mocks.writeWideAreaGatewayZone,
}));

vi.mock("../infra/tailscale.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/tailscale.js")>()),
  getTailnetHostname: mocks.getTailnetHostname,
}));

const { startGatewayDiscovery } = await import("./server-discovery-runtime.js");
type Advertise = PluginGatewayDiscoveryServiceRegistration["service"]["advertise"];

const makeLogs = () => ({
  info: vi.fn(),
  warn: vi.fn(),
});
let logs = makeLogs();

type DiscoveryOptions = Partial<Parameters<typeof startGatewayDiscovery>[0]>;
const releases: Array<() => void> = [];
const disposals: Array<() => Promise<void>> = [];
const joins: Promise<unknown>[] = [];
async function startDiscovery(
  gatewayDiscoveryServices: readonly PluginGatewayDiscoveryServiceRegistration[],
  overrides: DiscoveryOptions = {},
) {
  const discovery = await startGatewayDiscovery({
    machineDisplayName: "Lab Mac",
    port: 18789,
    tailscaleMode: "serve",
    logDiscovery: logs,
    gatewayDiscoveryServices,
    ...overrides,
  });
  disposals.push(discovery.stop);
  return discovery;
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

function expectCalls(...calls: [unknown, number][]) {
  for (const [mock, count] of calls) {
    expect(mock).toHaveBeenCalledTimes(count);
  }
}

function useDevelopmentDiscoveryEnv() {
  process.env.NODE_ENV = "development";
  delete process.env.VITEST;
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
  releases.push(() => result.resolve({ stop }));
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
  beforeEach(() => {
    useDevelopmentDiscoveryEnv();
    process.env.OPENCLAW_CLI_PATH = "/usr/local/bin/openclaw";
    delete process.env.OPENCLAW_TAILNET_DNS;
    logs = makeLogs();
  });

  afterEach(async () => {
    try {
      // Release test-owned gates before joining the real discovery cleanup queue.
      for (const release of releases.splice(0)) {
        release();
      }
      if (vi.isFakeTimers()) {
        await vi.advanceTimersByTimeAsync(0);
      }
      await Promise.all(joins.splice(0));
      for (const dispose of disposals.splice(0).toReversed()) {
        await dispose();
      }
    } finally {
      vi.useRealTimers();
      envSnapshot.restore();
      vi.clearAllMocks();
      mocks.getTailnetHostname.mockReset();
      mocks.getTailnetHostname.mockResolvedValue("gateway.tailnet.example.ts.net");
    }
  });

  it("returns env hint when tailscale is disabled", async () => {
    process.env.OPENCLAW_TAILNET_DNS = "studio.tailnet.ts.net.";
    const service = makeDiscoveryService("bonjour");
    await startDiscovery([service], { tailscaleMode: "off" });
    expect(service.advertise).toHaveBeenCalledWith(
      expect.objectContaining({ tailnetDns: "studio.tailnet.ts.net" }),
    );
    expect(mocks.getTailnetHostname).not.toHaveBeenCalled();
  });

  it("skips tailscale lookup when disabled", async () => {
    const service = makeDiscoveryService("bonjour");
    await startDiscovery([service], { tailscaleMode: "off" });
    expect(service.advertise).toHaveBeenCalledWith(
      expect.objectContaining({ tailnetDns: undefined }),
    );
    expect(mocks.getTailnetHostname).not.toHaveBeenCalled();
  });

  it("uses tailscale lookup when enabled", async () => {
    mocks.getTailnetHostname.mockResolvedValue("host.tailnet.ts.net");
    const service = makeDiscoveryService("bonjour");
    await startDiscovery([service], { tailscaleMode: "serve" });
    expect(service.advertise).toHaveBeenCalledWith(
      expect.objectContaining({ tailnetDns: "host.tailnet.ts.net" }),
    );
    expect(mocks.getTailnetHostname).toHaveBeenCalledTimes(1);
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
    disposals.push(async () => {
      await instance.dispose();
    });
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
    const discovery = await startDiscovery(registry.gatewayDiscoveryServices);
    await discovery.stop();
    expect(calls).toEqual([
      { phase: "advertise", value: 37, runtime },
      { phase: "stop", value: 37, runtime },
    ]);
    expect(calls.every((call) => call.runtime === runtime)).toBe(true);
    await discovery.stop();
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
    const result = await startDiscovery([bonjour, peer], {
      discovery: { mdns: { mode: "full" } },
      gatewayTls: { enabled: true, fingerprintSha256: "abc123" },
      gatewayDirectReachable: true,
      tailscaleMode: "serve",
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
    vi.useFakeTimers();
    process.env.OPENCLAW_GATEWAY_DISCOVERY_ADVERTISE_TIMEOUT_MS = "10abc";
    const stuck = makeDiscoveryService("stuck-discovery", {
      advertise: vi.fn(() => new Promise<void>(() => {})),
    });
    const resultPromise = startDiscovery([stuck], { discovery: { mdns: { mode: "full" } } });
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
    const startedAt = Date.now();
    const result = await startDiscovery([service], {
      discovery: { mdns: { mode: "full" } },
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

    const result = await startDiscovery([], {
      discovery: { mdns: { mode: "off" }, wideArea: { domain: "foo/bar" } },
      gatewayTls: { enabled: false },
      tailscaleMode: "serve",
    });

    expect(mocks.writeWideAreaGatewayZone).not.toHaveBeenCalled();
    expect(logs.warn.mock.calls).toEqual([
      [
        "wide-area discovery was requested without a domain; set discovery.wideArea.domain to enable unicast DNS-SD",
      ],
    ]);
    await result.stop();
  });

  it("replaces advertisements and wide-area metadata across live mode and registry changes", async () => {
    process.env.OPENCLAW_SSH_PORT = "2222";
    const stop = vi.fn();
    const service = makeDiscoveryService("bonjour", { stop });
    const discovery = await startDiscovery([service], {
      discovery: { mdns: { mode: "full" }, wideArea: { domain: "openclaw.internal." } },
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
    expectCalls([service.advertise, 4], [stop, 4]);
    expect(service.advertise).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ minimal: false, sshPort: 2222 }),
    );
    await discovery.update({ mdnsMode: undefined });
    expect(service.advertise).toHaveBeenLastCalledWith(
      expect.objectContaining({ minimal: true, cliPath: undefined, sshPort: undefined }),
    );
    await discovery.update({ mdnsMode: "minimal" });
    expect(service.advertise).toHaveBeenCalledTimes(5);
    const next = makeDiscoveryService("next");
    await discovery.update({ gatewayDiscoveryServices: [next] });
    expect(stop).toHaveBeenCalledTimes(5);
    expect(next.advertise).toHaveBeenCalledWith(expect.objectContaining({ minimal: true }));
    await discovery.stop();
    await discovery.stop();
    expect(stop).toHaveBeenCalledTimes(5);
  });

  it.each(["ready", "pending"] as const)(
    "replaces %s advertisements on TLS fingerprint change",
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
      expectCalls([oldStop, 1], [nextStop, 0]);

      await discovery.update({ gatewayTlsFingerprintSha256: "next-fingerprint" });
      expectCalls([advertise, 2], [mocks.writeWideAreaGatewayZone, 2]);
      await discovery.stop();
      expectCalls([oldStop, 1], [nextStop, 1]);
    },
  );

  it.each(["ready", "pending"] as const)(
    "retains %s advertisements during selective replacement",
    async (phase) => {
      const retained = deferredAdvertisement("retained", phase);
      const retainedStop = retained.stop;
      const changedStop = vi.fn();
      const changed = makeDiscoveryService("changed", { stop: changedStop });
      const discovery = await startTimedDiscovery([changed, retained]);
      await discovery.update({ gatewayDiscoveryServices: [retained] });
      expectCalls([changedStop, 1], [retainedStop, 0]);
      const next = makeDiscoveryService("changed");
      const updating = discovery.update({ gatewayDiscoveryServices: [next, retained] });
      await vi.advanceTimersByTimeAsync(10);
      await updating;
      retained.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expectCalls([retained.advertise, 1], [retainedStop, 0], [next.advertise, 1]);
      await discovery.stop();
      expect(retainedStop).toHaveBeenCalledOnce();
    },
  );

  it.each(["throw", "reject", "handle"] as const)(
    "retries %s acquisition without repeating acquired work",
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
      const discovery = await startDiscovery([service, retained]);
      expect(advertise).toHaveBeenCalledOnce();
      expect(logs.warn).toHaveBeenCalledWith(expect.stringContaining(failureError.message));
      for (let update = 0; update < 2; update++) {
        await discovery.update({ gatewayDiscoveryServices: [service, retained] });
        expect(advertise).toHaveBeenCalledTimes(failure === "handle" ? 1 : 2);
        expectCalls([retained.advertise, 1], [stop, 0], [retainedStop, 0]);
      }
      await discovery.stop();
      expectCalls([stop, failure === "handle" ? 0 : 1], [retainedStop, 1]);
    },
  );

  it.each(["off", "shutdown"] as const)("retires late advertisements after %s", async (action) => {
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
  });

  it.each([
    { action: "replacement", olderGeneration: false, boundary: "stop" },
    { action: "shutdown", olderGeneration: false, boundary: "stop" },
    { action: "replacement", olderGeneration: true, boundary: "stop" },
    { action: "shutdown", olderGeneration: true, boundary: "stop" },
    { action: "replacement", olderGeneration: false, boundary: "DNS" },
    { action: "off", olderGeneration: false, boundary: "DNS" },
    { action: "replacement", olderGeneration: false, boundary: "advertise" },
  ] as const)(
    "drains $boundary before $action (older: $olderGeneration)",
    async ({ action, olderGeneration, boundary }) => {
      const lateAdvertisement = createDeferredCore<{ stop: () => Promise<void> }>();
      const activeStopping = createDeferredCore();
      const activeStopped = createDeferredCore();
      const metadata = createDeferredCore<string>();
      const lateStopped = createDeferredCore();
      const stopLate = vi.fn(() => lateStopped.promise);
      releases.push(() => {
        activeStopped.resolve();
        metadata.resolve("gateway.tailnet.example.ts.net");
        lateAdvertisement.resolve({ stop: stopLate });
        lateStopped.resolve();
      });
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
        mocks.getTailnetHostname.mockImplementationOnce(() => {
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
      joins.push(transition);
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
      await discovery.stop();
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
    releases.push(() => dns.resolve("gateway.tailnet.example.ts.net"));
    mocks.getTailnetHostname.mockImplementationOnce(() => {
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
    releases.push(() => released.resolve());
    const stop = vi.fn(() => {
      entered.resolve();
      return released.promise;
    });
    const service = makeDiscoveryService("retained", { stop });
    const discovery = await startDiscovery([service]);
    const retaining = discovery.update({ gatewayDiscoveryServices: [service] });
    const disabling = discovery.update({ mdnsMode: "off" });
    joins.push(retaining, disabling);
    await entered.promise;
    expect(stop).toHaveBeenCalledOnce();
    released.resolve();
    await Promise.all([retaining, disabling]);
    expect(stop).toHaveBeenCalledOnce();
    expect(service.advertise).toHaveBeenCalledOnce();
    await discovery.stop();
    expect(stop).toHaveBeenCalledOnce();
  });
});
