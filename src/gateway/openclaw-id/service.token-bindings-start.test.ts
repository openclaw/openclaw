import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawIdAuthority } from "./authority.js";
import {
  checkDeviceTokenPeer,
  setDeviceTokenBindingOwner,
  setDeviceTokenBindingsLoading,
} from "./device-token-binding.js";
import { linkedClaw, serviceFor } from "./openclaw-id.test-support.js";
import { createOpenClawIdService } from "./service.js";

afterEach(() => {
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
      getStateDir: () => "/nonexistent/openclaw-id-test",
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
