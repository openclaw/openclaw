import { expectDefined } from "@openclaw/normalization-core";
import { expect, it } from "vitest";
import { formatIrohEndpointKey } from "../../packages/openclaw-id-protocol/src/index.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { invalidateGatewayDeviceRevocation } from "./device-revocation.js";
import { setDeviceTokenBindingOwner } from "./openclaw-id/device-token-binding.js";
import { linkedClaw } from "./openclaw-id/openclaw-id.test-support.js";
import { resolveOpenClawIdOperatorProfileEnrollment } from "./openclaw-id/operator-profile-enrollment.js";
import { createTokenBindingPublisher } from "./openclaw-id/service-token-bindings.js";
import { setOpenClawIdTunnelPrincipalLookup } from "./openclaw-id/tunnel-principal.js";
import { captureGatewayOperatorRunAuthority } from "./operator-run-authority.js";
import {
  pairedOperator,
  persistDevices,
  recoveryFixture,
} from "./operator-run-recovery.test-support.js";

it("pins tokenless personal installation through recovery and device revocation", () =>
  withOpenClawTestState({ scenario: "minimal" }, async ({ stateDir }) => {
    const person = ensureProfileForEmail("enrolled-recovery@example.test");
    const replacement = ensureProfileForEmail("replacement-recovery@example.test");
    const device = { ...pairedOperator(), operatorProfileId: person.id };
    const claw = await linkedClaw();
    const memberPeer = formatIrohEndpointKey(new Uint8Array(32).fill(171));
    await claw.authority.submit(
      await claw.sign({
        op: "add",
        account_id: "enrolled-account",
        role: "operator",
        peer_keys: [memberPeer],
        invite_id: null,
      }),
      "tunnel",
    );
    const principal = expectDefined(
      await claw.authority.resolvePeer(memberPeer),
      "member principal",
    );
    setOpenClawIdTunnelPrincipalLookup((key) => claw.authority.currentPeer(key));
    createTokenBindingPublisher({
      authority: async () => claw.authority,
      log: { warn() {} },
      closed: () => false,
    }).publish(claw.authority);
    await claw.authority.bindToken(device.deviceId, "operator", memberPeer, principal);
    try {
      const fixture = await recoveryFixture(stateDir, person.id, {
        device,
        tokenlessDevice: true,
        openclawIdPrincipal: principal,
        scopes: ["operator.read"],
        config: {
          agents: { defaults: { model: "fixture/allowed" } },
          gateway: {
            roles: {
              default: "personal",
              definitions: {
                personal: {
                  agents: ["main"],
                  sessions: { others: "view" },
                  scopes: ["operator.admin"],
                  sandbox: "required",
                  accessPrograms: { cyber: [] },
                  modelPolicy: { allow: ["fixture/allowed"] },
                },
              },
            },
          },
        },
      });
      expect(fixture.snapshot.device).toBeUndefined();
      expect(fixture.snapshot.operatorProfileEnrollment).toEqual({
        deviceId: device.deviceId,
        publicKey: device.publicKey,
        createdAtMs: device.createdAtMs,
        profileId: person.id,
      });
      const reverse = await resolveOpenClawIdOperatorProfileEnrollment(principal);
      expect(reverse.enrollment).toEqual(fixture.snapshot.operatorProfileEnrollment);
      expect(reverse.isCurrent()).toBe(true);
      const restored = await fixture.restore();
      using _ = { [Symbol.dispose]: restored.release };
      expect(restored.authority.assertCurrent).not.toThrow();
      expect(restored.authority.rolePolicy).toMatchObject({
        agents: ["main"],
        sessionAccessCap: "view",
        sandboxRequired: true,
        accessPrograms: { cyber: [] },
      });
      expect(
        restored.authority.modelPolicy?.allows({ provider: "fixture", model: "disallowed" }),
      ).toBe(false);
      const retained = expectDefined(
        await captureGatewayOperatorRunAuthority({
          client: fixture.client,
          context: fixture.context,
          sourceAuthority: null,
        }),
        "retained personal source",
      );
      try {
        invalidateGatewayDeviceRevocation(fixture.context, device.deviceId, "operator");
        expect(retained.authority.assertCurrent).toThrow();
        expect(retained.authority.signal?.aborted).toBe(true);
        expect(restored.authority.assertCurrent).toThrow();
        expect(restored.authority.signal?.aborted).toBe(true);
        persistDevices(stateDir, [{ ...device, operatorProfileId: replacement.id }], "paired");
        await expect(fixture.restore()).rejects.toThrow("enrollment changed");
        expect(reverse.isCurrent()).toBe(false);
        const second = { ...device, deviceId: "second-personal-installation" };
        persistDevices(
          stateDir,
          [{ ...device, operatorProfileId: replacement.id }, second],
          "paired",
        );
        await claw.authority.bindToken(second.deviceId, "operator", memberPeer, principal);
        await expect(resolveOpenClawIdOperatorProfileEnrollment(principal)).rejects.toThrow(
          "conflicting personal operator enrollments",
        );
      } finally {
        retained.release();
      }
    } finally {
      setOpenClawIdTunnelPrincipalLookup(undefined);
      setDeviceTokenBindingOwner(undefined);
    }
  }));

it.each(["signed-token", "signed-tokenless", "http-peer"] as const)(
  "retains explicit %s source provenance beside a personally enrolled peer sibling",
  (kind) =>
    withOpenClawTestState({ scenario: "minimal" }, async ({ stateDir }) => {
      const person = ensureProfileForEmail("original-ws-person@example.test");
      const siblingPerson = ensureProfileForEmail("enrolled-sibling-person@example.test");
      const device = pairedOperator();
      const sibling = {
        ...device,
        deviceId: "enrolled-sibling",
        operatorProfileId: siblingPerson.id,
      };
      const claw = await linkedClaw();
      const principal = expectDefined(await claw.authority.resolvePeer(claw.w1), "owner principal");
      setOpenClawIdTunnelPrincipalLookup((key) => claw.authority.currentPeer(key));
      createTokenBindingPublisher({
        authority: async () => claw.authority,
        log: { warn() {} },
        closed: () => false,
      }).publish(claw.authority);
      await claw.authority.bindToken(device.deviceId, "operator", claw.w1, principal);
      await claw.authority.bindToken(sibling.deviceId, "operator", claw.w1, principal);
      try {
        if (kind === "http-peer") {
          persistDevices(stateDir, [device, { ...device, deviceId: sibling.deviceId }], "paired");
        }
        const fixture = await recoveryFixture(stateDir, person.id, {
          device: kind === "http-peer" ? undefined : device,
          tokenlessDevice: kind !== "signed-token",
          openclawIdPrincipal: principal,
        });
        expect(fixture.snapshot.operatorProfileEnrollmentViaPeer).toBe(
          kind === "http-peer" ? true : undefined,
        );
        persistDevices(stateDir, [device, sibling], "paired");
        if (kind === "http-peer") {
          await expect(fixture.restore()).rejects.toThrow("enrollment changed");
        } else {
          const restored = await fixture.restore();
          using _ = { [Symbol.dispose]: restored.release };
          expect(restored.authority.assertCurrent).not.toThrow();
        }
      } finally {
        setOpenClawIdTunnelPrincipalLookup(undefined);
        setDeviceTokenBindingOwner(undefined);
      }
    }),
);
