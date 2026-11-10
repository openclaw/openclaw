import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatIrohEndpointKey,
  randomBytes,
  signStatement,
  type IrohEndpointKey,
} from "../../../packages/openclaw-id-protocol/src/index.js";
import { stageGatewayKey } from "./gateway-key.js";
import { TEST_K_SRV, linkedClaw, serviceFor } from "./openclaw-id.test-support.js";
import * as tunnelRuntime from "./tunnel-runtime.js";

// A re-bind starts only once the claw's registration at Discovery is settled.
afterEach(() => {
  vi.restoreAllMocks();
});

const config = {
  enabled: true,
  discoveryUrl: "https://discovery.example.test",
  relayUrl: "https://relay.example.test/",
};

describe("re-bind before the registration receipt is settled", () => {
  it("is refused while Discovery cannot say whether it registered this claw", async () => {
    const claw = await linkedClaw();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status: 503 }));
    const { service } = serviceFor(claw.authority, config);
    expect(await service.rebind("prepare", "local_operator")).toMatchObject({
      ok: false,
      code: "registration_unsettled",
    });
    // Nothing was staged.
    expect(fs.readdirSync(path.join(claw.stateDir, "openclaw-id"))).toEqual(["gateway.key"]);
  });

  it("is refused when the Gateway key Discovery would know is gone", async () => {
    const claw = await linkedClaw();
    const fetch = vi.spyOn(globalThis, "fetch");
    fs.rmSync(path.join(claw.stateDir, "openclaw-id", "gateway.key"));
    const { service } = serviceFor(claw.authority, config);
    expect(await service.rebind("commit", "local_operator", {})).toMatchObject({
      ok: false,
      code: "registration_unsettled",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("is refused over the tunnel before anything else", async () => {
    const claw = await linkedClaw();
    const { service } = serviceFor(claw.authority, config);
    for (const action of ["prepare", "commit", "cancel"] as const) {
      expect(await service.rebind(action, "tunnel")).toMatchObject({
        ok: false,
        code: "not_local_operator",
      });
    }
  });
});

describe("re-bind lifetime", () => {
  it.each([
    ["stop", "prepare"],
    ["disable", "prepare"],
    ["stop", "commit"],
    ["disable", "commit"],
  ] as const)("refuses staging and queued work after %s during %s", async (end, action) => {
    const claw = await linkedClaw();
    await claw.authority.recordDiscovery({ owner_account_id: "owner" });
    const liveConfig = { ...config };
    const { service } = serviceFor(claw.authority, liveConfig);
    const nextEndpoint = formatIrohEndpointKey(randomBytes(32)) as IrohEndpointKey;
    let staged!: () => void;
    let release!: (key: typeof TEST_K_SRV) => void;
    const entered = new Promise<void>((resolve) => {
      staged = resolve;
    });
    const next = new Promise<typeof TEST_K_SRV>((resolve) => {
      release = resolve;
    });
    const stage = vi.spyOn(tunnelRuntime, "stageEndpointKey").mockImplementation(() => {
      staged();
      return next;
    });
    const input = {
      binding: await signStatement(
        "ServerBinding",
        {
          ...claw.authority.current()!.binding!.body,
          k_gw: stageGatewayKey(claw.stateDir),
          k_srv: nextEndpoint,
          binding_seq: 2,
        },
        claw.root,
      ),
    };
    const pending = service.rebind(action, "local_operator", input);
    await entered;
    const queued = service.rebind(action, "local_operator", input);
    if (end === "stop") {
      await service.stop();
    } else {
      liveConfig.enabled = false;
    }
    release(nextEndpoint);
    for (const result of await Promise.all([pending, queued])) {
      expect(result).toMatchObject({ ok: false, code: "rebind_cancelled" });
    }
    expect(stage).toHaveBeenCalledTimes(1);
    expect(claw.authority.current()?.binding?.body.binding_seq).toBe(1);
  });
  it("does not persist a binding when Labs is disabled during signature verification", async () => {
    const claw = await linkedClaw();
    await claw.authority.recordDiscovery({ owner_account_id: "owner" });
    const liveConfig = { ...config };
    const { service } = serviceFor(claw.authority, liveConfig);
    const nextEndpoint = formatIrohEndpointKey(randomBytes(32)) as IrohEndpointKey;
    vi.spyOn(tunnelRuntime, "stageEndpointKey").mockResolvedValue(nextEndpoint);
    const binding = await signStatement(
      "ServerBinding",
      {
        ...claw.authority.current()!.binding!.body,
        k_gw: stageGatewayKey(claw.stateDir),
        k_srv: nextEndpoint,
        binding_seq: 2,
      },
      claw.root,
    );
    const verify = crypto.subtle.verify.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, "verify").mockImplementation(async (...args) => {
      const verified = await verify(...args);
      liveConfig.enabled = false;
      return verified;
    });
    expect(await service.rebind("commit", "local_operator", { binding })).toMatchObject({
      ok: false,
      code: "rebind_cancelled",
    });
    expect(claw.authority.current()?.binding?.body.binding_seq).toBe(1);
    expect(claw.authority.current()?.discovery.publish_pending).not.toBe(true);
  });
});
