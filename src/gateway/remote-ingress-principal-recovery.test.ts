import { afterEach, assert, expect, it } from "vitest";
import { formatIrohEndpointKey } from "../../packages/openclaw-id-protocol/src/index.js";
import type {
  GatewayIngressPrincipal,
  GatewayIngressPrincipalRecovery,
} from "../plugins/gateway-ingress.types.js";
import { createOpenClawIdAuthority } from "./openclaw-id/authority.js";
import { linkedClaw } from "./openclaw-id/openclaw-id.test-support.js";
import { setOpenClawIdTunnelPrincipalLookup } from "./openclaw-id/tunnel-principal.js";
import { captureGatewayIngressPersonPrincipal } from "./remote-ingress-principal-admission.js";
import {
  registerIngressPrincipalRecovery,
  restoreIngressPrincipalRecovery,
} from "./remote-ingress-principal-recovery.js";
import { createContext } from "./server-plugin-in-process-dispatch.test-support.js";
import { gatewayConnect, gatewayProfile } from "./server/client-fixtures.test-support.js";

afterEach(() => setOpenClawIdTunnelPrincipalLookup(undefined));

it("keeps the original app admission through recovery without revoking independent person grants", async () => {
  const claw = await linkedClaw();
  const peerKey = formatIrohEndpointKey(new Uint8Array(32).fill(171));
  const accountId = "recovered-member";
  const profileId = "recovered-person";
  const add = () =>
    claw.sign({
      op: "add",
      account_id: accountId,
      role: "operator",
      peer_keys: [peerKey],
      invite_id: null,
    });
  expect(await claw.authority.submit(await add(), "tunnel")).toMatchObject({ ok: true });
  setOpenClawIdTunnelPrincipalLookup((key) => claw.authority.currentPeer(key));
  const principal = await claw.authority.resolvePeer(peerKey);
  assert(principal, "Missing signed member admission");
  const captured = captureGatewayIngressPersonPrincipal({
    connect: gatewayConnect(["operator.read"]),
    authenticatedUserProfile: gatewayProfile(profileId),
    internal: { authenticatedOperator: true, openclawIdPrincipal: principal },
  });
  // The owner reconstructs stored grants; only core interprets the opaque admission.
  const grants = new Map<string, string>([
    ["delegated", JSON.stringify(captured)],
    ["independent", JSON.stringify({ kind: "person", profileId })],
  ]);
  const context = createContext();
  const owner = new AbortController();
  const resume: GatewayIngressPrincipalRecovery = async (audienceId) => {
    const saved = grants.get(audienceId);
    if (saved === undefined) {
      return undefined;
    }
    const storedPrincipal: GatewayIngressPrincipal = JSON.parse(saved);
    return {
      audienceId,
      recoveryId: "original-app-approval",
      principal: storedPrincipal,
      operatorScopeCeiling: ["operator.read"],
      signal: owner.signal,
      assertCurrent: () => owner.signal.throwIfAborted(),
    };
  };
  registerIngressPrincipalRecovery(context, "app-fixture", {
    resume,
    signal: owner.signal,
    assertCurrent: () => owner.signal.throwIfAborted(),
  });
  const restore = (audienceId = "delegated") =>
    restoreIngressPrincipalRecovery(
      context,
      { pluginId: "app-fixture", audienceId, recoveryId: "original-app-approval" },
      profileId,
      ["operator.read"],
    );
  const reloadAuthority = async () => {
    const reloaded = createOpenClawIdAuthority(claw.store);
    setOpenClawIdTunnelPrincipalLookup(
      (key) => reloaded.currentPeer(key),
      async () => {
        await reloaded.load();
      },
    );
  };
  const recovered: Array<Awaited<ReturnType<typeof restore>>> = [];
  try {
    // A new authority object must hydrate before original stored consent can resume.
    await reloadAuthority();
    const original = await restore();
    recovered.push(original);
    expect(original.assertCurrent).not.toThrow();
    const corruptions = [
      { ...captured, admission: "{" },
      { ...captured, admission: "x".repeat(4097) },
      {
        ...captured,
        admission: JSON.stringify({ profileId, principal: { ...principal, authority: undefined } }),
      },
      { ...captured, admission: JSON.stringify({ profileId: "different-person", principal }) },
    ];
    for (const invalid of corruptions) {
      grants.set("malformed", JSON.stringify(invalid));
      await expect(restore("malformed")).rejects.toMatchObject({
        name: "GatewayOperatorRecoveryAuthorizationError",
      });
    }
    expect(
      await claw.authority.submit(
        await claw.sign({ op: "remove", account_id: accountId }),
        "tunnel",
      ),
    ).toMatchObject({ ok: true });
    setOpenClawIdTunnelPrincipalLookup((key) => claw.authority.currentPeer(key));
    expect(original.signal.aborted).toBe(true);
    expect(original.assertCurrent).toThrow();
    await expect(restore()).rejects.toMatchObject({
      name: "GatewayOperatorRecoveryAuthorizationError",
    });

    // Reapproving the same key is a new listing, not a revival of the old app approval.
    expect(await claw.authority.submit(await add(), "tunnel")).toMatchObject({ ok: true });
    await reloadAuthority();
    await expect(restore()).rejects.toMatchObject({
      name: "GatewayOperatorRecoveryAuthorizationError",
    });
    setOpenClawIdTunnelPrincipalLookup(undefined);
    await expect(restore()).rejects.toMatchObject({
      name: "GatewayOperatorRecoveryAuthorizationError",
    });
    const independent = await restore("independent");
    recovered.push(independent);
    expect(independent.assertCurrent).not.toThrow();
    expect(independent.signal.aborted).toBe(false);
  } finally {
    recovered.forEach((grant) => grant.release());
    owner.abort();
  }
});
