import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deviceMailRoute,
  signDiscoveryRequest,
  type DeviceMailRequest,
} from "../../../packages/openclaw-id-protocol/src/index.js";
import { handleOpenClawIdDeviceMail } from "../server-methods/openclaw-id-device-mail.js";
import type { GatewayRequestHandlerOptions } from "../server-methods/types.js";
import { relayDeviceMail } from "./device-mail-relay.js";
import { linkedClaw, nowSeconds, serviceFor } from "./openclaw-id.test-support.js";

afterEach(() => vi.restoreAllMocks());

describe("owner-device mailbox relay", () => {
  it("forwards the exact D-signed body and certificate, without Gateway signatures", async () => {
    const claw = await linkedClaw();
    const body = '{"to":"owners","payload": {"kind":"enrollment"}}';
    const route = deviceMailRoute("send", claw.clawId, "0");
    const signature = await signDiscoveryRequest(
      { ...route, body: new TextEncoder().encode(body), ts: nowSeconds() },
      claw.device,
    );
    const request: DeviceMailRequest = {
      operation: "send",
      body,
      after: "0",
      signature,
      idToken: "test-id-token",
      certificate: claw.cert,
    };
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ sent: true }));
    expect(
      await relayDeviceMail({
        baseUrl: "https://discovery.test/",
        clawId: claw.clawId,
        request,
        activeCertificates: [claw.cert],
      }),
    ).toEqual({ status: 200, body: '{"sent":true}' });
    expect(fetchMock).toHaveBeenCalledWith(
      `https://discovery.test${route.path}`,
      expect.objectContaining({
        method: "POST",
        body,
        redirect: "error",
        headers: expect.objectContaining({
          "openclaw-signature": signature,
          "openclaw-owner-certificate": JSON.stringify(claw.cert),
        }),
      }),
    );
    for (const invalid of [
      { ...request, operation: "https://evil.test" },
      { ...request, after: "0&claw_id=other" },
      { ...request, body: body + " " },
      { ...request, idToken: "" },
    ]) {
      await expect(
        relayDeviceMail({
          baseUrl: "https://discovery.test",
          clawId: claw.clawId,
          request: invalid as DeviceMailRequest,
          activeCertificates: [claw.cert],
        }),
      ).rejects.toThrow();
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(
      relayDeviceMail({
        baseUrl: "https://discovery.test",
        clawId: claw.clawId,
        request,
        activeCertificates: [],
      }),
    ).rejects.toThrow();
  });

  it("returns approval context only to direct loopback or an active owner, never a member", async () => {
    const claw = await linkedClaw();
    const { service } = serviceFor(claw.authority);
    try {
      for (const [internal, allowed] of [
        [{ isLocalClient: true }, true],
        [{ isLocalClient: true, openclawIdPeerKey: claw.w1 }, true],
        [{ isLocalClient: true, openclawIdPeerKey: `iroh:${"00".repeat(32)}` }, false],
        [{ isLocalClient: false }, false],
      ] as const) {
        const respond = vi.fn();
        await handleOpenClawIdDeviceMail(
          {
            params: { operation: "context" },
            client: { internal },
            respond,
          } as unknown as GatewayRequestHandlerOptions,
          service,
        );
        expect(respond.mock.lastCall?.[0]).toBe(allowed);
        if (!allowed) {
          expect(respond.mock.lastCall?.[1]).toBeUndefined();
        }
      }
    } finally {
      await service.stop();
    }
  });

  it("gates both context and mailbox to current owners and withholds a late revoked response", async () => {
    const claw = await linkedClaw();
    const { service } = serviceFor(claw.authority);
    let active = false;
    vi.spyOn(service, "prepareOwnerClientCheck").mockResolvedValue(() => active);
    const respond = vi.fn();
    const options = {
      params: { operation: "context" },
      client: { internal: { isLocalClient: true } },
      context: {
        openclawIdService: service,
        getRuntimeConfig: () => ({
          gateway: { openclawId: { discoveryUrl: "https://discovery.test" } },
        }),
      },
      respond,
    } as unknown as GatewayRequestHandlerOptions;
    try {
      await handleOpenClawIdDeviceMail(options, service);
      expect(respond.mock.lastCall?.[0]).toBe(false);
      active = true;
      await handleOpenClawIdDeviceMail(options, service);
      expect(respond.mock.lastCall?.[1]).toMatchObject({
        binding: claw.authority.current()?.binding,
      });
      const route = deviceMailRoute("receive", claw.clawId, "0");
      const signature = await signDiscoveryRequest(
        { ...route, body: new Uint8Array(), ts: nowSeconds() },
        claw.device,
      );
      options.params = {
        operation: "receive",
        after: "0",
        body: "",
        idToken: "test-token",
        signature,
        certificate: claw.cert,
      };
      vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
        active = false;
        return Response.json({ private: "mail" });
      });
      await handleOpenClawIdDeviceMail(options, service);
      expect(respond.mock.lastCall?.[0]).toBe(false);
      expect(respond.mock.lastCall?.[1]).toBeUndefined();
      // Loopback remains an owner caller, but its removed D must not receive a late response.
      active = true;
      const before = await service.linkStatus();
      let revoked = false;
      vi.spyOn(service, "linkStatus").mockImplementation(
        async () =>
          ({ ...before, ownerDevices: revoked ? [] : before.ownerDevices }) as typeof before,
      );
      vi.mocked(fetch).mockImplementation(async () => {
        revoked = true;
        return Response.json({ private: "mail" });
      });
      await handleOpenClawIdDeviceMail(options, service);
      expect(respond.mock.lastCall?.[0]).toBe(false);
    } finally {
      await service.stop();
    }
  });
});
