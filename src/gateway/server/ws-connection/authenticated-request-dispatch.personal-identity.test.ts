import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { resolveAuthenticatedPairedDeviceIdentity } from "../../../infra/device-pairing-identity.js";
import * as pairingStore from "../../../infra/device-pairing-store-readonly.js";
import type { PairedDevice } from "../../../infra/device-pairing.types.js";
import * as tailscale from "../../../infra/tailscale.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import * as profileAuthorities from "../../../state/user-channel-identity-operations.js";
import * as profileReads from "../../../state/user-profile-reads.js";
import { ensureProfileForEmail } from "../../../state/user-profiles.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import {
  acceptGatewayDeviceSourceAuthority,
  readAcceptedGatewayDeviceSourceAuthority,
  retainGatewayDeviceRevocation,
} from "../../device-revocation.js";
import {
  captureGatewayPersonalIdentityBinding,
  resolveGatewayPersonalIdentityBinding,
} from "../../personal-identity-binding.js";
import { readGatewayRequestMutationAuthority } from "../../server-methods/session-mutation-guards.js";
import type { GatewayRequestHandler } from "../../server-methods/types.js";
import {
  createDispatchTestHarness,
  createOperatorWsClient,
  requestFrame,
} from "./authenticated-request-dispatch.test-support.js";
import { bindGatewayConnectPersonalIdentity } from "./connect-user-profile.js";

afterEach(() => vi.restoreAllMocks());

async function fixture(handlers: Record<string, GatewayRequestHandler>) {
  const profile = ensureProfileForEmail("personal-fixture@example.test");
  const scopes = ["operator.admin"];
  const paired: PairedDevice = {
    deviceId: "personal-device",
    publicKey: "personal-public-key",
    roles: ["operator"],
    approvedScopes: scopes,
    tokens: { operator: { token: "synthetic-token", role: "operator", scopes, createdAtMs: 1 } },
    createdAtMs: 1,
    approvedAtMs: 1,
  };
  const device = resolveAuthenticatedPairedDeviceIdentity(paired, {
    role: "operator",
    publicKey: paired.publicKey,
    scopes,
  });
  if (!device) {
    throw new Error("Missing fixture device approval");
  }
  vi.spyOn(pairingStore, "loadPairedDevicePairingStoreRecordReadOnly").mockResolvedValue(paired);
  vi.spyOn(profileReads, "resolveCanonicalTailscaleProfileId").mockResolvedValue(profile.id);
  const authority = await profileAuthorities.prepareUserProfileRoleAuthority(profile.id);
  vi.spyOn(profileAuthorities, "prepareUserProfileRoleAuthority").mockResolvedValue(authority);
  const whois = vi
    .spyOn(tailscale, "readTailscaleWhoisIdentity")
    .mockResolvedValue({ login: "personal-fixture@example.test", name: "Fixture" });
  const harness = createDispatchTestHarness({ extraHandlers: handlers });
  const close = vi.fn();
  const client = createOperatorWsClient({ socket: { close }, scopes });
  client.connect.device = {
    id: paired.deviceId,
    publicKey: paired.publicKey,
    signature: "accepted-signature",
    signedAt: Date.now(),
    nonce: "accepted-nonce",
  };
  const capture = (bindingId: string) => {
    const now = Date.now();
    return captureGatewayPersonalIdentityBinding(
      harness.clients,
      {
        ingress: "tailscale-serve",
        authMethod: "tailscale",
        tailscaleLogin: "personal-fixture@example.test",
        sourceClientIp: "100.64.0.10",
        canonicalProfileId: profile.id,
        device,
        scopes,
        gatewayId: "fixture-boot",
        signedAtMs: now,
        verifiedAtMs: now,
      },
      {
        mode: "personal-identity",
        provider: "tailscale",
        phase: "bind",
        bindingId,
        issuedAtMs: now,
      },
    );
  };
  expect(capture("binding-a")).toBe(true);
  const binding = await resolveGatewayPersonalIdentityBinding({
    gateway: harness.clients,
    intent: {
      mode: "personal-identity",
      provider: "tailscale",
      phase: "use",
      bindingId: "binding-a",
      profileId: profile.id,
      gatewayId: "fixture-boot",
      issuedAtMs: Date.now(),
    },
    device,
    scopes,
    gatewayId: "fixture-boot",
    isDirectLocal: true,
    isDeviceCurrent: () => true,
    isProfileCurrent: () => true,
    readCurrentTailscaleLogin: async () => "personal-fixture@example.test",
  });
  if (!binding) {
    throw new Error("Missing fixture personal binding");
  }
  client.internal = { personalIdentityBinding: { ...binding, bindingId: "binding-a" } };
  return { harness, client, capture, whois, close };
}

it.each([false, true])(
  "retires authority on replacement after the request has returned: %s",
  async (returned) => {
    await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
      const entered = createDeferredCore();
      const held = createDeferredCore();
      let effects = 0;
      let source: (() => boolean) | undefined;
      let release: (() => void) | undefined;
      const { harness, client, capture } = await fixture({
        "test.personal-mutation": async (options) => {
          const mutation = readGatewayRequestMutationAuthority(options);
          release = retainGatewayDeviceRevocation(options.hasCurrentClientAuthority);
          expect(acceptGatewayDeviceSourceAuthority(options.hasCurrentClientAuthority)).toBe(true);
          source = readAcceptedGatewayDeviceSourceAuthority(options.hasCurrentClientAuthority);
          entered.resolve();
          await held.promise;
          try {
            mutation.assertCurrent();
            effects += 1;
          } catch {}
          options.respond(true, { completed: true });
        },
      });
      const pending = harness.dispatcher.dispatch(
        requestFrame("personal-mutation", "test.personal-mutation"),
        client,
      );
      try {
        await entered.promise;
        expect(source?.()).toBe(true);
        if (returned) {
          held.resolve();
          await pending;
          expect(effects).toBe(1);
        }
        expect(capture("binding-b")).toBe(true);
        held.resolve();
        await pending;
        expect(effects).toBe(returned ? 1 : 0);
        expect(source?.()).toBe(false);
        if (!returned) {
          expect(harness.send).not.toHaveBeenCalledWith(
            expect.objectContaining({ id: "personal-mutation", ok: true }),
          );
        }
      } finally {
        held.resolve();
        await pending;
        release?.();
      }
    });
  },
);

it.each(["before registration", "while idle"])("retires a binding replaced %s", async (phase) => {
  await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
    const { client, capture, close } = await fixture({});
    const connection = new AbortController();
    try {
      if (phase === "while idle") {
        expect(bindGatewayConnectPersonalIdentity(client, connection.signal)).toBe(true);
      }
      expect(capture("binding-b")).toBe(true);
      if (phase === "before registration") {
        expect(bindGatewayConnectPersonalIdentity(client, connection.signal)).toBe(false);
      }
      expect(client.invalidated).toBe(true);
      expect(close).toHaveBeenCalledWith(4001, "personal identity binding is no longer current");
    } finally {
      connection.abort();
    }
  });
});

it("reserves credential mutation order before personal validation yields", async () => {
  await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
    const held = createDeferredCore();
    const firstValidation = createDeferredCore();
    const secondValidation = createDeferredCore();
    const order: string[] = [];
    const { harness, client, whois } = await fixture({
      "device.token.revoke": ({ respond }) => {
        order.push("revoke");
        respond(true);
      },
      "test.later": ({ respond }) => {
        order.push("later");
        respond(true);
      },
    });
    await harness.dispatcher.dispatch(requestFrame("warm", "test.later"), client);
    order.length = 0;
    whois.mockImplementationOnce(async () => {
      firstValidation.resolve();
      await held.promise;
      return { login: "personal-fixture@example.test", name: "Fixture" };
    });
    whois.mockImplementationOnce(async () => {
      secondValidation.resolve();
      return { login: "personal-fixture@example.test", name: "Fixture" };
    });
    const first = harness.dispatcher.dispatch(requestFrame("first", "device.token.revoke"), client);
    await firstValidation.promise;
    const second = harness.dispatcher.dispatch(requestFrame("second", "test.later"), client);
    try {
      await secondValidation.promise;
      await nextTurn();
      expect(order).toEqual([]);
    } finally {
      held.resolve();
      await Promise.all([first, second]);
    }
    expect(order).toEqual(["revoke", "later"]);
  });
});
