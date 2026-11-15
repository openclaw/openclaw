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
import { TEST_K_SRV, linkedClaw, memoryStore, serviceFor } from "./openclaw-id.test-support.js";
import { publicationPending } from "./publication-retry.js";
import { createServiceGatewayKey } from "./service-gateway-key.js";
import { createServiceRebind } from "./service-rebind.js";
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

describe("re-bind committed settlement", () => {
  it.each(["bookkeeping", "restart", "commit"] as const)(
    "preserves the actual move outcome when %s fails",
    async (failure) => {
      const store = memoryStore();
      const claw = await linkedClaw(store);
      await claw.authority.recordDiscovery({ owner_account_id: "owner", published_binding_seq: 1 });
      const before = await store.read();
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
      const write = store.write;
      let writes = 0;
      vi.spyOn(store, "write").mockImplementation(async (record) => {
        if (failure === "commit" || (failure === "bookkeeping" && writes > 0)) {
          throw new Error("storage full");
        }
        await write(record);
        writes++;
      });
      const restartRemoteAccess = vi.fn(async () => {
        if (failure === "restart") {
          throw new Error("restart failed");
        }
        return { state: "off" as const };
      });
      const deps = { getStateDir: () => claw.stateDir, getAuthority: async () => claw.authority };
      const owner = createServiceRebind({
        ...deps,
        getConfig: () => config,
        gatewayKey: createServiceGatewayKey(deps),
        restartRemoteAccess,
        holdCode: vi.fn(),
        log: { info: vi.fn() },
      });
      const result = owner.run("commit", "local_operator", { binding }, () => true);
      if (failure === "commit") {
        await expect(result).rejects.toThrow("storage full");
        expect((await store.read())?.binding?.body.binding_seq).toBe(1);
        expect(restartRemoteAccess).not.toHaveBeenCalled();
        return;
      }
      await expect(result).resolves.toMatchObject({
        ok: true,
        moved: true,
        bindingSeq: 2,
        ...(failure === "restart"
          ? {
              published: null,
              followUpError: "restart failed",
              nextStep: "openclaw id status",
            }
          : {}),
      });
      expect(writes).toBe(1);
      expect(publicationPending(await store.read())).toBe(true);
      expect((await store.read())?.binding).toEqual(binding);
      expect((await store.read())?.authority).toEqual(before?.authority);
      expect(restartRemoteAccess).toHaveBeenCalledOnce();
    },
  );
});

it("reports a committed move when the real service records a tunnel startup failure", async () => {
  const claw = await linkedClaw();
  await claw.authority.recordDiscovery({ owner_account_id: "owner", published_binding_seq: 1 });
  const nextEndpoint = formatIrohEndpointKey(randomBytes(32)) as IrohEndpointKey;
  vi.spyOn(tunnelRuntime, "stageEndpointKey").mockResolvedValue(nextEndpoint);
  const start = vi
    .spyOn(tunnelRuntime, "startTunnelRuntime")
    .mockRejectedValue(new Error("tunnel startup failed"));
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
  const { service } = serviceFor(claw.authority, config);
  try {
    await expect(service.rebind("commit", "local_operator", { binding })).resolves.toMatchObject({
      ok: true,
      moved: true,
      bindingSeq: 2,
      published: null,
      followUpError: "tunnel startup failed",
      nextStep: "openclaw id status",
    });
    expect(start).toHaveBeenCalledOnce();
    expect(service.status()).toEqual({ state: "failed", reason: "tunnel startup failed" });
    expect((await claw.store.read())?.binding).toEqual(binding);
    expect(publicationPending(await claw.store.read())).toBe(true);
  } finally {
    await service.stop();
  }
});
