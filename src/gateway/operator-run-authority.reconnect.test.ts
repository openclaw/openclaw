import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import { assertOperatorModelAllowed } from "../agents/admitted-run-context.js";
import { toSandboxProvisioningError } from "../agents/sandbox/provisioning-error.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveAuthenticatedDeviceTokenIdentity } from "../infra/device-pairing-identity.js";
import type { PairedDevice } from "../infra/device-pairing.types.js";
import { diagnosticLogger } from "../logging/diagnostic-runtime.js";
import { enqueueCommandInLane } from "../process/command-queue.js";
import { resetGatewayWorkAdmission } from "../process/gateway-work-admission.js";
import { createOpenClawStateLeaseError } from "../state/openclaw-state-lease-error.js";
import { prepareUserProfileCatalog } from "../state/user-profile-list.js";
import { setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { captureAgentTurnPrincipal } from "./agent-turn/principal.js";
import { captureGatewayAuthPolicy } from "./auth-policy.js";
import {
  acceptGatewayDeviceSourceAuthority,
  closeGatewayDeviceRevocation,
  invalidateGatewayDeviceRevocation,
} from "./device-revocation.js";
import { publishOperatorRoleConfigChange } from "./operator-role-policy.js";
import { captureGatewayOperatorRunAuthority } from "./operator-run-authority.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import type { GatewayRequestHandlerOptions } from "./server-methods/types.js";
import { dispatchProfile } from "./server/client-fixtures.test-support.js";
import {
  createDispatchTestHarness,
  createOperatorWsClient,
} from "./server/ws-connection/authenticated-request-dispatch.test-support.js";
import type { GatewayWsClient } from "./server/ws-types.js";

type Capture = NonNullable<Awaited<ReturnType<typeof captureGatewayOperatorRunAuthority>>>;

afterEach(() => {
  vi.restoreAllMocks();
  clearRuntimeConfigSnapshot();
  resetGatewayWorkAdmission();
});

it.each([
  ["source-current", "source-invalidated"],
  ["source-revocation", "source-invalidated"],
  ["gateway-current", "gateway-identity-retired"],
  ["before-sources", "closure-released"],
] as const)("records the %s failure once through sandbox and lane wrappers", (check, reason) =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    const profile = ensureProfileForEmail("authority-diagnostic@example.test");
    using proof = fixture(profile.id);
    const clock = vi.spyOn(performance, "now").mockReturnValue(1_000);
    const gateway = vi.spyOn(proof.context, "resolveGatewayContext");
    const captured = await proof.capture(proof.connect().client);
    const log = vi.spyOn(diagnosticLogger, "error").mockImplementation(() => {});
    clock.mockReturnValue(2_500);
    if (check === "source-current") {
      closeGatewayDeviceRevocation(proof.context);
    } else if (check === "source-revocation") {
      invalidateGatewayDeviceRevocation(proof.context, "reconnect-device", "operator");
    } else if (check === "gateway-current") {
      gateway.mockReturnValue(createDirectChatContext());
    } else {
      captured.release();
    }
    await expect(
      enqueueCommandInLane("authority-diagnostic", async () => {
        try {
          captured.authority.assertCurrent();
        } catch (error) {
          throw toSandboxProvisioningError(
            createOpenClawStateLeaseError(
              "OPENCLAW_STATE_LEASE_ABORTED",
              "local sandbox workspace operation was aborted",
              error,
            ),
            "local",
          );
        }
      }),
    ).rejects.toThrow("Reconnect to the Gateway");
    expect(log).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("lane task error: lane=authority-diagnostic"),
      {
        errorName: "SandboxProvisioningError",
        operatorAuthorityReason: reason,
        operatorAuthorityCheck: check,
        operatorAuthorityAgeMs: 1_500,
      },
    );
  }),
);

function device(overrides: { deviceId?: string; token?: string } = {}): PairedDevice {
  return {
    deviceId: overrides.deviceId ?? "reconnect-device",
    publicKey: "synthetic-reconnect-public-key",
    roles: ["operator"],
    approvedScopes: ["operator.admin"],
    tokens: {
      operator: {
        token: overrides.token ?? "synthetic-reconnect-token",
        role: "operator",
        scopes: ["operator.admin"],
        createdAtMs: 1,
      },
    },
    createdAtMs: 1,
    approvedAtMs: 1,
  };
}

function fixture(profileId: string, initialConfig: OpenClawConfig = {}) {
  let config = initialConfig;
  setRuntimeConfigSnapshot(config);
  const context = createDirectChatContext({
    getRuntimeConfig: () => config,
    getCommittedRuntimeConfig: () => config,
  });
  context.resolveGatewayContext = () => context;
  const captures: Capture[] = [];
  let projection: "client" | "principal" | "copy" = "client";
  const handler = async (options: GatewayRequestHandlerOptions) => {
    const client = expectDefined(options.client, "authenticated client");
    const captured = expectDefined(
      await captureGatewayOperatorRunAuthority({
        client:
          projection === "principal"
            ? captureAgentTurnPrincipal(client)
            : projection === "copy"
              ? { ...client }
              : client,
        context,
        hasCurrentClientAuthority: options.hasCurrentClientAuthority,
        sourceAuthority: client.internal?.operatorAccessAuthority ?? null,
      }),
      "operator source",
    );
    captures.push(captured);
    expect(acceptGatewayDeviceSourceAuthority(options.hasCurrentClientAuthority)).toBe(true);
    options.respond(true, { accepted: true });
  };
  const harness = createDispatchTestHarness({
    buildRequestContext: () => context,
    extraHandlers: { health: handler },
  });
  let sequence = 0;
  const connect = (
    overrides: {
      profileId?: string;
      device?: PairedDevice;
      scopes?: string[];
      deviceTokenAuth?: boolean;
    } = {},
  ) => {
    const paired = overrides.device ?? device();
    const connection = new AbortController();
    const client = createOperatorWsClient({
      connId: `synthetic-reconnect-${sequence++}`,
      clientInfo: { id: "openclaw-control-ui", mode: "webchat" },
      scopes: overrides.scopes,
    });
    client.connectionSignal = connection.signal;
    client.isDeviceTokenAuth = overrides.deviceTokenAuth ?? true;
    client.authPolicy = captureGatewayAuthPolicy(config, {
      role: "operator",
      authMethod: "device-token",
    });
    client.authenticatedUserProfile = dispatchProfile(overrides.profileId ?? profileId, {
      avatarRevision: "synthetic",
    });
    client.internal = {
      authenticatedOperator: true,
      authenticatedControlUi: true,
      operatorRoleActor: { kind: "operator", profileId: overrides.profileId ?? profileId },
      operatorDeviceTokenIdentity: expectDefined(
        resolveAuthenticatedDeviceTokenIdentity(paired, {
          role: "operator",
          publicKey: paired.publicKey,
          token: expectDefined(paired.tokens?.operator, "operator token").token,
          scopes: client.connect.scopes ?? [],
        }),
        "server-verified accepted token generation",
      ),
    };
    client.connect.device = {
      id: paired.deviceId,
      publicKey: paired.publicKey,
      signature: "synthetic-signature",
      signedAt: 1,
      nonce: "synthetic-nonce",
    };
    return { client, connection };
  };
  const close = () => {
    for (const captured of captures.splice(0)) {
      captured.release();
    }
  };
  return {
    context,
    connect,
    setConfig(next: OpenClawConfig) {
      config = next;
      setRuntimeConfigSnapshot(next);
      publishOperatorRoleConfigChange(context);
    },
    async capture(client: GatewayWsClient, view: typeof projection = "client"): Promise<Capture> {
      projection = view;
      const previousCount = captures.length;
      const id = `capture-${sequence++}`;
      await harness.dispatcher.dispatch({ type: "req", id, method: "health", params: {} }, client);
      const response = await harness.awaitResponseFrame(id);
      expect(response.error).toBeUndefined();
      expect(captures).toHaveLength(previousCount + 1);
      return expectDefined(captures.at(-1), "successful authenticated dispatch capture");
    },
    close,
    [Symbol.dispose]: close,
  };
}

it("keeps retained source comparison across an authenticated browser reconnect", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    const profile = ensureProfileForEmail("reconnect-owner@example.test");
    using proof = fixture(profile.id);
    const first = proof.connect();
    const original = await proof.capture(first.client);
    first.connection.abort(new Error("synthetic socket retired"));
    original.authority.assertCurrent();
    const second = proof.connect();
    const reconnected = await proof.capture(second.client);
    expect(reconnected.authority.source).toBe(original.authority.source);
    expect(reconnected.authority).not.toBe(original.authority);
    original.authority.assertCurrent();
    reconnected.authority.assertCurrent();
    const principal = await proof.capture(second.client, "principal");
    expect(principal.authority.source).toBe(original.authority.source);
    const copied = await proof.capture(second.client, "copy");
    expect(copied.authority.source).not.toBe(original.authority.source);
    const retainedIdentity = original.authority.source;
    proof.close();
    const afterRelease = await proof.capture(proof.connect().client);
    expect(afterRelease.authority.source).not.toBe(retainedIdentity);
    invalidateGatewayDeviceRevocation(proof.context, "reconnect-device", "operator");
    expect(() => original.authority.assertCurrent()).toThrow();
    expect(() => reconnected.authority.assertCurrent()).toThrow();
    expect(afterRelease.authority.signal?.reason).toMatchObject({
      message: expect.stringContaining("Reconnect to the Gateway"),
    });
    expect(() => afterRelease.authority.assertCurrent()).toThrow("Reconnect to the Gateway");
    for (let turn = 0; turn < 3; turn++) {
      const fresh = await proof.capture(proof.connect().client);
      fresh.authority.assertCurrent();
      expect(() => afterRelease.authority.assertCurrent()).toThrow("Reconnect to the Gateway");
    }
  }));

it("keeps unproven, reduced, foreign and rotated reconnect sources separate", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    const profile = ensureProfileForEmail("reconnect-controls@example.test");
    const other = ensureProfileForEmail("reconnect-foreign@example.test");
    using proof = fixture(profile.id);
    const original = await proof.capture(proof.connect().client);
    const variants = [
      proof.connect({ device: device({ deviceId: "other-device" }) }),
      proof.connect({ device: device({ token: "synthetic-rotated-token" }) }),
      proof.connect({ profileId: other.id }),
      proof.connect({ scopes: ["operator.read"] }),
      proof.connect({ deviceTokenAuth: false }),
    ];
    for (const candidate of variants) {
      const captured = await proof.capture(candidate.client);
      expect(captured.authority.source).not.toBe(original.authority.source);
    }
    const scoped = proof.connect();
    const access = new AbortController();
    scoped.client.internal = {
      ...scoped.client.internal,
      operatorAccessAuthority: {
        signal: access.signal,
        assertCurrent: () => access.signal.throwIfAborted(),
      },
    };
    const accessBound = await proof.capture(scoped.client);
    expect(accessBound.authority.source).not.toBe(original.authority.source);
    access.abort(new Error("synthetic access grant retired"));
    expect(() => accessBound.authority.assertCurrent()).toThrow();
    original.authority.assertCurrent();
  }));

it("does not merge changed model membership or expand the retained source ceiling", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    const profile = ensureProfileForEmail("reconnect-policy@example.test");
    setUserProfileRole(profile.id, "reconnect");
    using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
    const initial: OpenClawConfig = {
      agents: { defaults: { model: "fixture/a" } },
      gateway: {
        roles: {
          definitions: {
            reconnect: {
              agents: "*",
              scopes: ["operator.admin"],
              sessions: { others: "none" },
              modelPolicy: { allow: ["fixture/a"] },
            },
          },
        },
      },
    };
    using proof = fixture(profile.id, initial);
    const original = await proof.capture(proof.connect().client);
    const updated = structuredClone(initial);
    expectDefined(updated.gateway?.roles?.definitions.reconnect, "role").modelPolicy = {
      allow: ["fixture/a", "fixture/b"],
    };
    proof.setConfig(updated);
    const replacement = await proof.capture(proof.connect().client);
    expect(replacement.authority.source).not.toBe(original.authority.source);
    expect(() =>
      assertOperatorModelAllowed(original.authority, { provider: "fixture", model: "b" }),
    ).toThrow();
    expect(() =>
      assertOperatorModelAllowed(replacement.authority, { provider: "fixture", model: "b" }),
    ).not.toThrow();
  }));
