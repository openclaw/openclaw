// Owner-key regeneration (OCF-319): the owner key is replaced only from the running
// Gateway on direct loopback. A RootRotation is refused over the tunnel, the mailbox
// and LAN, even with a valid root signature. Regeneration ends every older owner
// device, including connected ones, unfreezes a claw frozen by conflicting rotations,
// and owner certificates expire only when an expiry was set explicitly.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fingerprint,
  formatEd25519PublicKey,
  generateEd25519Signer,
  signStatement,
  type StatementSigner,
} from "../../../packages/openclaw-id-protocol/src/index.js";
import { openclawIdHandlers } from "../server-methods/openclaw-id.js";
import type { GatewayRequestHandlerOptions } from "../server-methods/types.js";
import {
  linkedClaw,
  nowSeconds,
  regenerationFor,
  serviceFor,
  TEST_K_SRV,
  type LinkedClaw,
} from "./openclaw-id.test-support.js";
import type { OpenClawIdService } from "./service.js";

const runtime = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("./tunnel-runtime.js", () => ({
  startTunnelRuntime: async (params: { settings: unknown }) => ({
    settings: params.settings,
    supervisor: { status: () => ({ state: "running", endpointKey: TEST_K_SRV }) },
    pushMembership: runtime.push,
    stop: async () => {},
  }),
}));

const PEER = `iroh:${"cd".repeat(32)}`;
// How each client reaches the Gateway, as the connection handshake records it.
const CLIENTS = {
  loopback: { internal: { isLocalClient: true } },
  tunnel: { internal: { isLocalClient: true, openclawIdPeerKey: PEER } },
  lan: { internal: {} },
} as const;

type Response = { ok: boolean; payload?: unknown; error?: { details?: { code?: string } } };

// Calls openclawId.authority as a client arriving on `via`.
async function callAuthority(
  service: OpenClawIdService,
  via: keyof typeof CLIENTS,
  params: Record<string, unknown>,
): Promise<Response> {
  let response: Response | undefined;
  await openclawIdHandlers["openclawId.authority"]!({
    params,
    client: CLIENTS[via],
    respond: (ok: boolean, payload?: unknown, error?: Response["error"]) => {
      response = { ok, payload, error };
    },
    context: {
      openclawIdService: service,
      getRuntimeConfig: () => ({ gateway: { openclawId: { enabled: true } } }),
    },
  } as unknown as GatewayRequestHandlerOptions);
  return response!;
}

// A RootRotation out of the current epoch, validly signed by the current root.
async function rotationBy(claw: LinkedClaw, root: StatementSigner = claw.root, epoch = 2) {
  const next = await generateEd25519Signer();
  return signStatement(
    "RootRotation",
    {
      old_root_fp: await fingerprint(formatEd25519PublicKey(root.publicKey)),
      new_root_pub: formatEd25519PublicKey(next.publicKey),
      new_epoch: epoch,
      issued_at: nowSeconds(),
    },
    root,
  );
}

// Prepares and signs a regeneration for the claw over loopback.
async function signedRegeneration(
  service: OpenClawIdService,
  options: Parameters<typeof regenerationFor>[1] = {},
) {
  const prep = await callAuthority(service, "loopback", { action: "prepare_regeneration" });
  expect(prep.ok).toBe(true);
  return regenerationFor(prep.payload as Parameters<typeof regenerationFor>[0], options);
}

function regenerateParams(input: Awaited<ReturnType<typeof regenerationFor>>["input"]) {
  return {
    action: "regenerate",
    rootPub: input.root_pub,
    ownerDevice: input.owner_device,
    binding: input.binding,
  };
}

beforeEach(() => {
  runtime.push.mockClear();
});

describe("remote RootRotation is refused", () => {
  it.each([
    ["tunnel", "not_local_operator"],
    ["lan", "not_direct"],
  ] as const)("refuses a validly signed rotation from %s", async (via, code) => {
    const claw = await linkedClaw();
    const { service } = serviceFor(claw.authority);
    const result = await callAuthority(service, via, {
      action: "submit",
      statement: await rotationBy(claw),
    });
    expect(result).toMatchObject({ ok: false, error: { details: { code } } });
    expect((await claw.authority.load())?.authority?.anchor.root_epoch).toBe(1);
  });

  it("refuses a validly signed rotation from the mailbox", async () => {
    const claw = await linkedClaw();
    expect(await claw.authority.submit(await rotationBy(claw), "mailbox")).toMatchObject({
      ok: false,
      code: "not_local_operator",
    });
    expect((await claw.authority.load())?.authority?.anchor.root_epoch).toBe(1);
  });

  it("points a loopback rotation at regeneration instead", async () => {
    const claw = await linkedClaw();
    const { service } = serviceFor(claw.authority);
    const result = await callAuthority(service, "loopback", {
      action: "submit",
      statement: await rotationBy(claw),
    });
    expect(result).toMatchObject({ ok: false, error: { details: { code: "unsupported" } } });
    expect((await claw.authority.load())?.authority?.anchor.root_epoch).toBe(1);
  });

  it.each(["tunnel", "lan"] as const)("refuses regeneration from %s", async (via) => {
    const claw = await linkedClaw();
    const { service } = serviceFor(claw.authority);
    expect(await callAuthority(service, via, { action: "prepare_regeneration" })).toMatchObject({
      ok: false,
      error: { details: { code: "not_local_operator" } },
    });
    const { input } = await signedRegeneration(service);
    expect(await callAuthority(service, via, regenerateParams(input))).toMatchObject({
      ok: false,
      error: { details: { code: "not_local_operator" } },
    });
    expect((await claw.authority.load())?.authority?.anchor.root_epoch).toBe(1);
  });
});

describe("owner-key regeneration on direct loopback", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("invalidates every older owner device, closes connected ones and enrolls the browser", async () => {
    const claw = await linkedClaw();
    const { service, effects } = serviceForRunning(claw);
    await service.reconcileRuntimePolicy();
    try {
      // D1 is connected over the tunnel and holds a tunnel-bound device token.
      await claw.authority.bindToken("device-d1", "operator", claw.w1);
      expect(await claw.authority.resolvePeer(claw.w1)).toMatchObject({ kind: "owner" });

      const { browser, input } = await signedRegeneration(service);
      const result = await callAuthority(service, "loopback", regenerateParams(input));
      expect(result).toMatchObject({ ok: true, payload: { regenerated: true } });

      expect(effects.captureConnections).toHaveBeenCalledWith([claw.w1]);
      expect(effects.closeConnections).toHaveBeenCalledWith([`conn-${claw.w1.slice(5, 9)}`]);
      expect(effects.revokeDeviceTokens).toHaveBeenCalledWith([
        { deviceId: "device-d1", role: "operator" },
      ]);
      expect(runtime.push).toHaveBeenLastCalledWith(2, []);
      expect(await claw.authority.resolvePeer(claw.w1)).toBeUndefined();
      expect(await claw.authority.ownerView(claw.w1)).toBeUndefined();

      const link = await service.linkStatus();
      expect(link).toMatchObject({ rootPub: input.root_pub, rootEpoch: 2, frozen: false });
      expect(link.ownerDevices?.map((device) => device.devicePub)).toEqual([
        formatEd25519PublicKey(browser.publicKey),
      ]);
      expect((await claw.authority.load())?.binding?.body).toMatchObject({
        binding_seq: 2,
        root_epoch: 2,
        k_srv: TEST_K_SRV,
      });

      // A change signed by the old owner device no longer verifies.
      expect(
        await service.submitStatement(
          "tunnel",
          await claw.sign({ op: "set_role", account_id: "acct_bob", role: "viewer" }),
        ),
      ).toMatchObject({ ok: false });
    } finally {
      await service.stop();
    }
  });

  it("unfreezes a claw frozen by conflicting rotations", async () => {
    const claw = await linkedClaw();
    const { service } = serviceFor(claw.authority);
    const first = await signedRegeneration(service);
    expect(await callAuthority(service, "loopback", regenerateParams(first.input))).toMatchObject({
      ok: true,
    });
    // The old root, stolen, signs a different rotation into the regenerated epoch.
    expect(await claw.authority.submit(await rotationBy(claw), "mailbox")).toMatchObject({
      ok: false,
      code: "conflicting_rotation",
    });
    expect(await service.linkStatus()).toMatchObject({ frozen: true });

    const second = await signedRegeneration(service);
    expect(await callAuthority(service, "loopback", regenerateParams(second.input))).toMatchObject({
      ok: true,
    });
    expect(await service.linkStatus()).toMatchObject({
      frozen: false,
      rootEpoch: 3,
      rootPub: second.input.root_pub,
    });
  });

  it("refuses statements prepared for an older state", async () => {
    const claw = await linkedClaw();
    const { service } = serviceFor(claw.authority);
    const stale = await signedRegeneration(service);
    const fresh = await signedRegeneration(service);
    expect(await callAuthority(service, "loopback", regenerateParams(fresh.input))).toMatchObject({
      ok: true,
    });
    expect(await callAuthority(service, "loopback", regenerateParams(stale.input))).toMatchObject({
      ok: false,
    });
    expect((await claw.authority.load())?.authority?.anchor.root_pub).toBe(fresh.input.root_pub);
  });
});

describe("owner certificate expiry after regeneration", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("issues the regenerated device's certificate without expiry by default", async () => {
    const claw = await linkedClaw();
    const { service } = serviceFor(claw.authority);
    const { input } = await signedRegeneration(service);
    await callAuthority(service, "loopback", regenerateParams(input));
    const [device] = (await service.linkStatus()).ownerDevices ?? [];
    expect(device?.cert.body.expires_at).toBeNull();
  });

  it("enforces an explicitly entered expiry", async () => {
    const start = Date.UTC(2026, 9, 31, 12, 0, 0);
    vi.useFakeTimers({ toFake: ["Date"], now: start });
    const claw = await linkedClaw();
    const { service } = serviceFor(claw.authority);
    const peer = `iroh:${"ef".repeat(32)}` as const;
    const { input } = await signedRegeneration(service, {
      expiresAt: Math.floor(start / 1000) + 60,
      peerKeys: [peer],
    });
    expect(await callAuthority(service, "loopback", regenerateParams(input))).toMatchObject({
      ok: true,
    });
    expect(await claw.authority.resolvePeer(peer)).toMatchObject({ kind: "owner" });
    vi.setSystemTime(start + 60_000);
    expect(await claw.authority.resolvePeer(peer)).toBeUndefined();
  });
});

// A service whose (mocked) tunnel runtime runs, so admission pushes are observable.
function serviceForRunning(claw: LinkedClaw) {
  return serviceFor(claw.authority, { enabled: true, relayUrl: "https://relay.example.test" });
}
