// SSH-verified node pairing policy and verifier tests.
import crypto from "node:crypto";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  deriveDeviceIdFromPublicKey,
  publicKeyRawBase64UrlFromPem,
} from "../infra/device-identity.js";
import type { FreshNodePairingEligibilityParams } from "./node-pairing-auto-approve.js";
import { planNodePairingSshVerify, startNodePairingSshVerify } from "./node-pairing-ssh-verify.js";
import * as sshProbe from "./node-pairing-ssh-verify.runtime.js";
import type {
  NodeIdentityProbeParams,
  NodeIdentityProbeResult,
} from "./node-pairing-ssh-verify.runtime.js";

afterEach(() => vi.restoreAllMocks());

function makeIdentity(): { deviceId: string; publicKey: string } {
  const { publicKey } = crypto.generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }) as string;
  const raw = publicKeyRawBase64UrlFromPem(publicKeyPem);
  const deviceId = deriveDeviceIdFromPublicKey(raw);
  if (!deviceId) {
    throw new Error("failed to derive device id for test identity");
  }
  return { deviceId, publicKey: raw };
}

function makeEligibility(
  overrides?: Partial<FreshNodePairingEligibilityParams>,
): FreshNodePairingEligibilityParams {
  return {
    existingPairedDevice: false,
    role: "node",
    reason: "not-paired",
    scopes: [],
    hasBrowserOriginHeader: false,
    isControlUi: false,
    isWebchat: false,
    reportedClientIpSource: "direct",
    reportedClientIp: "192.168.1.20",
    ...overrides,
  };
}

function makePlan(host = "192.168.1.20"): NonNullable<ReturnType<typeof planNodePairingSshVerify>> {
  return { policy: { user: "tester", timeoutMs: 1_000 }, host };
}

function probeReturning(result: NodeIdentityProbeResult) {
  return vi.fn(async (_params: NodeIdentityProbeParams) => result);
}

function startProbe(
  identity: ReturnType<typeof makeIdentity>,
  probe: typeof sshProbe.runNodeIdentityProbe,
  plan = makePlan(),
) {
  vi.spyOn(sshProbe, "runNodeIdentityProbe").mockImplementation(probe);
  return startNodePairingSshVerify({
    plan,
    expectedDeviceId: identity.deviceId,
    expectedPublicKey: identity.publicKey,
  });
}

function planFor(
  overrides: Partial<FreshNodePairingEligibilityParams> = {},
  config?: Parameters<typeof planNodePairingSshVerify>[0]["config"],
) {
  return planNodePairingSshVerify({ config, eligibility: makeEligibility(overrides) });
}

describe("planNodePairingSshVerify", () => {
  test("plans a probe for an eligible private-network node pairing", () => {
    const plan = planFor();
    expect(plan?.host).toBe("192.168.1.20");
    expect(plan?.policy.user.length).toBeGreaterThan(0);
    expect(plan?.policy.timeoutMs).toBe(7_000);
  });

  test("strips the IPv4-mapped IPv6 prefix from the probe target", () => {
    const plan = planFor({ reportedClientIp: "::ffff:192.168.1.21" });
    expect(plan?.host).toBe("192.168.1.21");
  });

  test.each([
    ["disabled config", {}, false],
    ["browser origin", { hasBrowserOriginHeader: true }],
    ["public source address", { reportedClientIp: "203.0.113.9" }],
    ["local-use NAT64 source address", { reportedClientIp: "64:ff9b:1::8.8.8.8" }],
    ["loopback source address", { reportedClientIp: "127.0.0.1" }],
    ["zone-scoped IPv6 literal", { reportedClientIp: "fe80::1%en0" }],
  ] satisfies Array<[string, Partial<FreshNodePairingEligibilityParams>, false?]>)(
    "returns null for %s",
    (_label, overrides, config?: false) => {
      expect(planFor(overrides, config)).toBeNull();
    },
  );

  test("custom cidrs replace the default private-range probe scope", () => {
    const config = { cidrs: ["10.1.0.0/16"] };
    expect(planFor({ reportedClientIp: "192.168.1.20" }, config)).toBeNull();
    expect(planFor({ reportedClientIp: "10.1.2.3" }, config)?.host).toBe("10.1.2.3");
  });

  test("passes user, identity, timeout, and normalized cidrs into the probe policy", () => {
    const plan = planFor(
      { reportedClientIp: "10.1.2.3" },
      {
        user: "peter",
        identity: "/keys/probe",
        timeoutMs: 1_234,
        cidrs: ["10.0.0.0/8", "  "],
      },
    );

    expect(plan?.policy).toEqual({
      user: "peter",
      identity: "/keys/probe",
      timeoutMs: 1_234,
      cidrs: ["10.0.0.0/8"],
    });
  });
});

describe("startNodePairingSshVerify", () => {
  test.each([
    { name: "user", policy: { user: "replacement-user" }, phase: "in-flight" },
    { name: "identity", policy: { identity: "/keys/replacement" }, phase: "in-flight" },
    { name: "timeout", policy: { timeoutMs: 500 }, phase: "in-flight" },
    { name: "CIDR scope", policy: { cidrs: ["192.168.0.0/16"] }, phase: "in-flight" },
    { name: "user", policy: { user: "replacement-user" }, phase: "failure cooldown" },
  ])("starts a fresh probe after $name changes during $phase", async ({ policy, phase }) => {
    const identity = makeIdentity();
    const oldProbe = createDeferred<NodeIdentityProbeResult>();
    const oldPlan = makePlan();
    const original = startProbe(identity, () => oldProbe.promise, oldPlan);
    const failure = { status: "ok", stdout: "not a node identity" } as const;
    try {
      expect(original !== null).toBe(true);
      if (phase === "failure cooldown") {
        oldProbe.resolve(failure);
        await original?.done;
      }
      const probe = probeReturning({
        status: "ok",
        stdout: JSON.stringify({ deviceId: identity.deviceId, publicKey: identity.publicKey }),
      });
      const replacement = startProbe(identity, probe, {
        ...oldPlan,
        policy: { ...oldPlan.policy, ...policy },
      });
      expect(replacement?.alreadyInFlight).toBe(false);
      await expect(replacement?.done).resolves.toMatchObject({ ok: true });
      expect(probe).toHaveBeenCalledTimes(1);
    } finally {
      oldProbe.resolve(failure);
      await original?.done;
    }
  });

  test.each(["publicKey", "deviceId"] as const)(
    "rejects a mismatched %s and cools the target down",
    async (field) => {
      const identity = makeIdentity();
      const probe = probeReturning({
        status: "ok",
        stdout: JSON.stringify({ ...identity, [field]: makeIdentity()[field] }),
      });
      await expect(startProbe(identity, probe)?.done).resolves.toEqual({
        ok: false,
        reason: "identity-mismatch",
      });
      expect(startProbe(identity, probe)).toBeNull();
    },
  );

  test("reports probe failures and unreadable identities distinctly", async () => {
    const identity = makeIdentity();
    const failed = startProbe(
      identity,
      probeReturning({ status: "failed", code: 255, stderr: "denied" }),
      makePlan("192.168.1.30"),
    );
    await expect(failed?.done).resolves.toEqual({ ok: false, reason: "probe-failed" });

    const unreadable = startProbe(
      identity,
      probeReturning({ status: "ok", stdout: "no json here\n" }),
      makePlan("192.168.1.31"),
    );
    await expect(unreadable?.done).resolves.toEqual({ ok: false, reason: "identity-unreadable" });
  });

  test("shares an in-flight probe with reconnects instead of starting another", async () => {
    const identity = makeIdentity();
    const { promise: gate, resolve: release } = createDeferred<NodeIdentityProbeResult>();
    const probe = vi.fn((_params: NodeIdentityProbeParams) => gate);
    const started = startProbe(identity, probe);
    expect(started).toMatchObject({ alreadyInFlight: false });
    const retry = startProbe(identity, probe);
    expect(retry).toMatchObject({ alreadyInFlight: true });
    expect(retry?.done).toBe(started?.done);
    release({
      status: "ok",
      stdout: `Welcome to devbox\n${JSON.stringify(identity)}\n`,
    });
    await expect(started?.done).resolves.toEqual({
      ok: true,
      user: "tester",
      host: "192.168.1.20",
    });
    expect(probe.mock.calls).toEqual([
      [{ user: "tester", host: "192.168.1.20", identity: undefined, timeoutMs: 1_000 }],
    ]);
  });
});
