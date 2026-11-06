import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyOpenClawIdDefaults } from "../../config/openclaw-id-defaults.js";
import type { GatewayOpenClawIdConfig } from "../../config/types.gateway.js";

// Every way the OpenClaw ID owner could start a process, open a socket or reach
// a remote service. With the Labs switch off none of them may run.
const effects = vi.hoisted(() => ({
  spawn: vi.fn(),
  fork: vi.fn(),
  execFile: vi.fn(),
  netCreateServer: vi.fn(),
  netConnect: vi.fn(),
  dgramCreateSocket: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: effects.spawn,
  fork: effects.fork,
  execFile: effects.execFile,
}));
vi.mock("node:net", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:net")>();
  return {
    ...actual,
    default: { ...actual, createServer: effects.netCreateServer, connect: effects.netConnect },
    createServer: effects.netCreateServer,
    connect: effects.netConnect,
  };
});
vi.mock("node:dgram", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:dgram")>();
  return {
    ...actual,
    default: { ...actual, createSocket: effects.dgramCreateSocket },
    createSocket: effects.dgramCreateSocket,
  };
});

const { createOpenClawIdService } = await import("./service.js");

const log = { info: vi.fn(), warn: vi.fn() };
let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  fetchSpy = vi.spyOn(globalThis, "fetch");
});

afterEach(() => {
  vi.clearAllMocks();
  fetchSpy.mockRestore();
});

function expectNoEffects() {
  for (const effect of Object.values(effects)) {
    expect(effect).not.toHaveBeenCalled();
  }
  expect(fetchSpy).not.toHaveBeenCalled();
}

describe("OpenClaw ID with the Labs switch off", () => {
  it.each<[string, GatewayOpenClawIdConfig | undefined]>([
    ["absent", undefined],
    ["explicitly off", { enabled: false }],
    [
      "off with every service configured",
      {
        enabled: false,
        issuerUrl: "https://issuer.example.test/api/auth",
        discoveryUrl: "https://discovery.example.test",
        relayUrl: "https://relay.example.test/",
        loaderDomain: "loader.example.test",
      },
    ],
  ])("starts no child, opens no sockets and calls no service when %s", async (_label, config) => {
    const service = createOpenClawIdService({
      getConfig: () =>
        applyOpenClawIdDefaults({ gateway: { openclawId: config } }).gateway?.openclawId,
      getStateDir: () => "/nonexistent/openclaw-id-inert-test",
      getGatewayServer: () => undefined,
      log,
    });

    await service.reconcileRuntimePolicy();
    expect(service.status()).toEqual({ state: "off" });
    await service.reconcileRuntimePolicy();
    await service.stop();

    expectNoEffects();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("reads only the local claw record for saved token bindings at Gateway start", async () => {
    const { createOpenClawIdAuthority } = await import("./authority.js");
    const { memoryStore } = await import("./openclaw-id.test-support.js");
    const service = createOpenClawIdService({
      getConfig: () => ({ enabled: false, relayUrl: "https://relay.example.test/" }),
      getStateDir: () => "/nonexistent/openclaw-id-inert-test",
      getGatewayServer: () => undefined,
      log,
      createAuthority: async () => createOpenClawIdAuthority(memoryStore()),
    });
    await service.loadTokenBindings();
    await service.reconcileRuntimePolicy();
    await service.stop();

    expectNoEffects();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("returns to inert after the switch turns off again", async () => {
    let config: GatewayOpenClawIdConfig | undefined = { enabled: true };
    const service = createOpenClawIdService({
      getConfig: () => config,
      getStateDir: () => "/nonexistent/openclaw-id-inert-test",
      getGatewayServer: () => undefined,
      log,
    });
    await service.reconcileRuntimePolicy();
    vi.clearAllMocks();

    config = { enabled: false, relayUrl: "https://relay.example.test/" };
    await service.reconcileRuntimePolicy();

    expect(service.status()).toEqual({ state: "off" });
    await expect(service.publish()).resolves.toBeUndefined();
    expectNoEffects();
  });
});
