// With the Labs switch off, the openclawId.* methods answer nothing about the claw,
// even to the direct-loopback operator and even when a linked claw record exists.
import { describe, expect, it } from "vitest";
import type { GatewayOpenClawIdConfig } from "../../config/types.gateway.js";
import { openclawIdHandlers } from "../server-methods/openclaw-id.js";
import type { GatewayRequestHandlerOptions } from "../server-methods/types.js";
import { linkedClaw, serviceFor } from "./openclaw-id.test-support.js";

const loopback = { internal: { isLocalClient: true } };

describe.each<[string, GatewayOpenClawIdConfig | undefined]>([
  ["absent", undefined],
  ["explicitly off", { enabled: false }],
])("OpenClaw ID methods with the Labs switch %s", (_label, config) => {
  it("refuses people and every authority action and reports no link", async () => {
    const claw = await linkedClaw();
    // serviceFor defaults to enabled; an empty block is the absent switch.
    const { service } = serviceFor(claw.authority, config ?? {});
    const call = async (method: string, params: Record<string, unknown> = {}) => {
      let response: { ok: boolean; payload?: Record<string, unknown> } | undefined;
      await openclawIdHandlers[method]!({
        params,
        client: loopback,
        respond: (ok: boolean, payload?: Record<string, unknown>) => {
          response = { ok, payload };
        },
        context: {
          openclawIdService: service,
          getRuntimeConfig: () => ({ gateway: { openclawId: config } }),
        },
      } as unknown as GatewayRequestHandlerOptions);
      return response!;
    };

    for (const action of ["check_name", "prepare", "commit", "publish", "submit", "device_mail"]) {
      expect((await call("openclawId.authority", { action })).ok, action).toBe(false);
    }
    expect((await call("openclawId.people")).ok).toBe(false);
    for (const action of ["device_begin", "device_poll"]) {
      expect((await call("openclawId.account", { action })).ok, action).toBe(false);
    }
    expect((await call("openclawId.status")).payload).toMatchObject({
      status: { state: "off" },
      link: { linked: false },
      owner: false,
    });
  });
});
