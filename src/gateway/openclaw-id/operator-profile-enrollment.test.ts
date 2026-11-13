import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { formatIrohEndpointKey } from "../../../packages/openclaw-id-protocol/src/index.js";
import { rotateDeviceToken } from "../../infra/device-pairing-tokens.js";
import { removePairedDevice } from "../../infra/device-pairing.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { pairedOperator, persistDevices } from "../operator-run-recovery.test-support.js";
import { createOpenClawIdAuthority, type OpenClawIdAuthority } from "./authority.js";
import { readStoredClaw, writeStoredClaw } from "./claw-store.js";
import {
  checkDeviceTokenPeer,
  recordTokenlessOpenClawIdOperator,
  setDeviceTokenBindingOwner,
} from "./device-token-binding.js";
import { linkedClaw, serviceFor } from "./openclaw-id.test-support.js";
import { resolveOpenClawIdOperatorProfileEnrollment } from "./operator-profile-enrollment.js";
import { createTokenBindingPublisher } from "./service-token-bindings.js";
import { setOpenClawIdTunnelPrincipalLookup } from "./tunnel-principal.js";

function publish(owner: OpenClawIdAuthority) {
  createTokenBindingPublisher({
    authority: async () => owner,
    log: { warn() {} },
    closed: () => false,
  }).publish(owner);
  setOpenClawIdTunnelPrincipalLookup((peerKey) => owner.currentPeer(peerKey));
}

it("requires the original listing for personal HTTP inference after failed revocation and same-peer re-add", () =>
  withOpenClawTestState({ scenario: "minimal" }, async ({ stateDir }) => {
    const person = ensureProfileForEmail("listing-person@example.test");
    const device = { ...pairedOperator(), operatorProfileId: person.id };
    persistDevices(stateDir, [device], "paired");
    expect(
      await rotateDeviceToken({
        deviceId: device.deviceId,
        role: "operator",
        scopes: ["operator.read"],
      }),
    ).toMatchObject({ ok: true, entry: { scopes: ["operator.read"] } });
    const store = { read: readStoredClaw, write: writeStoredClaw };
    const claw = await linkedClaw(store);
    const peerKey = formatIrohEndpointKey(new Uint8Array(32).fill(0xac));
    const { service, effects } = serviceFor(claw.authority);
    vi.mocked(effects.revokeDeviceTokens).mockResolvedValue([]);
    const add = () =>
      claw.sign({
        op: "add",
        account_id: "listing-account",
        role: "operator",
        peer_keys: [peerKey],
        invite_id: null,
      });
    try {
      expect(await service.submitStatement("tunnel", await add())).toMatchObject({ ok: true });
      publish(claw.authority);
      const original = expectDefined(
        await claw.authority.resolvePeer(peerKey),
        "original admitted listing",
      );
      await recordTokenlessOpenClawIdOperator(device.deviceId, peerKey, original);
      const source = await resolveOpenClawIdOperatorProfileEnrollment(original);
      expect(source.enrollment?.profileId).toBe(person.id);
      // The independently authenticated source retains durable approval, not credential scopes.
      expect(source.scopeCeiling).toContain("operator.admin");
      expect(
        await service.submitStatement(
          "local_operator",
          await claw.sign({ op: "remove", account_id: "listing-account" }),
        ),
      ).toMatchObject({ ok: true });
      expect(effects.revokeDeviceTokens).toHaveBeenCalledWith([
        { deviceId: device.deviceId, role: "operator", peerKey },
      ]);
      expect(claw.authority.tokenBinding(device.deviceId, "operator")).toBe(peerKey);
      expect(source.isCurrent()).toBe(false);
      expect(await service.submitStatement("tunnel", await add())).toMatchObject({ ok: true });
      const successor = expectDefined(
        await claw.authority.resolvePeer(peerKey),
        "successor admitted listing",
      );
      expect(successor.authority?.listedSeq).not.toBe(original.authority?.listedSeq);
      await expect(resolveOpenClawIdOperatorProfileEnrollment(successor)).rejects.toThrow(
        "listing",
      );
      expect(source.isCurrent()).toBe(false);
      expect(
        await checkDeviceTokenPeer({
          deviceId: device.deviceId,
          role: "operator",
          peerKey: undefined,
        }),
      ).toMatchObject({ ok: false });
      await service.stop();
      await closeOpenClawStateDatabaseAsync();
      const reloaded = createOpenClawIdAuthority(store);
      await reloaded.load();
      publish(reloaded);
      const current = expectDefined(
        await reloaded.resolvePeer(peerKey),
        "reloaded admitted listing",
      );
      await expect(resolveOpenClawIdOperatorProfileEnrollment(current)).rejects.toThrow("listing");
      // An old handshake cannot adopt the successor listing while its write waits.
      await recordTokenlessOpenClawIdOperator(device.deviceId, peerKey, original);
      await expect(resolveOpenClawIdOperatorProfileEnrollment(current)).rejects.toThrow("listing");
      await recordTokenlessOpenClawIdOperator(device.deviceId, peerKey, current);
      expect(
        (await resolveOpenClawIdOperatorProfileEnrollment(current)).enrollment?.profileId,
      ).toBe(person.id);
      await closeOpenClawStateDatabaseAsync();
      const rebound = createOpenClawIdAuthority(store);
      await rebound.load();
      publish(rebound);
      expect(
        (
          await resolveOpenClawIdOperatorProfileEnrollment(
            expectDefined(await rebound.resolvePeer(peerKey), "rebound admitted listing"),
          )
        ).enrollment?.profileId,
      ).toBe(person.id);
    } finally {
      await service.stop();
      setDeviceTokenBindingOwner(undefined);
      setOpenClawIdTunnelPrincipalLookup(undefined);
    }
  }));

it("keeps legacy unbound ingress unchanged but refuses an enrolled candidate without listing provenance", () =>
  withOpenClawTestState({ scenario: "minimal" }, async ({ stateDir }) => {
    const claw = await linkedClaw();
    const device = pairedOperator();
    persistDevices(stateDir, [device], "paired");
    await claw.authority.bindToken(device.deviceId, "operator", claw.w1);
    publish(claw.authority);
    try {
      const principal = expectDefined(
        await claw.authority.resolvePeer(claw.w1),
        "legacy bound owner listing",
      );
      const unbound = await resolveOpenClawIdOperatorProfileEnrollment(principal);
      expect(unbound.enrollment).toBeUndefined();
      expect(unbound.isCurrent()).toBe(true);
      expect(
        await checkDeviceTokenPeer({
          deviceId: device.deviceId,
          role: "operator",
          peerKey: claw.w1,
        }),
      ).toEqual({ ok: true });
      const person = ensureProfileForEmail("legacy-listing@example.test");
      persistDevices(stateDir, [{ ...device, operatorProfileId: person.id }], "paired");
      expect(unbound.isCurrent()).toBe(false);
      await expect(resolveOpenClawIdOperatorProfileEnrollment(principal)).rejects.toThrow(
        "listing",
      );
      await recordTokenlessOpenClawIdOperator(device.deviceId, claw.w1, principal);
      const machine = { kind: "node" as const, peerKey: claw.w1, authority: principal.authority };
      await expect(
        claw.authority.bindToken(device.deviceId, "operator", claw.w1, machine),
      ).rejects.toThrow("listing");
      await expect(resolveOpenClawIdOperatorProfileEnrollment(machine)).rejects.toThrow(
        "node listing",
      );
      const admitted = await resolveOpenClawIdOperatorProfileEnrollment(principal);
      expect(admitted.enrollment?.profileId).toBe(person.id);
      // Failed binding cleanup after row removal must not restore shared owner access.
      await removePairedDevice(device.deviceId);
      expect(admitted.isCurrent()).toBe(false);
      await expect(resolveOpenClawIdOperatorProfileEnrollment(principal)).rejects.toThrow(
        "pairing authority",
      );
    } finally {
      setDeviceTokenBindingOwner(undefined);
      setOpenClawIdTunnelPrincipalLookup(undefined);
    }
  }));
