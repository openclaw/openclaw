import { expectDefined } from "@openclaw/normalization-core";
import { assert, expect, it } from "vitest";
import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/users.js";
import { formatIrohEndpointKey } from "../../packages/openclaw-id-protocol/src/index.js";
import type { GatewayIngressPrincipalRecovery } from "../plugins/gateway-ingress.types.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  stageActivePluginRegistry,
} from "../plugins/runtime.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureGatewayOwnerProfile, ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { invalidateGatewayDeviceRevocation } from "./device-revocation.js";
import { setDeviceTokenBindingOwner } from "./openclaw-id/device-token-binding.js";
import { linkedClaw } from "./openclaw-id/openclaw-id.test-support.js";
import { resolveOpenClawIdOperatorProfileEnrollment } from "./openclaw-id/operator-profile-enrollment.js";
import { createTokenBindingPublisher } from "./openclaw-id/service-token-bindings.js";
import { setOpenClawIdTunnelPrincipalLookup } from "./openclaw-id/tunnel-principal.js";
import { invalidateOperatorRolePolicy, resolveOperatorRolePolicy } from "./operator-role-policy.js";
import { normalizeGatewayOperatorRecoverySnapshot } from "./operator-run-recovery-source.codec.js";
import { restoreGatewayOperatorSource } from "./operator-run-recovery.js";
import {
  pairedOperator,
  persistDevices,
  recoveryFixture,
} from "./operator-run-recovery.test-support.js";
import { createRemoteControlUiIngressTestContext } from "./remote-control-ui.test-support.js";
import { registerIngressPrincipalRecovery } from "./remote-ingress-principal-recovery.js";

it.each(["member", "owner", "unrecoverable owner"] as const)(
  "pins a tokenless personal %s installation through recovery and device revocation",
  (kind) =>
    withOpenClawTestState({ scenario: "minimal" }, async ({ stateDir }) => {
      const person = ensureProfileForEmail("enrolled-recovery@example.test");
      const replacement = ensureProfileForEmail("replacement-recovery@example.test");
      const device = { ...pairedOperator(), operatorProfileId: person.id };
      const claw = await linkedClaw();
      const memberPeer =
        kind === "member" ? formatIrohEndpointKey(new Uint8Array(32).fill(171)) : claw.w1;
      if (kind === "member") {
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
      }
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
        if (kind === "unrecoverable owner") {
          const cfg = structuredClone(fixture.context.getRuntimeConfig());
          const personal = expectDefined(cfg.gateway?.roles?.definitions.personal, "personal role");
          personal.modelPolicy = {
            allow: [
              "fixture/allowed",
              ...Array.from(
                { length: 2000 },
                (_model, i) => `fixture/model-${String(i).padStart(40, "0")}`,
              ),
            ],
          };
          fixture.setConfig(cfg);
        }
        const retained = await fixture.capture();
        try {
          expect(Boolean(retained.authority.recoverySnapshot)).toBe(kind !== "unrecoverable owner");
          for (const authority of [retained.authority, restored.authority]) {
            const client = { ...fixture.client, internal: { operatorRunAuthority: authority } };
            const cfg = fixture.context.getRuntimeConfig();
            expect(resolveOperatorRolePolicy(client, cfg)?.agents).toEqual(["main"]);
            expect(() =>
              resolveOperatorRolePolicy(
                {
                  ...client,
                  internal: { ...client.internal, operatorRoleActor: { kind: "system" } },
                },
                cfg,
              ),
            ).toThrow("requires a person principal");
          }
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
    }),
);

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

it.each([false, true])(
  "applies named-role revocation to owner work according to enrollment (%s)",
  (enrolled) =>
    withOpenClawTestState({ scenario: "minimal" }, async ({ stateDir }) => {
      const person = ensureProfileForEmail("enrolled-owner-role@example.test");
      const claw = await linkedClaw();
      const principal = expectDefined(await claw.authority.resolvePeer(claw.w1), "owner principal");
      setOpenClawIdTunnelPrincipalLookup((key) => claw.authority.currentPeer(key));
      try {
        const role = {
          scopes: ["operator.read" as const],
          agents: ["main"],
          sessions: { others: "view" as const },
        };
        const fixture = await recoveryFixture(stateDir, person.id, {
          device: { ...pairedOperator(), ...(enrolled ? { operatorProfileId: person.id } : {}) },
          openclawIdPrincipal: principal,
          scopes: ["operator.read"],
          config: {
            gateway: {
              roles: { default: "original", definitions: { original: role, replacement: role } },
            },
          },
        });
        const restored = await fixture.restore();
        using _ = { [Symbol.dispose]: restored.release };
        const retained = await fixture.capture();
        using hold = { ...retained, [Symbol.dispose]: retained.release };
        setUserProfileRole(person.id, "replacement");
        invalidateOperatorRolePolicy(person.id, { roleOnly: true });
        if (enrolled) {
          expect(hold.authority.assertCurrent).toThrow();
          expect(restored.authority.assertCurrent).toThrow();
          await expect(fixture.restore()).rejects.toThrow();
        } else {
          expect(hold.authority.assertCurrent).not.toThrow();
          expect(restored.authority.assertCurrent).not.toThrow();
          const recovered = await fixture.restore();
          recovered.release();
        }
      } finally {
        setOpenClawIdTunnelPrincipalLookup(undefined);
      }
    }),
);

it.each([false, true])(
  "rechecks a null access grant according to owner enrollment (%s)",
  (enrolled) =>
    withOpenClawTestState({ scenario: "minimal" }, async ({ stateDir }) => {
      const person = ensureProfileForEmail("enrolled-owner-access@example.test");
      const claw = await linkedClaw();
      const principal = expectDefined(await claw.authority.resolvePeer(claw.w1), "owner principal");
      const previousRegistry = captureActivePluginRegistrySnapshot();
      const registry = createEmptyPluginRegistry();
      let applicable = false;
      registry.plugins.push(createPluginRecord({ id: "personal-access" }));
      registry.gatewayAccessPolicies.push({
        pluginId: "personal-access",
        source: "test",
        policy: {
          authorize: () =>
            applicable
              ? { grantId: "new-grant", signal: new AbortController().signal, assertCurrent() {} }
              : undefined,
        },
      });
      stageActivePluginRegistry(registry, null, "default");
      setOpenClawIdTunnelPrincipalLookup((key) => claw.authority.currentPeer(key));
      try {
        const fixture = await recoveryFixture(stateDir, person.id, {
          device: { ...pairedOperator(), ...(enrolled ? { operatorProfileId: person.id } : {}) },
          openclawIdPrincipal: principal,
          scopes: ["operator.read"],
        });
        expect(fixture.snapshot.grant).toBeNull();
        const restored = await fixture.restore();
        restored.release();
        applicable = true;
        if (enrolled) {
          await expect(fixture.restore()).rejects.toThrow("[access-cause=policy-set-changed]");
        } else {
          const recovered = await fixture.restore();
          recovered.release();
        }
      } finally {
        setOpenClawIdTunnelPrincipalLookup(undefined);
        restoreActivePluginRegistrySnapshot(previousRegistry);
      }
    }),
);

it.each(["enrolled", "legacy"])("recovers %s owner ingress without changing either grant", (mode) =>
  withOpenClawTestState({ scenario: "minimal" }, async ({ stateDir }) => {
    const person =
      mode === "enrolled"
        ? ensureProfileForEmail("enrolled-ingress@example.test")
        : ensureGatewayOwnerProfile("Shared owner");
    const device = {
      ...pairedOperator(),
      ...(mode === "enrolled" ? { operatorProfileId: person.id } : {}),
    };
    const fixture = await recoveryFixture(stateDir, person.id, {
      device,
      scopes: ["operator.read"],
      config: { gateway: { auth: { mode: "token", token: "synthetic-owner-token" } } },
    });
    const ingress = createRemoteControlUiIngressTestContext();
    const recoverySource = {
      pluginId: ingress.pluginId,
      audienceId: ingress.audienceId,
      recoveryId: "original-owner-grant",
    };
    let grant: Awaited<ReturnType<GatewayIngressPrincipalRecovery>> = {
      ...recoverySource,
      principal: { kind: "owner" },
      operatorScopeCeiling: ["operator.read"],
      signal: ingress.signal,
      assertCurrent: ingress.assertCurrent,
    };
    registerIngressPrincipalRecovery(fixture.context, ingress.pluginId, {
      resume: async () => grant,
      signal: ingress.signal,
      assertCurrent: ingress.assertCurrent,
    });
    fixture.client.internal = {
      ...fixture.client.internal,
      remoteIngressPrincipal: { ...ingress.resolvePrincipal(), recoverySource },
    };
    const captured = await fixture.capture();
    using original = { ...captured, [Symbol.dispose]: captured.release };
    const originalSnapshot = expectDefined(
      original.authority.recoverySnapshot,
      "durable ingress source",
    );
    assert(originalSnapshot.sourceIngress === "principal");
    const persisted = JSON.stringify({
      ...originalSnapshot,
      ingress: {
        ...originalSnapshot.ingress,
        ...(mode === "legacy" ? { profileId: undefined } : {}),
      },
    });
    const snapshot = expectDefined(
      normalizeGatewayOperatorRecoverySnapshot(JSON.parse(persisted)),
      "persisted ingress source",
    );
    const restore = () =>
      restoreGatewayOperatorSource({
        snapshot,
        target: fixture.target,
        context: fixture.context,
        assertCurrent() {},
      });
    const restored = await restore();
    using recovered = { ...restored, [Symbol.dispose]: restored.release };
    expect(recovered.authority.profileId).toBe(person.id);
    expect(recovered.authority.scopes).toEqual(["operator.read"]);
    expect(recovered.authority.assertCurrent).not.toThrow();
    const originalGrant = grant;
    for (const changed of [
      { ...originalGrant, recoveryId: "replacement-owner-grant" },
      { ...originalGrant, operatorScopeCeiling: [] },
      { ...originalGrant, principal: { kind: "person" as const, profileId: "different-person" } },
    ]) {
      grant = changed;
      await expect(restore()).rejects.toThrow(
        "original ingress grant identity or scope ceiling changed",
      );
    }
    grant = originalGrant;
    if (mode === "enrolled") {
      persistDevices(
        stateDir,
        [{ ...device, operatorProfileId: GATEWAY_OWNER_PROFILE_ID }],
        "paired",
      );
      await expect(restore()).rejects.toThrow("enrollment changed");
    }
  }),
);
