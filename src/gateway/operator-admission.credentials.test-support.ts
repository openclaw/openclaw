import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import https from "node:https";
import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import { assert, expect, vi } from "vitest";
import { formatIrohEndpointKey } from "../../packages/openclaw-id-protocol/src/index.js";
import { readAdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import * as attemptTools from "../agents/embedded-agent-runner/run/attempt-tool-prepare.js";
import { dispatchInboundMessageWithBufferedDispatcher } from "../auto-reply/dispatch.js";
import { dispatchLowLevelChannelReplyFromConfig } from "../auto-reply/reply/dispatch-from-config.js";
import * as queueLifecycle from "../auto-reply/reply/queue/lifecycle.js";
import {
  createHostIngressFixture,
  ingressInput,
  ingressMessage,
} from "../channels/message-access/host-ingress.test-support.js";
import { onAgentEvent } from "../infra/agent-events.js";
import { loadDeviceAuthToken } from "../infra/device-auth-store.js";
import { publicKeyRawBase64UrlFromPem } from "../infra/device-identity.js";
import { approveDevicePairing } from "../infra/device-pairing-approval.js";
import * as pairingStore from "../infra/device-pairing-store-readonly.js";
import { revokeDeviceToken } from "../infra/device-pairing-tokens.js";
import { removePairedDevice, requestDevicePairing } from "../infra/device-pairing.js";
import * as tailscale from "../infra/tailscale.js";
import {
  changeCanonicalUserChannelIdentity,
  publishCanonicalUserChannelPolicy,
} from "../state/user-channel-identity-operations.js";
import { ensureCanonicalUserProfileForOpenClawIdIdentity } from "../state/user-profile-openclaw-id.js";
import {
  ensureCanonicalUserProfileForEmail,
  setCanonicalUserProfileRole,
} from "../state/user-profile-writes.js";
import { deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { resolveGatewayAuthForConfig } from "./auth-resolve.js";
import type { GatewayClientOptions } from "./client.js";
import { markGatewayIngressTransport } from "./ingress-attribution.js";
import { linkedClaw } from "./openclaw-id/openclaw-id.test-support.js";
import {
  setOpenClawIdMemberAccountLookup,
  setOpenClawIdTunnelPrincipalLookup,
  setOpenClawIdTunnelPrincipalResolver,
} from "./openclaw-id/tunnel-principal.js";
import * as admission from "./operator-admission.js";
import type { AdmissionCase, AdmissionFixture } from "./operator-admission.table.test-support.js";
import type { OperatorScope } from "./operator-scopes.js";
import * as queuedInputs from "./queued-chat-inputs.js";
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

export function observeAdmissionFixture(fixture: AdmissionFixture) {
  const enqueue = queueLifecycle.markFollowupRunEnqueued;
  const enqueued = vi.spyOn(queueLifecycle, "markFollowupRunEnqueued").mockImplementation((run) => {
    const accepted = enqueue(run);
    const c = fixture.current;
    if (accepted && c && !c.original && run.prompt.includes(c.queuedText)) {
      c.original = run;
      const source = run.operatorAuthority;
      if (c.row.ingress === "live") {
        c.enqueued.resolve();
        return accepted;
      }
      assert(source, "Accepted input must carry real authority");
      if (c.row.ingress === "channel") {
        expect(source.channelRecoverySource).toBeDefined();
      } else {
        const snapshot = source.recoverySnapshot;
        assert(snapshot);
        expect(snapshot.sourceIngress).toBe(c.row.ingress);
        if (snapshot.sourceIngress !== "principal") {
          expect(snapshot.authPolicy.authMethod).toBe(
            c.row.credential === "fallback"
              ? "password"
              : c.row.credential === "proxy-device" || c.row.credential.startsWith("ocid-")
                ? "trusted-proxy"
                : c.row.credential === "tailscale-device"
                  ? "tailscale"
                  : c.row.credential,
          );
          if (c.row.credential === "trusted-proxy") {
            expect(snapshot.device).toBeUndefined();
          }
          if (c.row.credential === "tailscale") {
            expect(snapshot.device).toBeDefined();
            if (c.scenario === "legacy-tailscale" || c.scenario === "legacy-tailscale-narrowed") {
              expect([...snapshot.scopes].toSorted()).toEqual(
                [...WRITER, "operator.approvals"].toSorted(),
              );
            }
          }
          if (c.row.credential === "proxy-device" || c.row.credential === "tailscale-device") {
            expect(snapshot.device).toEqual({
              deviceId: c.identity.deviceId,
              key: sha256Hex(publicKeyRawBase64UrlFromPem(c.identity.publicKeyPem)),
            });
            if (c.row.credential === "tailscale-device") {
              // Requested/paired scopes contain write only; identity supplies read.
              expect([...snapshot.scopes].toSorted()).toEqual([...WRITER].toSorted());
            }
          }
          if (c.row.credential === "fallback") {
            expect(snapshot.authPolicy.fallbackCredentialGeneration).toBeDefined();
          }
          if (c.row.credential.startsWith("ocid-")) {
            expect(snapshot.openclawIdPrincipal?.kind).toBe(
              c.row.credential === "ocid-owner" ? "owner" : "member",
            );
          }
        }
      }
      c.enqueued.resolve();
    }
    return accepted;
  });
  const prepare = admission.prepareOperatorAdmission;
  const prepared = vi
    .spyOn(admission, "prepareOperatorAdmission")
    .mockImplementation(async (...args) => {
      const facts = await prepare(...args);
      const c = fixture.current;
      const followup = fixture.preparingFollowup.getStore();
      if (
        c?.original &&
        c.scenario === "before-start" &&
        !c.preparedHeld &&
        followup?.prompt.includes(c.queuedText) &&
        (c.row.credential === "channel" || followup !== c.original) &&
        ["principal", "channel"].includes(c.row.credential) &&
        "snapshot" in args[0] &&
        args[0].snapshot.profileId === c.profileId
      ) {
        c.preparedHeld = true;
        c.prepared.resolve();
        await c.releasePrepared.promise;
      }
      return facts;
    });
  const drain = queuedInputs.continueSessionQueuedInputs;
  const drained = vi
    .spyOn(queuedInputs, "continueSessionQueuedInputs")
    .mockImplementation(async (context, target, options) => {
      const c = fixture.current;
      if (c?.sessionKey !== target.sessionKey) {
        return await drain(context, target, options);
      }
      if (c.restarting) {
        c.drainEntered.resolve();
        await c.releaseDrain.promise;
      }
      try {
        return await drain(context, target, options);
      } finally {
        c.drained.resolve();
      }
    });
  const followup = queueLifecycle.prepareFollowupRunOperatorAuthority;
  const followupAdmission = vi
    .spyOn(queueLifecycle, "prepareFollowupRunOperatorAuthority")
    .mockImplementation(async (run) => {
      try {
        await fixture.preparingFollowup.run(run, () => followup(run));
      } catch (error) {
        const c = fixture.current;
        if (
          c?.row.credential === "principal" &&
          c.scenario === "before-start" &&
          run !== c.original &&
          run.prompt.includes(c.queuedText)
        ) {
          c.finalAdmissionError = error;
        }
        throw error;
      } finally {
        const c = fixture.current;
        if (
          c &&
          ["principal", "channel"].includes(c.row.credential) &&
          run.prompt.includes(c.queuedText) &&
          (c.row.credential === "channel" || run !== c.original)
        ) {
          c.finalAdmissionSettled.resolve();
        }
      }
    });
  const prepareTools = attemptTools.prepareEmbeddedAttemptToolBase;
  const toolScopes = vi
    .spyOn(attemptTools, "prepareEmbeddedAttemptToolBase")
    .mockImplementation(async (params) => {
      const c = fixture.current;
      if (
        c?.original &&
        [
          "narrowed-grant",
          "widened-grant",
          "narrowed-role",
          "legacy-tailscale",
          "legacy-tailscale-narrowed",
        ].includes(c.scenario) &&
        params.attempt.sessionKey === c.sessionKey
      ) {
        const authority = readAdmittedRunOperatorAuthority(params.attempt.admittedRunContext);
        assert(authority, "Recovered tools must receive their admitted operator authority");
        c.observedRunScopes.push([...authority.scopes]);
      }
      return await prepareTools(params);
    });
  const emit = https.Server.prototype.emit;
  const transport = vi.spyOn(https.Server.prototype, "emit").mockImplementation(function (
    this: https.Server,
    event: string | symbol,
    ...args: unknown[]
  ) {
    if (event === "upgrade") {
      const request = args[0] as IncomingMessage;
      if (request.headers["x-admission-relay"] === "tailscale") {
        markGatewayIngressTransport(request, { kind: "managed-tailscale", mode: "serve" });
      }
      const peer = request.headers["x-admission-peer"];
      if (typeof peer === "string") {
        markGatewayIngressTransport(request, {
          kind: "openclaw-id-tunnel",
          peerKey: peer,
          clientIp: "fd7a:115c:a1e0::1",
        });
      }
    }
    return emit.call(this, event, ...args);
  });
  // Fixed daemon I/O only: production attribution still verifies the forwarded identity.
  const whois = vi.spyOn(tailscale, "readTailscaleWhoisIdentity").mockResolvedValue({
    login: PROXY_USER,
    name: "Synthetic operator",
  });
  const unsubscribe = onAgentEvent((event) => {
    const c = fixture.current;
    if (!c || event.sessionKey !== c.sessionKey || event.stream !== "lifecycle") {
      return;
    }
    if (event.data.phase === "start") {
      c.latestRunId = event.runId;
    }
    if (event.data.phase === "end" || event.data.phase === "error") {
      c.terminal(event.runId).resolve(
        event.data.aborted ? "aborted" : event.data.phase === "error" ? "error" : "final",
      );
    }
  });
  fixture.restores.push(
    () => enqueued.mockRestore(),
    () => prepared.mockRestore(),
    () => drained.mockRestore(),
    () => followupAdmission.mockRestore(),
    () => toolScopes.mockRestore(),
    () => transport.mockRestore(),
    () => whois.mockRestore(),
    unsubscribe,
  );
}

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
  const deviceScopes: OperatorScope[] =
    credential === "tailscale-device"
      ? ["operator.write"]
      : c.scenario === "legacy-tailscale" || c.scenario === "legacy-tailscale-narrowed"
        ? [...WRITER, "operator.approvals"]
        : WRITER;
  if (device) {
    const pending = await requestDevicePairing({
      deviceId: c.identity.deviceId,
      publicKey: publicKeyRawBase64UrlFromPem(c.identity.publicKeyPem),
      role: "operator",
      scopes: deviceScopes,
    });
    await approveDevicePairing(pending.request.requestId, { callerScopes: ADMIN });
  }
  const options: Omit<GatewayClientOptions, "url"> = {
    deviceIdentity: device ? c.identity : null,
    clientName:
      c.row.ingress === "control-ui" ? GATEWAY_CLIENT_NAMES.CONTROL_UI : GATEWAY_CLIENT_NAMES.TEST,
    mode: c.row.ingress === "control-ui" ? GATEWAY_CLIENT_MODES.WEBCHAT : GATEWAY_CLIENT_MODES.TEST,
    origin: c.row.ingress === "control-ui" ? ORIGIN : undefined,
    scopes: deviceScopes,
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
  if (credential === "tailscale" || credential === "tailscale-device") {
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
  if (c.scenario === "pairing-unavailable") {
    assert(c.row.credential === "device-token");
    const read = vi
      .spyOn(pairingStore, "loadPairedDevicePairingStoreRecordReadOnly")
      .mockRejectedValueOnce(new Error("synthetic pairing store read failure"));
    fixture.restores.push(() => read.mockRestore());
    return;
  }
  if (c.scenario === "fallback-proxy-policy") {
    assert(c.row.credential === "fallback");
    const password = resolveGatewayAuthForConfig({ config: fixture.config }).password;
    assert(password);
    next.gateway!.auth!.trustedProxy!.allowUsers!.push("new-operator@example.test");
    await fixture.publish(next, c.signal);
    expect(resolveGatewayAuthForConfig({ config: fixture.config }).password).toBe(password);
    return;
  }
  if (c.scenario === "legacy-method-disabled") {
    assert(c.row.credential === "fallback");
    assert(next.gateway!.auth!.password === undefined);
    deleteTestEnvValue("OPENCLAW_GATEWAY_PASSWORD");
    expect(resolveGatewayAuthForConfig({ config: fixture.config }).password).toBeUndefined();
    return;
  }
  if (
    c.scenario === "narrowed-grant" ||
    c.scenario === "widened-grant" ||
    c.scenario === "legacy-tailscale-narrowed"
  ) {
    assert(
      c.row.credential === "trusted-proxy" ||
        c.row.credential === "tailscale" ||
        c.row.credential === "tailscale-device",
    );
    next.gateway!.auth!.identityScopes![PROXY_USER] =
      c.scenario === "widened-grant" ? [...WRITER, ...ADMIN] : ["operator.write"];
    await fixture.publish(next, c.signal);
    return;
  }
  if (c.scenario === "narrowed-role" || c.scenario === "empty-after-role") {
    assert(c.profileId);
    const role = `limited-${c.id}`;
    next.gateway!.roles!.definitions[role] = {
      sessions: { others: "write" },
      agents: "*",
      scopes: c.scenario === "narrowed-role" ? ["operator.write"] : [],
    };
    await fixture.publish(next, c.signal);
    await setCanonicalUserProfileRole(c.profileId, role);
    return;
  }
  if (c.scenario === "owner-unavailable") {
    assert(c.row.credential === "ocid-owner");
    setOpenClawIdTunnelPrincipalLookup(undefined);
    return;
  }
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
    case "tailscale-device":
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
      c.consent.abort(new DOMException("Original consent revoked", "AbortError"));
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
