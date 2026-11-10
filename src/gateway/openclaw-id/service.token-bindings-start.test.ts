import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import { createOpenClawIdAuthority } from "./authority.js";
import type { OpenClawIdAuthority } from "./authority.js";
import {
  checkDeviceTokenPeer,
  recordDeviceTokenPeer,
  setDeviceTokenBindingOwner,
  setDeviceTokenBindingsLoading,
} from "./device-token-binding.js";
import { linkedClaw, serviceFor, TEST_K_SRV } from "./openclaw-id.test-support.js";
import { createOpenClawIdService } from "./service.js";
import {
  prepareOpenClawIdTunnelPrincipal,
  isOpenClawIdTunnelPrincipalCurrent,
  setOpenClawIdTunnelPrincipalLookup,
  setOpenClawIdTunnelPrincipalResolver,
} from "./tunnel-principal.js";

// Runs where the native tunnel would first admit a device.
const tunnel = vi.hoisted(() => ({ started: undefined as (() => Promise<void>) | undefined }));
// mock-isolation: the native tunnel child stays out of these service lifecycle tests.
vi.mock("./tunnel-runtime.js", () => ({
  startTunnelRuntime: async (params: { settings: unknown }) => {
    await tunnel.started?.();
    return {
      settings: params.settings,
      supervisor: { status: () => ({ state: "running", endpointKey: TEST_K_SRV }) },
      pushMembership: vi.fn(),
      stop: async () => {},
    };
  },
}));

afterEach(() => {
  tunnel.started = undefined;
  setOpenClawIdTunnelPrincipalLookup(undefined);
  setOpenClawIdTunnelPrincipalResolver(undefined);
  setDeviceTokenBindingOwner(undefined);
  setDeviceTokenBindingsLoading(Promise.resolve());
});

const ordinary = (deviceId: string) =>
  checkDeviceTokenPeer({ deviceId, role: "operator", peerKey: undefined });

describe("saved device-token bindings at Gateway start", () => {
  it("keep a tunnel-issued token refused on ordinary ingress after a restart with the switch off", async () => {
    const claw = await linkedClaw();
    await claw.authority.bindToken("browser-a", "operator", claw.w1);
    // A fresh service stands for a Gateway started with the switch already off.
    const { service, log } = serviceFor(claw.authority, { enabled: false });
    void service.loadTokenBindings();
    await service.reconcileRuntimePolicy();
    expect(service.status()).toEqual({ state: "off" });
    expect(await ordinary("browser-a")).toEqual({
      ok: false,
      reason: "device-token-peer-mismatch",
    });
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("refused device token"));
    // Tokens that were never issued over the tunnel are unaffected.
    expect(await ordinary("laptop")).toEqual({ ok: true });
  });

  it("make a check that arrives before the read finishes wait for it", async () => {
    const claw = await linkedClaw();
    await claw.authority.bindToken("browser-a", "operator", claw.w1);
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = createOpenClawIdService({
      getConfig: () => ({ enabled: false }),
      getStateDir: () => claw.stateDir,
      getGatewayServer: () => undefined,
      log: { info: () => {}, warn: () => {} },
      createAuthority: async () => {
        await gate;
        return claw.authority;
      },
    });
    const loaded = service.loadTokenBindings();
    const early = ordinary("browser-a");
    release();
    await loaded;
    await expect(early).resolves.toMatchObject({ ok: false });
  });

  it("publish the writer before the tunnel can issue a device token", async () => {
    const claw = await linkedClaw();
    const { service } = serviceFor(claw.authority, {
      enabled: true,
      relayUrl: "https://relay.test/",
    });
    // A Gateway start with no saved bindings publishes no writer of its own.
    await service.loadTokenBindings();
    tunnel.started = () =>
      recordDeviceTokenPeer({ deviceId: "early-phone", role: "operator", peerKey: claw.w1 });
    try {
      await service.reconcileRuntimePolicy();
      expect(service.status()).toMatchObject({ state: "on", tunnel: { state: "running" } });
      expect(claw.authority.tokenBinding("early-phone", "operator")).toBe(claw.w1);
      expect(await ordinary("early-phone")).toMatchObject({ ok: false });
    } finally {
      await service.stop();
    }
  });

  it("publish nothing when the claw record holds no bindings", async () => {
    const claw = await linkedClaw();
    const { service } = serviceFor(claw.authority, { enabled: false });
    await service.loadTokenBindings();
    await claw.authority.bindToken("browser-a", "operator", claw.w1);
    expect(await ordinary("browser-a")).toEqual({ ok: true });
  });

  it("refuse every device token when the claw record cannot be read", async () => {
    const unreadable = {
      load: async () => {
        throw new Error("state database is locked");
      },
    } as unknown as OpenClawIdAuthority;
    const { service, log } = serviceFor(unreadable, { enabled: false });
    await service.loadTokenBindings();
    expect(await ordinary("laptop")).toEqual({
      ok: false,
      reason: "device-token-bindings-unreadable",
    });
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("could not read device-token bindings"),
    );
  });
});

it("hydrates recovery authority locally before tunnel startup and keeps it through an unconfigured relay", async () => {
  const claw = await linkedClaw();
  const principal = (await claw.authority.resolvePeer(claw.w1))!;
  const before = structuredClone((await claw.authority.load())?.authority);
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const service = createOpenClawIdService({
    getConfig: () => ({ enabled: true }),
    getStateDir: () => claw.stateDir,
    getGatewayServer: () => {
      throw new Error("recovery must not start a tunnel");
    },
    log: { info: () => {}, warn: () => {} },
    createAuthority: async () => {
      entered.resolve();
      await release.promise;
      return claw.authority;
    },
  });
  try {
    const pending = prepareOpenClawIdTunnelPrincipal(principal);
    await entered.promise;
    expect(isOpenClawIdTunnelPrincipalCurrent(principal)).toBe(false);
    release.resolve();
    await pending;
    await service.reconcileRuntimePolicy();
    expect(service.status()).toMatchObject({ state: "unconfigured" });
    expect(isOpenClawIdTunnelPrincipalCurrent(principal)).toBe(true);
    expect((await claw.authority.load())?.authority).toEqual(before);
  } finally {
    release.resolve();
    await service.stop();
  }
  await expect(prepareOpenClawIdTunnelPrincipal(principal)).rejects.toThrow();
});

it("makes concurrent source recovery join the same pending authority load", async () => {
  const claw = await linkedClaw();
  const principal = (await claw.authority.resolvePeer(claw.w1))!;
  const owner = createOpenClawIdAuthority(claw.store);
  const load = owner.load;
  const entered = createDeferredCore();
  const release = createDeferredCore();
  vi.spyOn(owner, "load").mockImplementation(async () => {
    entered.resolve();
    await release.promise;
    return await load();
  });
  const service = createOpenClawIdService({
    getConfig: () => ({ enabled: true }),
    getStateDir: () => claw.stateDir,
    getGatewayServer: () => undefined,
    log: { info: () => {}, warn: () => {} },
    createAuthority: async () => owner,
  });
  const first = prepareOpenClawIdTunnelPrincipal(principal);
  const pending = [first];
  try {
    await entered.promise;
    const second = prepareOpenClawIdTunnelPrincipal(principal);
    // Attach before advancing microtasks; both callers must wait, not reject an empty resident view.
    pending.push(second);
    const joined = Promise.all(pending);
    void joined.catch(() => {});
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    release.resolve();
    await joined;
  } finally {
    release.resolve();
    await Promise.allSettled(pending);
    await service.stop();
  }
});

it("keeps a stopped Gateway from observing or publishing after a late cold load", async () => {
  const claw = await linkedClaw();
  await claw.authority.bindToken("browser-a", "operator", claw.w1);
  const principal = (await claw.authority.resolvePeer(claw.w1))!;
  const owner = createOpenClawIdAuthority(claw.store);
  const observe = vi.spyOn(owner, "onPeopleChanged");
  const expiry = vi.spyOn(owner, "nextOwnerExpiry");
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const service = createOpenClawIdService({
    getConfig: () => ({ enabled: true }),
    getStateDir: () => claw.stateDir,
    getGatewayServer: () => undefined,
    log: { info: () => {}, warn: () => {} },
    createAuthority: async () => {
      entered.resolve();
      await release.promise;
      return owner;
    },
  });
  // Recovery and the startup binding read both wait on the first cold authority load.
  const late = [prepareOpenClawIdTunnelPrincipal(principal), service.loadTokenBindings()];
  await entered.promise;
  await service.stop();
  release.resolve();
  await Promise.allSettled(late);
  await service.reconcileRuntimePolicy();
  expect(observe).not.toHaveBeenCalled();
  expect(expiry).not.toHaveBeenCalled();
  expect(isOpenClawIdTunnelPrincipalCurrent(principal)).toBe(false);
  expect(await ordinary("browser-a")).toEqual({ ok: true });
  expect(service.status()).toEqual({ state: "off" });
});
