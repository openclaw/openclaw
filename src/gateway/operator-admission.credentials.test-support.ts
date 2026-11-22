import { randomBytes, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import https from "node:https";
import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import { assert, expect, vi } from "vitest";
import {
  fingerprint,
  formatIrohEndpointKey,
  ROOT_EPOCH,
  signStatement,
} from "../../packages/openclaw-id-protocol/src/index.js";
import { readAdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import { expectOwnerGated } from "../agents/agent-tools.turn-authority.test-support.js";
import * as attemptTools from "../agents/embedded-agent-runner/run/attempt-tool-prepare.js";
import * as queueLifecycle from "../auto-reply/reply/queue/lifecycle.js";
import { onAgentEvent } from "../infra/agent-events.js";
import { loadDeviceAuthToken } from "../infra/device-auth-store.js";
import { publicKeyRawBase64UrlFromPem } from "../infra/device-identity.js";
import { approveDevicePairing } from "../infra/device-pairing-approval.js";
import { isPairedDeviceTokenIdentityCurrent } from "../infra/device-pairing-identity.js";
import * as pairingStore from "../infra/device-pairing-store-readonly.js";
import {
  loadDevicePairingStoreState,
  persistDevicePairingStoreState,
  updatePairedDeviceInTransaction,
} from "../infra/device-pairing-store.js";
import { revokeDeviceToken } from "../infra/device-pairing-tokens.js";
import { removePairedDevice, requestDevicePairing } from "../infra/device-pairing.js";
import * as tailscale from "../infra/tailscale.js";
import { changeCanonicalUserChannelIdentity } from "../state/user-channel-identity-operations.js";
import { ensureCanonicalUserProfileForOpenClawIdIdentity } from "../state/user-profile-openclaw-id.js";
import { setCanonicalUserProfileRole } from "../state/user-profile-writes.js";
import { deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { resolveGatewayAuthForConfig } from "./auth-resolve.js";
import type { GatewayClientOptions } from "./client.js";
import { markGatewayIngressTransport } from "./ingress-attribution.js";
import { setDeviceTokenBindingOwner } from "./openclaw-id/device-token-binding.js";
import { linkedClaw, nowSeconds } from "./openclaw-id/openclaw-id.test-support.js";
import {
  setOpenClawIdMemberAccountLookup,
  setOpenClawIdTunnelPrincipalLookup,
  setOpenClawIdTunnelPrincipalResolver,
} from "./openclaw-id/tunnel-principal.js";
import {
  expectPluginAccessGrant,
  revokePluginAccessGrant,
} from "./operator-admission.access.test-support.js";
import {
  ADMIN,
  ADMIN_USER,
  ORIGIN,
  PROXY_USER,
  WRITER,
  proxyHeaders,
  type Row,
} from "./operator-admission.contracts.test-support.js";
import * as admission from "./operator-admission.js";
import type { AdmissionCase, AdmissionFixture } from "./operator-admission.table.test-support.js";
import { getGatewayControlUiIngressHost } from "./remote-control-ui-ingress-host.js";
import { createGatewayControlUiIngressFactory } from "./remote-control-ui-ingress.js";

export async function prepareAdmissionOcidPeer(c: AdmissionCase) {
  c.claw = await linkedClaw();
  c.peerKey = c.claw.w1;
  if (c.row.credential !== "ocid-owner") {
    c.peerKey = formatIrohEndpointKey(randomBytes(32));
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
    await setCanonicalUserProfileRole(
      profile.id,
      c.scenario === "live-ocid-grant" ? "ocid-grant" : "operator",
    );
  }
  const authority = c.claw.authority;
  setDeviceTokenBindingOwner({
    lookup: (id, role) => authority.tokenBinding(id, role),
    record: (id, role, key) => authority.bindToken(id, role, key),
    forget: (tokens) => authority.unbindTokens(tokens),
    reportMismatch() {},
  });
  setOpenClawIdTunnelPrincipalResolver((key) => authority.resolvePeer(key));
  setOpenClawIdTunnelPrincipalLookup((key) => authority.currentPeer(key));
  setOpenClawIdMemberAccountLookup((id) => id === c.id);
  return c.peerKey;
}

export function observeAdmissionFixture(fixture: AdmissionFixture) {
  const enqueue = queueLifecycle.markFollowupRunEnqueued;
  const enqueued = vi.spyOn(queueLifecycle, "markFollowupRunEnqueued").mockImplementation((run) => {
    const accepted = enqueue(run);
    const c = fixture.current;
    if (
      accepted &&
      c?.scenario === "owner-revoked-before-start" &&
      run.prompt.includes(c.queuedText)
    ) {
      c.original ??= run;
      c.queuedOwners.push(run.run.senderIsOwner === true);
      c.enqueued.resolve();
      return accepted;
    }
    if (accepted && c?.scenario === "mixed-owner-group" && run.prompt.includes(c.queuedText)) {
      c.original ??= run;
      c.queuedOwners.push(run.run.senderIsOwner === true);
      if (c.queuedOwners.length === 2) {
        c.enqueued.resolve();
      }
      return accepted;
    }
    if (accepted && c && !c.original && run.prompt.includes(c.queuedText)) {
      c.original = run;
      const source = run.operatorAuthority;
      if (c.row.ingress === "live" || c.scenario === "live-ocid-grant") {
        c.enqueued.resolve();
        return accepted;
      }
      assert(source, "Accepted input must carry real authority");
      if (c.row.credential === "plugin-grant") {
        expectPluginAccessGrant(c, source);
      }
      if (
        ["narrowed-token", "narrowed-ingress", "narrowed-grant", "narrowed-role"].includes(
          c.scenario,
        )
      ) {
        expect([...source.scopes].toSorted()).toEqual([...WRITER, "operator.approvals"].toSorted());
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
        ["principal", "channel"].includes(c.row.credential) &&
        "snapshot" in args[0] &&
        args[0].snapshot.profileId === c.profileId
      ) {
        c.preparedHeld = true;
        // Revoke inside the held preparation, without requiring replay's ACK to finish first.
        await revokeAdmissionSource(fixture, c);
      }
      return facts;
    });
  const followup = queueLifecycle.prepareFollowupRunOperatorAuthority;
  const followupAdmission = vi
    .spyOn(queueLifecycle, "prepareFollowupRunOperatorAuthority")
    .mockImplementation(async (run, context) => {
      try {
        await fixture.preparingFollowup.run(run, () => followup(run, context));
      } catch (error) {
        const c = fixture.current;
        if (
          c &&
          ["principal", "channel"].includes(c.row.credential) &&
          c.scenario === "before-start" &&
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
          run.prompt.includes(c.queuedText)
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
        (c.row.credential === "live-grant" ||
          c.row.credential === "live-role" ||
          c.row.credential === "plugin-grant" ||
          [
            "narrowed-grant",
            "narrowed-token",
            "narrowed-ingress",
            "widened-grant",
            "narrowed-role",
            "legacy-tailscale",
            "legacy-tailscale-narrowed",
            "live-ocid-grant",
          ].includes(c.scenario)) &&
        params.attempt.sessionKey === c.sessionKey
      ) {
        const authority = readAdmittedRunOperatorAuthority(params.attempt.admittedRunContext);
        assert(authority, "Recovered tools must receive their admitted operator authority");
        c.observedRunScopes.push([...authority.scopes]);
        if (c.row.credential === "plugin-grant") {
          expectPluginAccessGrant(c, authority, true);
        }
      }
      const result = await prepareTools(params);
      if (
        (c?.scenario === "mixed-owner-group" || c?.scenario === "owner-revoked-before-start") &&
        c.original &&
        params.attempt.sessionKey === c.sessionKey &&
        params.attempt.prompt.includes(c.queuedText)
      ) {
        expect(params.attempt.senderIsOwner).toBe(false);
        expect(result.toolsRaw.some((tool) => tool.name === "gateway")).toBe(true);
        await expectOwnerGated(result.toolsRaw, "gateway", "automations", "nodes", "openclaw");
        c.ownerToolChecks++;
      }
      return result;
    });
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
    return EventEmitter.prototype.emit.call(this, event, ...args);
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
    () => followupAdmission.mockRestore(),
    () => toolScopes.mockRestore(),
    () => transport.mockRestore(),
    () => whois.mockRestore(),
    unsubscribe,
  );
}

export async function prepareAdmissionOperator(
  fixture: AdmissionFixture,
  c: AdmissionCase,
  connection?: {
    credential: Row["credential"];
    scopes: typeof WRITER;
    ingress?: Row["ingress"];
    origin?: string;
    proxyUser?: string;
  },
) {
  const credential = connection?.credential ?? c.row.credential;
  const legacyTailscale = ["legacy-tailscale", "legacy-tailscale-narrowed"].includes(c.scenario);
  const initialScopes = [...(connection?.scopes ?? WRITER)];
  if (
    legacyTailscale ||
    [
      "narrowed-token",
      "narrowed-ingress",
      "narrowed-grant",
      "narrowed-role",
      "live-ocid-grant",
    ].includes(c.scenario)
  ) {
    initialScopes.push("operator.approvals");
  }
  if (legacyTailscale) {
    initialScopes.push("operator.pairing");
  }
  if (c.scenario === "live-ocid-grant") {
    initialScopes.push("operator.questions");
    const next = structuredClone(fixture.config);
    assert(next.gateway?.roles?.definitions.operator && next.gateway.auth?.identityScopes);
    next.gateway.auth.identityScopes[`openclaw-id:${c.id}`] = [
      "operator.approvals",
      "operator.questions",
    ];
    next.gateway.roles.definitions["ocid-grant"] = {
      ...next.gateway.roles.definitions.operator,
      scopes: [...WRITER, "operator.approvals"],
      modelPolicy: {
        deny: Array.from({ length: 257 }, (_, index) => `unrelated-${index}/*`),
      },
    };
    await fixture.publish(next, c.signal);
  }
  if (legacyTailscale || ["narrowed-grant", "narrowed-role"].includes(c.scenario)) {
    const next = structuredClone(fixture.config);
    next.gateway!.auth!.identityScopes![PROXY_USER] = [
      ...WRITER,
      legacyTailscale ? "operator.pairing" : "operator.approvals",
    ];
    await fixture.publish(next, c.signal);
  }
  if (credential === "principal" || credential === "device-token") {
    const next = structuredClone(fixture.config);
    delete next.gateway!.roles;
    await fixture.publish(next, c.signal);
  }
  if (credential === "principal") {
    assert(fixture.kernel);
    const host = getGatewayControlUiIngressHost(fixture.kernel.resolvePluginGatewayContext);
    assert(host);
    const factory = createGatewayControlUiIngressFactory({
      pluginId: `admission-${c.id}`,
      signal: c.service.signal,
      assertCurrent: () => c.service.signal.throwIfAborted(),
      host,
    });
    c.ingressScopeCeiling = initialScopes;
    const principal = {
      audienceId: c.id,
      principal: { kind: "owner" as const },
      operatorScopeCeiling: c.ingressScopeCeiling,
      signal: c.consent.signal,
      assertCurrent: () => c.consent.signal.throwIfAborted(),
    };
    if (c.row.credential === "principal") {
      assert(factory.registerPrincipalRecovery !== undefined);
      await factory.registerPrincipalRecovery(async () =>
        c.consentCurrent
          ? { ...principal, recoveryId: c.id, operatorScopeCeiling: c.ingressScopeCeiling }
          : undefined,
      );
    }
    const binding = await factory.bindPrincipal(principal);
    fixture.bindings.push(binding);
    return binding;
  }
  const device = credential !== "trusted-proxy" && credential !== "plugin-grant";
  // Identity-only approvals must disappear when the identity grant narrows.
  const deviceScopes =
    credential === "tailscale-device" || c.scenario === "live-ocid-grant" ? WRITER : initialScopes;
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
      (connection?.ingress ?? c.row.ingress) === "control-ui"
        ? GATEWAY_CLIENT_NAMES.CONTROL_UI
        : GATEWAY_CLIENT_NAMES.TEST,
    mode:
      (connection?.ingress ?? c.row.ingress) === "control-ui"
        ? GATEWAY_CLIENT_MODES.WEBCHAT
        : GATEWAY_CLIENT_MODES.TEST,
    origin:
      (connection?.ingress ?? c.row.ingress) === "control-ui"
        ? (connection?.origin ?? ORIGIN)
        : undefined,
    scopes: device ? deviceScopes : initialScopes,
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
  if (
    credential === "trusted-proxy" ||
    credential === "proxy-device" ||
    credential === "plugin-grant"
  ) {
    options.edgeAuthHeaders = proxyHeaders(connection?.proxyUser ?? PROXY_USER);
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
    options.edgeAuthHeaders = { "x-admission-peer": await prepareAdmissionOcidPeer(c) };
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

export async function revokeAdmissionSource(fixture: AdmissionFixture, c: AdmissionCase) {
  assert(c.row.ingress !== "live", "Live admission revocation must use its credential producer");
  const next = structuredClone(fixture.config);
  if (c.row.credential === "plugin-grant") {
    revokePluginAccessGrant(c);
    return;
  }
  if (c.scenario === "narrowed-token") {
    assert(c.row.credential === "device-token");
    const before = await pairingStore.loadPairedDevicePairingStoreRecordReadOnly(
      c.identity.deviceId,
    );
    assert(before);
    const identity = c.original?.operatorAuthority?.recoverySnapshot?.device;
    assert(identity);
    expect(isPairedDeviceTokenIdentityCurrent(before, "operator", identity, [])).toBe(true);
    updatePairedDeviceInTransaction(c.identity.deviceId, (device) => {
      assert(device?.tokens?.operator);
      return {
        value: undefined,
        patch: {
          tokens: {
            ...device.tokens,
            operator: { ...device.tokens.operator, scopes: [...WRITER] },
          },
        },
      };
    });
    const after = await pairingStore.loadPairedDevicePairingStoreRecordReadOnly(
      c.identity.deviceId,
    );
    assert(after);
    expect(isPairedDeviceTokenIdentityCurrent(after, "operator", identity, [])).toBe(true);
    expect(after.tokens?.operator?.scopes).toEqual(WRITER);
    return;
  }
  if (c.scenario === "narrowed-ingress") {
    assert(c.row.credential === "principal");
    c.ingressScopeCeiling = [...WRITER];
    return;
  }
  if (c.scenario === "device-token-revoked" || c.scenario === "device-role-unapproved") {
    assert(c.row.credential === "tailscale-device");
    const before = await pairingStore.loadPairedDevicePairingStoreRecordReadOnly(
      c.identity.deviceId,
    );
    assert(before?.tokens?.operator);
    expect(c.original?.operatorAuthority?.recoverySnapshot?.device).toEqual({
      deviceId: before.deviceId,
      key: sha256Hex(before.publicKey),
    });
    if (c.scenario === "device-token-revoked") {
      expect(
        await revokeDeviceToken({
          deviceId: c.identity.deviceId,
          role: "operator",
          callerScopes: ADMIN,
        }),
      ).toMatchObject({ ok: true, entry: { revokedAtMs: expect.any(Number) } });
    } else {
      // Change only approval, not the key, token, scopes or record's existence.
      const state = loadDevicePairingStoreState();
      const device = state.pairedByDeviceId[c.identity.deviceId];
      assert(device);
      device.role = "node";
      device.roles = ["node"];
      persistDevicePairingStoreState(state, undefined, "paired");
    }
    const after = await pairingStore.loadPairedDevicePairingStoreRecordReadOnly(
      c.identity.deviceId,
    );
    assert(after);
    expect(after.publicKey).toBe(before.publicKey);
    expect(after.approvedScopes).toEqual(before.approvedScopes);
    if (c.scenario === "device-token-revoked") {
      expect(after.role).toBe(before.role);
      expect(after.roles).toEqual(before.roles);
      expect(after.tokens?.operator?.revokedAtMs).toEqual(expect.any(Number));
    } else {
      expect(after.tokens).toEqual(before.tokens);
      expect(after.tokens?.operator?.revokedAtMs).toBeUndefined();
    }
    return;
  }
  if (c.scenario === "owner-disabled") {
    assert(c.row.credential === "ocid-owner");
    next.gateway!.openclawId = { ...next.gateway!.openclawId, enabled: false };
    await fixture.publish(next, c.signal);
    setOpenClawIdTunnelPrincipalLookup(undefined);
    return;
  }
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
      c.scenario === "widened-grant" ? [...WRITER, ...ADMIN] : [...WRITER];
    await fixture.publish(next, c.signal);
    return;
  }
  if (c.scenario === "narrowed-role" || c.scenario === "empty-after-role") {
    assert(c.profileId);
    const role = `limited-${c.id}`;
    next.gateway!.roles!.definitions[role] = {
      sessions: { others: "write" },
      agents: "*",
      scopes: c.scenario === "narrowed-role" ? [...WRITER] : [],
    };
    await fixture.publish(next, c.signal);
    await setCanonicalUserProfileRole(c.profileId, role);
    return;
  }
  if (c.scenario === "owner-unavailable") {
    assert(c.row.credential === "ocid-owner");
    expect(fixture.config.gateway?.openclawId?.enabled).toBe(true);
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
    case "ocid-member": {
      assert(c.claw);
      const state = await c.claw.authority.load();
      assert(state?.authority);
      expect(
        await c.claw.authority.submit(
          c.row.credential === "ocid-owner"
            ? await signStatement(
                "Revocation",
                {
                  claw_id: c.claw.clawId,
                  seq: state.authority.seq,
                  target_fp: await fingerprint(c.claw.cert.body.device_pub),
                  target_kind: "owner_device",
                  reason: "lost",
                  root_epoch: ROOT_EPOCH,
                  issued_at: nowSeconds(),
                },
                c.claw.root,
              )
            : await c.claw.sign({ op: "remove", account_id: c.id }),
          "tunnel",
        ),
      ).toMatchObject({ ok: true });
      assert(c.peerKey);
      expect(c.claw.authority.currentPeer(c.peerKey)).toBeUndefined();
      setOpenClawIdTunnelPrincipalLookup(c.claw.authority.currentPeer.bind(c.claw.authority));
      return;
    }
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
