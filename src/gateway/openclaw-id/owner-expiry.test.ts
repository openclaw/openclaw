// Owner certificate expiry (OCF-278) and the inactivity drop: an owner device whose
// certificate has expired is not the Gateway owner, is not admitted to the tunnel, and
// loses the sessions it already had open at the expiry boundary. A device unused past
// the inactivity window is dropped from the allowlist; the devices it approved stay.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  formatEd25519PublicKey,
  formatIrohEndpointKey,
  generateEd25519Signer,
  OWNER_CAPABILITIES,
  randomBytes,
  signStatement,
  type StatementSigner,
} from "../../../packages/openclaw-id-protocol/src/index.js";
import { createOpenClawIdAuthority } from "./authority.js";
import {
  linkedClaw,
  nowSeconds,
  serviceFor,
  TEST_K_SRV,
  type LinkedClaw,
} from "./openclaw-id.test-support.js";
import { createOpenClawIdService, type OpenClawIdEffects } from "./service.js";
import {
  isOpenClawIdTunnelPrincipalCurrent,
  onOpenClawIdTunnelPrincipalsChanged,
  prepareOpenClawIdTunnelPrincipal,
} from "./tunnel-principal.js";

const runtime = vi.hoisted(() => ({ push: vi.fn(), start: vi.fn() }));
// mock-isolation: the native tunnel runtime and Discovery mailbox loop stay out of these service tests.
vi.mock("./tunnel-runtime.js", () => ({
  startTunnelRuntime: async (params: { settings: unknown }) => {
    runtime.start();
    return {
      settings: params.settings,
      supervisor: { status: () => ({ state: "running", endpointKey: TEST_K_SRV }) },
      pushMembership: runtime.push,
      stop: async () => {},
    };
  },
}));

const START = Date.UTC(2026, 9, 31, 12, 0, 0);

// An owner device certificate signed by `issuer`, valid from `issuedAt`.
async function ownerCert(
  issuer: StatementSigner,
  window: { issued_at?: number; expires_at: number | null },
) {
  const device = await generateEd25519Signer();
  const peerKey = formatIrohEndpointKey(randomBytes(32));
  const cert = await signStatement(
    "OwnerDeviceCert",
    {
      device_pub: formatEd25519PublicKey(device.publicKey),
      peer_keys: [peerKey],
      label: "laptop",
      scope: "owner",
      caps: [...OWNER_CAPABILITIES],
      issued_at: nowSeconds(),
      root_epoch: 1,
      ...window,
    },
    issuer,
  );
  return { device, peerKey, cert };
}

// Enrolls a device certified by `issuer` through `claw.authority`, signed by that issuer.
async function enroll(
  claw: LinkedClaw,
  issuer: { signer: StatementSigner },
  window: { issued_at?: number; expires_at: number | null },
) {
  const added = await ownerCert(issuer.signer, window);
  const seq = ((await claw.authority.load())?.authority?.seq ?? 0) + 1;
  const change = await signStatement(
    "MembershipChange",
    {
      claw_id: claw.clawId,
      seq,
      target: { op: "add_owner_device", cert: added.cert },
      issued_at: nowSeconds(),
    },
    issuer.signer,
  );
  return { ...added, change };
}

// Lets WebCrypto and file-free async work settle while timers are faked.
async function settle(check: () => boolean) {
  for (let i = 0; i < 500 && !check(); i += 1) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], now: START });
  runtime.push.mockClear();
  runtime.start.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("owner certificate expiry at the Gateway", () => {
  it("stops treating a device as owner once its certificate expires", async () => {
    const claw = await linkedClaw();
    const d1 = { signer: claw.device };
    const d2 = await enroll(claw, d1, { expires_at: nowSeconds() + 60 });
    expect(await claw.authority.submit(d2.change, "tunnel")).toMatchObject({ ok: true });
    expect(await claw.authority.resolvePeer(d2.peerKey)).toMatchObject({
      kind: "owner",
      peerKey: d2.peerKey,
    });
    vi.setSystemTime(START + 60_000);
    expect(await claw.authority.resolvePeer(d2.peerKey)).toBeUndefined();
    expect(await claw.authority.ownerView(d2.peerKey)).toBeUndefined();
    expect((await claw.authority.admittedPeerKeys()).admitted).toEqual([claw.w1]);
    expect(await claw.authority.resolvePeer(claw.w1)).toMatchObject({ kind: "owner" });
  });

  it("keeps a device whose approver's certificate expired", async () => {
    const claw = await linkedClaw();
    const d2 = await enroll(
      claw,
      { signer: claw.device },
      {
        expires_at: nowSeconds() + 60,
      },
    );
    expect(await claw.authority.submit(d2.change, "tunnel")).toMatchObject({ ok: true });
    const d3 = await enroll(claw, { signer: d2.device }, { expires_at: null });
    expect(await claw.authority.submit(d3.change, "tunnel")).toMatchObject({ ok: true });
    expect(await claw.authority.resolvePeer(d3.peerKey)).toMatchObject({ kind: "owner" });
    vi.setSystemTime(START + 60_000);
    expect(await claw.authority.resolvePeer(d2.peerKey)).toBeUndefined();
    expect(await claw.authority.resolvePeer(d3.peerKey)).toMatchObject({ kind: "owner" });
  });

  it.each([
    ["expired", { expires_at: Math.floor(START / 1000) - 1 }],
    ["not_yet_valid", { issued_at: Math.floor(START / 1000) + 3600, expires_at: null }],
  ] as const)("refuses to enroll an owner certificate that is %s", async (code, window) => {
    const claw = await linkedClaw();
    const added = await enroll(claw, { signer: claw.device }, window);
    expect(await claw.authority.submit(added.change, "tunnel")).toMatchObject({ ok: false, code });
    expect(await claw.authority.resolvePeer(added.peerKey)).toBeUndefined();
  });

  it("closes an already-connected owner device's sessions when its certificate expires", async () => {
    const claw = await linkedClaw();
    const effects: OpenClawIdEffects = {
      captureConnections: vi.fn((keys: readonly string[]) => keys.map((key) => `conn-${key}`)),
      cancelRuns: vi.fn(async () => 0),
      closeConnections: vi.fn(),
      revokeDeviceTokens: vi.fn(async (tokens) => [...tokens]),
    };
    const service = createOpenClawIdService({
      getConfig: () => ({ enabled: true, relayUrl: "https://relay.example.test" }),
      getStateDir: () => claw.stateDir,
      getGatewayServer: () => undefined,
      log: { info: vi.fn(), warn: vi.fn() },
      createAuthority: async () => claw.authority,
    });
    service.bindEffects(async () => effects);
    await service.reconcileRuntimePolicy();
    const peopleChanged = vi.fn();
    const stopPeopleChanges = service.onPeopleChanged(peopleChanged);
    try {
      const d2 = await enroll(
        claw,
        { signer: claw.device },
        {
          expires_at: nowSeconds() + 60,
        },
      );
      expect(await service.submitStatement("tunnel", d2.change)).toMatchObject({ ok: true });
      expect(runtime.push).toHaveBeenLastCalledWith(2, [claw.w1, d2.peerKey].toSorted());
      expect(effects.closeConnections).not.toHaveBeenCalled();
      peopleChanged.mockClear();

      await vi.advanceTimersByTimeAsync(59_000);
      expect(effects.closeConnections).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1_000);
      await settle(() => vi.mocked(effects.closeConnections).mock.calls.length > 0);

      expect(effects.captureConnections).toHaveBeenCalledWith([d2.peerKey]);
      expect(effects.closeConnections).toHaveBeenCalledWith([`conn-${d2.peerKey}`]);
      expect(runtime.push).toHaveBeenLastCalledWith(2, [claw.w1]);
      expect(peopleChanged).toHaveBeenCalledOnce();
    } finally {
      stopPeopleChanges();
      await service.stop();
    }
  });

  it("drops an owner device unused past the configured window, keeping the devices it approved", async () => {
    const claw = await linkedClaw();
    const d2 = await enroll(claw, { signer: claw.device }, { expires_at: null });
    expect(await claw.authority.submit(d2.change, "tunnel")).toMatchObject({ ok: true });
    const effects: OpenClawIdEffects = {
      captureConnections: vi.fn((keys: readonly string[]) => keys.map((key) => `conn-${key}`)),
      cancelRuns: vi.fn(async () => 0),
      closeConnections: vi.fn(),
      revokeDeviceTokens: vi.fn(async (tokens) => [...tokens]),
    };
    const service = createOpenClawIdService({
      getConfig: () => ({
        enabled: true,
        relayUrl: "https://relay.example.test",
        ownerDeviceInactivityDays: 1,
      }),
      getStateDir: () => claw.stateDir,
      getGatewayServer: () => undefined,
      log: { info: vi.fn(), warn: vi.fn() },
      createAuthority: async () => claw.authority,
    });
    service.bindEffects(async () => effects);
    await service.reconcileRuntimePolicy();
    try {
      // d2 reaches the claw after 12 hours; D1 (which approved it) never does again.
      await vi.advanceTimersByTimeAsync(12 * 3600_000);
      await claw.authority.recordSeen(d2.peerKey);
      await vi.advanceTimersByTimeAsync(12 * 3600_000 + 2_000);
      await settle(() => vi.mocked(effects.closeConnections).mock.calls.length > 0);
      expect(effects.captureConnections).toHaveBeenCalledWith([claw.w1]);
      expect(await claw.authority.resolvePeer(claw.w1)).toBeUndefined();
      expect(await claw.authority.resolvePeer(d2.peerKey)).toMatchObject({ kind: "owner" });
      expect(runtime.push).toHaveBeenLastCalledWith(2, [d2.peerKey]);
    } finally {
      await service.stop();
    }
  });

  it.each(["unconfigured", "failed"] as const)(
    "expires recovered owner and member sources once while remote access is %s",
    async (remoteState) => {
      const claw = await linkedClaw();
      const memberKey = formatIrohEndpointKey(randomBytes(32));
      const add = await claw.sign({
        op: "add",
        account_id: "member",
        role: "operator",
        peer_keys: [memberKey],
        invite_id: null,
      });
      expect(await claw.authority.submit(add, "tunnel")).toMatchObject({ ok: true });
      const ownerSource = (await claw.authority.resolvePeer(claw.w1))!;
      const memberSource = (await claw.authority.resolvePeer(memberKey))!;
      const { service, effects } = serviceFor(
        createOpenClawIdAuthority(claw.store),
        {
          enabled: true,
          ownerDeviceInactivityDays: 1,
          memberDeviceInactivityDays: 2,
          ...(remoteState === "failed" ? { relayUrl: "https://relay.example.test" } : {}),
        },
        claw.stateDir,
      );
      runtime.start.mockImplementation(() => {
        throw new Error("relay unavailable");
      });
      const peopleChanged = vi.fn();
      const sourceChanged = vi.fn();
      let stopSources = () => {};
      const stopPeople = service.onPeopleChanged(peopleChanged);
      try {
        // Recovery hydrates local authority without recording a fresh tunnel admission.
        await prepareOpenClawIdTunnelPrincipal(ownerSource);
        await prepareOpenClawIdTunnelPrincipal(memberSource);
        await service.reconcileRuntimePolicy();
        expect(service.status()).toMatchObject({ state: remoteState });
        expect(runtime.start).toHaveBeenCalledTimes(remoteState === "failed" ? 1 : 0);
        expect(isOpenClawIdTunnelPrincipalCurrent(ownerSource)).toBe(true);
        expect(isOpenClawIdTunnelPrincipalCurrent(memberSource)).toBe(true);
        stopSources = onOpenClawIdTunnelPrincipalsChanged(sourceChanged);

        // The protocol drops only after the whole inactivity window has elapsed.
        await vi.advanceTimersByTimeAsync(86_400_000);
        expect(effects.closeConnections).not.toHaveBeenCalled();
        expect(isOpenClawIdTunnelPrincipalCurrent(ownerSource)).toBe(true);
        await vi.advanceTimersByTimeAsync(1_000);
        await settle(() => vi.mocked(effects.closeConnections).mock.calls.length === 1);
        expect(effects.captureConnections).toHaveBeenNthCalledWith(1, [claw.w1]);
        expect(isOpenClawIdTunnelPrincipalCurrent(ownerSource)).toBe(false);
        expect(isOpenClawIdTunnelPrincipalCurrent(memberSource)).toBe(true);
        expect(peopleChanged).toHaveBeenCalledOnce();
        expect(sourceChanged).toHaveBeenCalledOnce();

        // Upkeep must rearm without a runtime for the member's later, distinct deadline.
        await vi.advanceTimersByTimeAsync(86_400_000);
        await settle(() => vi.mocked(effects.closeConnections).mock.calls.length === 2);
        expect(effects.captureConnections).toHaveBeenNthCalledWith(2, [memberKey]);
        expect(isOpenClawIdTunnelPrincipalCurrent(memberSource)).toBe(false);
        expect(peopleChanged).toHaveBeenCalledTimes(2);
        expect(sourceChanged).toHaveBeenCalledTimes(2);
        expect(runtime.push).not.toHaveBeenCalled();
      } finally {
        stopPeople();
        stopSources();
        await service.stop();
      }
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(["disabled", "stopped"] as const)("ends local expiry upkeep when %s", async (ending) => {
    const claw = await linkedClaw();
    const source = (await claw.authority.resolvePeer(claw.w1))!;
    const config = { enabled: true, ownerDeviceInactivityDays: 1 };
    const { service, effects } = serviceFor(claw.authority, config);
    try {
      await prepareOpenClawIdTunnelPrincipal(source);
      expect(vi.getTimerCount()).toBeGreaterThan(0);
      if (ending === "disabled") {
        config.enabled = false;
        await service.reconcileRuntimePolicy();
      } else {
        await service.stop();
      }
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(86_401_000);
      expect(effects.closeConnections).not.toHaveBeenCalled();
      expect(claw.authority.currentPeer(claw.w1)).toEqual(source);
      expect(isOpenClawIdTunnelPrincipalCurrent(source)).toBe(false);
    } finally {
      await service.stop();
    }
  });
});
