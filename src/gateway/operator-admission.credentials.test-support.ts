import { randomUUID } from "node:crypto";
import { assert, expect } from "vitest";
import { formatIrohEndpointKey } from "../../packages/openclaw-id-protocol/src/index.js";
import { dispatchInboundMessageWithBufferedDispatcher } from "../auto-reply/dispatch.js";
import { dispatchLowLevelChannelReplyFromConfig } from "../auto-reply/reply/dispatch-from-config.js";
import {
  createHostIngressFixture,
  ingressInput,
  ingressMessage,
} from "../channels/message-access/host-ingress.test-support.js";
import { loadDeviceAuthToken } from "../infra/device-auth-store.js";
import { publicKeyRawBase64UrlFromPem } from "../infra/device-identity.js";
import { approveDevicePairing } from "../infra/device-pairing-approval.js";
import { revokeDeviceToken } from "../infra/device-pairing-tokens.js";
import { removePairedDevice, requestDevicePairing } from "../infra/device-pairing.js";
import {
  changeCanonicalUserChannelIdentity,
  publishCanonicalUserChannelPolicy,
} from "../state/user-channel-identity-operations.js";
import { ensureCanonicalUserProfileForOpenClawIdIdentity } from "../state/user-profile-openclaw-id.js";
import {
  ensureCanonicalUserProfileForEmail,
  setCanonicalUserProfileRole,
} from "../state/user-profile-writes.js";
import { setTestEnvValue } from "../test-utils/env.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { resolveGatewayAuthForConfig } from "./auth-resolve.js";
import type { GatewayClientOptions } from "./client.js";
import { linkedClaw } from "./openclaw-id/openclaw-id.test-support.js";
import {
  setOpenClawIdMemberAccountLookup,
  setOpenClawIdTunnelPrincipalLookup,
  setOpenClawIdTunnelPrincipalResolver,
} from "./openclaw-id/tunnel-principal.js";
import type { AdmissionCase, AdmissionFixture } from "./operator-admission.table.test-support.js";
import type { OperatorScope } from "./operator-scopes.js";
import { getGatewayControlUiIngressHost } from "./remote-control-ui-ingress-host.js";
import { createGatewayControlUiIngressFactory } from "./remote-control-ui-ingress.js";

export const ORIGIN = "https://admission.example.test";
export const WRITER: OperatorScope[] = ["operator.read", "operator.write"];
export const ADMIN: OperatorScope[] = ["operator.admin"];
export const PROXY_USER = "operator@example.test";
export const ADMIN_USER = "administrator@example.test";
export const proxyHeaders = (user: string) => ({
  "x-forwarded-user": user,
  "x-forwarded-for": "203.0.113.50",
  "x-forwarded-proto": "https",
});

export async function prepareAdmissionOperator(fixture: AdmissionFixture, c: AdmissionCase) {
  const credential = c.row.credential;
  if (credential === "principal") {
    const next = structuredClone(fixture.config);
    delete next.gateway!.roles;
    await fixture.publish(next, c.signal);
    assert(fixture.kernel);
    const host = getGatewayControlUiIngressHost(fixture.kernel.resolvePluginGatewayContext);
    assert(host);
    const factory = createGatewayControlUiIngressFactory({
      pluginId: `admission-${c.id}`,
      signal: c.service.signal,
      assertCurrent: () => c.service.signal.throwIfAborted(),
      host,
    });
    const principal = {
      audienceId: c.id,
      principal: { kind: "owner" as const },
      operatorScopeCeiling: WRITER,
      signal: c.consent.signal,
      assertCurrent: () => c.consent.signal.throwIfAborted(),
    };
    assert(factory.registerPrincipalRecovery);
    await factory.registerPrincipalRecovery(async () =>
      c.consentCurrent ? { ...principal, recoveryId: c.id } : undefined,
    );
    const binding = await factory.bindPrincipal(principal);
    fixture.bindings.push(binding);
    return binding;
  }
  const device = credential !== "trusted-proxy";
  if (device) {
    const pending = await requestDevicePairing({
      deviceId: c.identity.deviceId,
      publicKey: publicKeyRawBase64UrlFromPem(c.identity.publicKeyPem),
      role: "operator",
      scopes: WRITER,
    });
    await approveDevicePairing(pending.request.requestId, { callerScopes: ADMIN });
  }
  const options: Omit<GatewayClientOptions, "url"> = {
    deviceIdentity: device ? c.identity : null,
    clientName:
      c.row.ingress === "control-ui" ? GATEWAY_CLIENT_NAMES.CONTROL_UI : GATEWAY_CLIENT_NAMES.TEST,
    mode: c.row.ingress === "control-ui" ? GATEWAY_CLIENT_MODES.WEBCHAT : GATEWAY_CLIENT_MODES.TEST,
    origin: c.row.ingress === "control-ui" ? ORIGIN : undefined,
    scopes: WRITER,
  };
  const auth = fixture.config.gateway!.auth!;
  if (credential === "token" || credential === "device-token") {
    options.token = typeof auth.token === "string" ? auth.token : undefined;
  }
  if (credential === "password") {
    options.password = typeof auth.password === "string" ? auth.password : undefined;
  }
  if (credential === "fallback") {
    assert(auth.password === undefined, "Fallback must come from the environment owner");
    options.password = resolveGatewayAuthForConfig({ config: fixture.config }).password;
    assert(options.password);
  }
  if (credential === "trusted-proxy" || credential === "proxy-device") {
    options.edgeAuthHeaders = proxyHeaders(PROXY_USER);
  }
  if (credential === "tailscale") {
    options.edgeAuthHeaders = {
      "x-admission-relay": "tailscale",
      "x-forwarded-for": "100.64.0.1",
      "x-forwarded-proto": "https",
      "x-forwarded-host": "admission.tailnet.ts.net",
      "tailscale-user-login": PROXY_USER,
    };
  }
  if (credential.startsWith("ocid-")) {
    c.claw = await linkedClaw();
    c.peerKey = c.claw.w1;
    if (credential === "ocid-member") {
      c.peerKey = formatIrohEndpointKey(new Uint8Array(32).fill(173));
      expect(
        await c.claw.authority.submit(
          await c.claw.sign({
            op: "add",
            account_id: c.id,
            role: "operator",
            peer_keys: [c.peerKey],
            invite_id: null,
          }),
          "tunnel",
        ),
      ).toMatchObject({ ok: true });
      const profile = await ensureCanonicalUserProfileForOpenClawIdIdentity({ accountId: c.id });
      await setCanonicalUserProfileRole(profile.id, "operator");
    }
    const authority = c.claw.authority;
    setOpenClawIdTunnelPrincipalResolver((key) => authority.resolvePeer(key));
    setOpenClawIdTunnelPrincipalLookup((key) => authority.currentPeer(key));
    setOpenClawIdMemberAccountLookup((id) => id === c.id);
    options.edgeAuthHeaders = { "x-admission-peer": c.peerKey };
  }
  if (credential === "device-token") {
    const bootstrap = await fixture.connect(options, c.signal);
    await bootstrap.stopAndWait();
    const receipt = await loadDeviceAuthToken({ deviceId: c.identity.deviceId, role: "operator" });
    assert(receipt);
    delete options.token;
    options.deviceToken = receipt.token;
  }
  return await fixture.connect(options, c.signal);
}

export async function prepareNativeSend(fixture: AdmissionFixture, c: AdmissionCase) {
  const profile = await ensureCanonicalUserProfileForEmail(PROXY_USER);
  c.profileId = profile.id;
  await setCanonicalUserProfileRole(profile.id, "operator");
  await changeCanonicalUserChannelIdentity("link", profile.id, {
    channelId: "discord",
    accountId: "default",
    senderId: "123456789012345678",
  });
  await publishCanonicalUserChannelPolicy(fixture.config.gateway);
  assert(fixture.kernel);
  const host = createHostIngressFixture(
    "discord",
    fixture.config,
    fixture.kernel.gatewayRequestContext,
  );
  return async () => {
    const message = ingressMessage("discord", c.sessionKey, "123456789012345678", {
      messageId: c.id,
      message: { body: c.queuedText, rawBody: c.queuedText },
    });
    const channelIngress = await host.ingress.resolveStable(
      ingressInput(message, { identity: { authentication: "verified" } }),
    );
    return await dispatchInboundMessageWithBufferedDispatcher({
      ctx: host.buildContext({ ...message, channelIngress }),
      cfg: fixture.config,
      dispatchReplyFromConfig: dispatchLowLevelChannelReplyFromConfig,
      dispatcherOptions: {
        deliver: async (payload) => {
          c.deliveries.push(payload);
        },
      },
      replyOptions: { queueModeOverride: "followup", disableBlockStreaming: true },
    });
  };
}

export async function revokeAdmissionSource(fixture: AdmissionFixture, c: AdmissionCase) {
  const next = structuredClone(fixture.config);
  switch (c.row.credential) {
    case "token":
      next.gateway!.auth!.token = randomUUID();
      break;
    case "password":
      next.gateway!.auth!.password = randomUUID();
      break;
    case "fallback": {
      const before = resolveGatewayAuthForConfig({ config: fixture.config }).password;
      assert(before && fixture.config.gateway?.auth?.password === undefined);
      setTestEnvValue("OPENCLAW_GATEWAY_PASSWORD", randomUUID());
      expect(resolveGatewayAuthForConfig({ config: fixture.config }).password).not.toBe(before);
      return;
    }
    case "trusted-proxy":
      next.gateway!.auth!.trustedProxy!.allowUsers = [ADMIN_USER];
      break;
    case "tailscale":
      next.gateway!.auth!.allowTailscale = false;
      break;
    case "device-token":
      expect(
        await revokeDeviceToken({
          deviceId: c.identity.deviceId,
          role: "operator",
          callerScopes: ADMIN,
        }),
      ).not.toBeNull();
      return;
    case "proxy-device":
      expect(await removePairedDevice(c.identity.deviceId)).not.toBeNull();
      return;
    case "ocid-owner":
    case "ocid-member":
      assert(c.claw);
      expect(
        await c.claw.authority.submit(
          c.row.credential === "ocid-owner"
            ? await c.claw.sign({ op: "revoke_device", peer_key: c.claw.w1 }, c.claw.root)
            : await c.claw.sign({ op: "remove", account_id: c.id }),
          "tunnel",
        ),
      ).toMatchObject({ ok: true });
      return;
    case "principal":
      c.consentCurrent = false;
      c.consent.abort(new Error("Original consent revoked"));
      return;
    case "channel":
      assert(c.profileId);
      await changeCanonicalUserChannelIdentity("unlink", c.profileId, {
        channelId: "discord",
        accountId: "default",
        senderId: "123456789012345678",
      });
      return;
  }
  await fixture.publish(next, c.signal);
}
