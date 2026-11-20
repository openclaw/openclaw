import { randomUUID } from "node:crypto";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { assert, expect, vi } from "vitest";
import { formatIrohEndpointKey } from "../../packages/openclaw-id-protocol/src/index.js";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import type { AdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import { captureOperatorModelPolicySnapshot } from "../agents/operator-model-policy.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { GatewayOperatorRecoveryAuthorizationError } from "../infra/restart-recovery-errors.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { runWithGatewayIndependentRootWorkAdmission } from "../process/gateway-work-admission.js";
import { ensureCanonicalUserProfileForOpenClawIdIdentity } from "../state/user-profile-openclaw-id.js";
import {
  ensureCanonicalUserProfileForEmail,
  setCanonicalUserProfileRole,
} from "../state/user-profile-writes.js";
import { resolveGatewayAuthForConfig } from "./auth-resolve.js";
import {
  checkGatewayHttpRequestAuth,
  resolveSharedSecretHttpOperatorScopes,
} from "./http-auth-utils.js";
import { markGatewayIngressTransport } from "./ingress-attribution.js";
import { runOpenAiCompatibleAgentCommand } from "./openai-compatible-agent-run.js";
import { linkedClaw } from "./openclaw-id/openclaw-id.test-support.js";
import {
  setOpenClawIdMemberAccountLookup,
  setOpenClawIdTunnelPrincipalLookup,
  setOpenClawIdTunnelPrincipalResolver,
} from "./openclaw-id/tunnel-principal.js";
import { PROXY_USER, WRITER } from "./operator-admission.credentials.test-support.js";
import { runCronAdmissionCase } from "./operator-admission.cron.test-support.js";
import * as admission from "./operator-admission.js";
import {
  isLiveCredentialKind,
  prepareLiveCredentialProducer,
  type LiveCredentialKind,
} from "./operator-admission.live-credentials.test-support.js";
import {
  prepareRemoteIngressProducer,
  type RemoteLiveKind,
} from "./operator-admission.remote.test-support.js";
import type { AdmissionFixture } from "./operator-admission.table.test-support.js";
import * as operatorRun from "./operator-run-authority.js";
import { captureQueuedOperatorRecoverySource } from "./operator-run-recovery-source.js";
import { getGatewayControlUiIngressHost } from "./remote-control-ui-ingress-host.js";
import { createGatewayControlUiIngressFactory } from "./remote-control-ui-ingress.js";
import { dispatchGatewayRequestInProcess } from "./server-in-process-dispatch.js";
import type { GatewayClient } from "./server-methods/types.js";
import {
  captureOperatorToolGatewayContinuationContext,
  dispatchGatewayMethodInProcess,
} from "./server-plugin-in-process-dispatch.js";
import { createSyntheticPluginRuntimeClient } from "./server-plugin-runtime-client.js";
import { prepareSessionPrincipalRunAuthority } from "./session-sharing-authorization-async.js";
import { prepareSessionSystemTurnAuthority } from "./session-system-turn-authority.js";

export type LiveAdmissionKind =
  // Shared HTTP bearer authenticates a system actor, not an admitted operator.
  | "http-bearer"
  | "http-ocid"
  | "openai-compatible"
  | "plugin-in-process"
  | "recorded-person"
  | "recorded-system-turn"
  | LiveCredentialKind
  | RemoteLiveKind
  | "live-ingress"
  // These are separate run/receipt capabilities, not operator admission.
  | "cron-standing-grant"
  | "cron-management-grant"
  | "cron-operator-source";

type Scenario = "before-start" | "after-start" | "stop";
type History = {
  messages: unknown[];
  pendingInputs: {
    items: Array<{ runId: string; state: string; endCause?: string; message: unknown }>;
  };
};
export type LiveAdmissionProducer = {
  client?: GatewayClient;
  send?: (params: Record<string, unknown>) => Promise<{ runId: string }>;
  authority?: AdmittedRunOperatorAuthority;
  hasCurrentClientAuthority?: () => boolean;
  predecessor?: { runId: string; completion: Promise<unknown> };
  revoke: () => Promise<void>;
  release: () => void | Promise<void>;
};

async function prepareLiveProducer(
  kind: Exclude<
    LiveAdmissionKind,
    "cron-standing-grant" | "cron-management-grant" | "cron-operator-source"
  >,
  fixture: AdmissionFixture,
): Promise<LiveAdmissionProducer> {
  if (isLiveCredentialKind(kind)) {
    return prepareLiveCredentialProducer(kind, fixture);
  }
  if (kind === "live-remote-ingress") {
    return prepareRemoteIngressProducer(fixture);
  }
  const c = fixture.current;
  assert(c && fixture.kernel);
  const context = fixture.kernel.gatewayRequestContext;
  const profile =
    kind === "http-ocid" || kind === "openai-compatible"
      ? await ensureCanonicalUserProfileForOpenClawIdIdentity({ accountId: c.id })
      : await ensureCanonicalUserProfileForEmail(`live-${c.id}@example.test`);
  c.profileId = profile.id;
  const next = structuredClone(fixture.config);
  assert(next.gateway?.roles);
  next.gateway.roles.definitions["live-refused"] = {
    scopes: [],
    agents: [],
    sessions: { others: "none" },
  };
  await fixture.publish(next, c.signal);
  await setCanonicalUserProfileRole(profile.id, "operator");
  await replaceSessionEntry(c.target, {
    sessionId: c.target.sessionId,
    updatedAt: Date.now(),
    createdActor: { type: "human", source: "profile", id: profile.id },
  });
  const revokeRole = async () => {
    await setCanonicalUserProfileRole(profile.id, "live-refused");
  };
  if (kind === "live-ingress") {
    const ownerConfig = structuredClone(fixture.config);
    delete ownerConfig.gateway!.roles;
    await fixture.publish(ownerConfig, c.signal);
    const host = getGatewayControlUiIngressHost(fixture.kernel.resolvePluginGatewayContext);
    assert(host, "The real Gateway must own ingress admission");
    const factory = createGatewayControlUiIngressFactory({
      pluginId: `live-admission-${c.id}`,
      signal: c.service.signal,
      assertCurrent: () => c.service.signal.throwIfAborted(),
      host,
    });
    // No recovery registration: this is a real live-only consent, not a saved principal.
    const binding = await factory.bindPrincipal({
      audienceId: c.id,
      principal: { kind: "owner" },
      operatorScopeCeiling: WRITER,
      signal: c.consent.signal,
      assertCurrent: () => c.consent.signal.throwIfAborted(),
    });
    fixture.bindings.push(binding);
    const self = await binding.request<{ profile: { id: string } }>("users.self", {});
    c.profileId = self.profile.id;
    await replaceSessionEntry(c.target, {
      sessionId: c.target.sessionId,
      updatedAt: Date.now(),
      createdActor: { type: "human", source: "profile", id: c.profileId },
    });
    return {
      send: (params) => binding.request("chat.send", params),
      revoke: async () => {
        c.consent.abort();
      },
      release: () => binding.close(),
    };
  }
  if (kind === "http-bearer" || kind === "http-ocid" || kind === "openai-compatible") {
    const req = new IncomingMessage(new Socket());
    req.method = "POST";
    req.url = "/v1/chat/completions";
    const auth = resolveGatewayAuthForConfig({ config: fixture.config });
    if (kind === "http-bearer") {
      assert(auth.token, "The shared-bearer control belongs in the token pool");
      req.headers.authorization = `Bearer ${auth.token}`;
    } else {
      // Real tunnel membership, host transport attribution, and HTTP auth; no
      // caller-supplied profile or manufactured operator recovery snapshot.
      c.claw = await linkedClaw();
      c.peerKey = formatIrohEndpointKey(new Uint8Array(32).fill(181));
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
      const membership = c.claw.authority;
      setOpenClawIdTunnelPrincipalResolver((key) => membership.resolvePeer(key));
      setOpenClawIdTunnelPrincipalLookup((key) => membership.currentPeer(key));
      setOpenClawIdMemberAccountLookup((id) => id === c.id);
      markGatewayIngressTransport(req, {
        kind: "openclaw-id-tunnel",
        peerKey: c.peerKey,
        clientIp: "fd69:726f:6800::1",
      });
    }
    const res = new ServerResponse(req);
    try {
      const authenticated = await checkGatewayHttpRequestAuth({
        req,
        res,
        auth,
        cfg: fixture.config,
        getRuntimeConfig: context.getRuntimeConfig,
        getResolvedAuth: () => resolveGatewayAuthForConfig({ config: context.getRuntimeConfig() }),
      });
      assert(authenticated.ok, `Real ${kind} authentication must succeed`);
      const requestAuth = authenticated.requestAuth;
      if (kind === "openai-compatible") {
        const lifetime = new AbortController();
        const runId = randomUUID();
        let retainedAuthority: AdmittedRunOperatorAuthority | undefined;
        let releaseRetained: (() => void) | undefined;
        const prepare = operatorRun.prepareGatewayOperatorRunAuthority;
        const observer = vi
          .spyOn(operatorRun, "prepareGatewayOperatorRunAuthority")
          .mockImplementation(async (input) => {
            const prepared = await prepare(input);
            const principal = input.client?.internal?.openclawIdPrincipal;
            if (
              !retainedAuthority &&
              principal?.kind === "member" &&
              principal.accountId === c.id
            ) {
              assert(
                prepared?.authority.retain,
                "OpenAI must produce a retainable operator source",
              );
              retainedAuthority = prepared.authority;
              releaseRetained = prepared.authority.retain();
            }
            return prepared;
          });
        // The actual HTTP agent producer owns the predecessor. Its source is
        // observed, never replaced, and retained before its finally releases it.
        const completion = runWithGatewayIndependentRootWorkAdmission(
          () =>
            withPluginRuntimeGatewayRequestScope(
              {
                context,
                resolveGatewayContext: context.resolveGatewayContext,
                isWebchatConnect: () => false,
              },
              () =>
                runOpenAiCompatibleAgentCommand({
                  message: "hold OpenAI-compatible predecessor",
                  sessionKey: c.sessionKey,
                  runId,
                  messageChannel: "webchat",
                  senderIsOwner: false,
                  requestAuth,
                  operatorScopes: resolveSharedSecretHttpOperatorScopes(req, requestAuth),
                  hasCurrentClientAuthority: requestAuth.hasCurrentClientAuthority,
                  abortSignal: AbortSignal.any([c.signal, lifetime.signal]),
                  resolveGatewayContext: context.resolveGatewayContext,
                }),
            ),
          "test:openai-compatible-admission",
          c.signal,
        );
        // Preparation and the provider barrier observe failures while the
        // producer remains pending behind its real first model request.
        void completion.catch(() => {});
        try {
          await c.wait(
            awaitGateBeforeSettlement(
              c.firstReached.promise,
              completion,
              "OpenAI-compatible producer settled before reaching the provider",
            ),
          );
          assert(
            retainedAuthority && releaseRetained,
            "The actual OpenAI producer must transfer its operator authority",
          );
          const authority = retainedAuthority;
          const release = releaseRetained;
          return {
            client: createSyntheticPluginRuntimeClient({
              operatorRunAuthority: authority,
              scopes: [...authority.scopes],
            }),
            authority,
            predecessor: { runId, completion },
            revoke: revokeRole,
            release: async () => {
              lifetime.abort();
              c.releaseFirst.resolve();
              await completion.catch(() => {});
              release();
              res.destroy();
              req.destroy();
            },
          };
        } catch (error) {
          lifetime.abort();
          c.releaseFirst.resolve();
          await completion.catch(() => {});
          releaseRetained?.();
          throw error;
        } finally {
          observer.mockRestore();
        }
      }
      // This is the OpenAI-compatible/tools HTTP adapter's production client
      // factory, preserving the authenticated actor and access grant verbatim.
      const client = createSyntheticPluginRuntimeClient({
        authenticatedUserProfile: requestAuth.authenticatedUserProfile,
        operatorRoleActor: requestAuth.operatorRoleActor,
        openclawIdPrincipal: requestAuth.openclawIdPrincipal,
        operatorAccessAuthority: requestAuth.operatorAccessAuthority,
        scopes: ["operator.admin"],
      });
      const admitted = await operatorRun.prepareGatewayOperatorRunAuthority({
        client,
        context,
        hasCurrentClientAuthority: requestAuth.hasCurrentClientAuthority,
        sourceAuthority: requestAuth.operatorAccessAuthority,
      });
      if (kind === "http-bearer") {
        expect(requestAuth.operatorRoleActor).toEqual({ kind: "system" });
        expect(admitted).toBeUndefined();
      } else {
        assert(admitted, "The host-authenticated HTTP member must yield live operator authority");
      }
      const authority = admitted?.authority;
      return {
        client: authority
          ? createSyntheticPluginRuntimeClient({
              operatorRunAuthority: authority,
              scopes: [...authority.scopes],
            })
          : client,
        authority,
        hasCurrentClientAuthority: requestAuth.hasCurrentClientAuthority,
        revoke: revokeRole,
        release: () => {
          admitted?.release();
          res.destroy();
          req.destroy();
        },
      };
    } catch (error) {
      res.destroy();
      req.destroy();
      throw error;
    }
  }
  const prepared =
    kind === "recorded-system-turn"
      ? await prepareSessionSystemTurnAuthority({ context, ...c.target })
      : await prepareSessionPrincipalRunAuthority({ context, profileId: profile.id, ...c.target });
  assert(prepared, "The real recorded-person owner must admit its current role");
  return {
    client: createSyntheticPluginRuntimeClient({
      operatorRunAuthority: prepared.authority,
      scopes: [...prepared.authority.scopes],
    }),
    authority: prepared.authority,
    revoke: revokeRole,
    release: prepared.release,
  };
}

/** Live-only sources retain accepted input in memory, then use the ordinary queue admission. */
export async function runLiveAdmissionCase(
  kind: LiveAdmissionKind,
  scenario: Scenario,
  fixture: AdmissionFixture,
) {
  const c = fixture.current;
  assert(c && fixture.kernel);
  const context = fixture.kernel.gatewayRequestContext;
  if (
    kind === "cron-standing-grant" ||
    kind === "cron-management-grant" ||
    kind === "cron-operator-source"
  ) {
    return await runCronAdmissionCase(kind, scenario, fixture);
  }
  const producer = await prepareLiveProducer(kind, fixture);
  const credentialKind = isLiveCredentialKind(kind);
  const proxyCredential = credentialKind && kind !== "live-token" && kind !== "live-fallback";
  const remoteCredential = kind === "live-remote-ingress";
  const liveCredential = credentialKind || kind === "live-ingress" || remoteCredential;
  let liveStartDecisions = 0;
  const decide = admission.decideOperatorAdmission;
  const decisionObserver = vi
    .spyOn(admission, "decideOperatorAdmission")
    .mockImplementation((facts, prepared) => {
      if (liveCredential && c.original) {
        expect(facts.kind).toBe("live");
        assert(facts.kind === "live");
        expect(captureQueuedOperatorRecoverySource(facts.authority)?.kind).toBe("unavailable");
        if (proxyCredential) {
          expect(facts.authority.authPolicy).toMatchObject({
            authMethod: "trusted-proxy",
            verifiedIdentity: PROXY_USER,
          });
          expect(facts.authority.sharedGeneration).toBe(
            c.original.operatorAuthority?.sharedGeneration,
          );
        }
        // The shared live fact check, not an obsolete invocation, owns this new start.
        expect(() => facts.authority.assertCurrent()).not.toThrow();
        liveStartDecisions++;
      }
      return decide(facts, prepared);
    });
  try {
    if (producer.authority) {
      const source = captureQueuedOperatorRecoverySource(producer.authority);
      expect(source).toMatchObject(
        kind === "http-ocid" || kind === "openai-compatible"
          ? {
              kind: "gateway",
              snapshot: { openclawIdPrincipal: { kind: "member", accountId: c.id } },
            }
          : { kind: "unavailable" },
      );
    }
    const admin = await fixture.admin(c.signal);
    const first =
      producer.predecessor ??
      (await admin.request<{ runId: string }>("chat.send", {
        sessionKey: c.sessionKey,
        message: "hold predecessor",
        deliver: false,
        idempotencyKey: randomUUID(),
      }));
    await c.wait(
      awaitGateBeforeSettlement(
        c.firstReached.promise,
        c.terminal(first.runId).promise,
        "Predecessor settled before reaching the provider",
      ),
    );
    const sendParams = {
      sessionKey: c.sessionKey,
      message: c.queuedText,
      deliver: false,
      queueMode: "followup",
      idempotencyKey: c.id,
    };
    const send = () => {
      if (producer.send) {
        return producer.send(sendParams);
      }
      assert(producer.client);
      return dispatchGatewayRequestInProcess<{ runId: string }>("chat.send", sendParams, {
        client: producer.client,
        context,
        hasCurrentClientAuthority: producer.hasCurrentClientAuthority,
      });
    };
    const accepted = producer.send
      ? await send()
      : await withPluginRuntimeGatewayRequestScope(
          {
            client: producer.client,
            context,
            resolveGatewayContext: context.resolveGatewayContext,
            hasCurrentClientAuthority: producer.hasCurrentClientAuthority,
            isWebchatConnect: () => false,
          },
          async () => {
            if (kind !== "plugin-in-process") {
              return await send();
            }
            const continuation = await captureOperatorToolGatewayContinuationContext(
              { agentId: "main", sessionKey: c.sessionKey },
              { retainRequester: true },
            );
            assert(continuation?.operatorAuthority);
            try {
              // Dispatch consumes the freshly admitted requester scope, not the old source.
              return await continuation.runWithRequester(() =>
                dispatchGatewayMethodInProcess<{ runId: string }>("chat.send", sendParams),
              );
            } finally {
              continuation.release();
            }
          },
        );
    c.queuedRunId = accepted.runId;
    await c.wait(c.enqueued.promise);
    assert(c.original?.controllerInput, "Real chat acceptance must own its queue receipt");
    if (liveCredential) {
      const authority = c.original.operatorAuthority;
      assert(authority, "The real transport must queue its actual operator authority");
      expect(authority.recoverySnapshot).toBeUndefined();
      expect(authority.signal?.aborted).not.toBe(true);
      expect(authority.invocation).toBeUndefined();
      expect(Object.isFrozen(authority)).toBe(true);
      expect(captureQueuedOperatorRecoverySource(authority)).toEqual({
        kind: "unavailable",
        reason: credentialKind ? "decode-failed" : "remote-ingress-no-source",
      });
      if (credentialKind) {
        expect(authority.authPolicy).toMatchObject({
          authMethod:
            kind === "live-token"
              ? "token"
              : kind === "live-fallback"
                ? "password"
                : "trusted-proxy",
          ...(proxyCredential ? { verifiedIdentity: PROXY_USER } : {}),
        });
        expect(authority.sharedGeneration).toEqual(expect.any(String));
        if (kind === "live-grant") {
          expect(authority.device).toBeUndefined();
        } else {
          expect(authority.device).toEqual({
            deviceId: c.identity.deviceId,
            key: expect.any(String),
          });
          expect(Object.isFrozen(authority.device)).toBe(true);
        }
        if (proxyCredential) {
          expect(
            captureOperatorModelPolicySnapshot(authority.modelPolicy)?.denied.wildcards,
          ).toHaveLength(257);
        }
      } else {
        expect(authority.ingress).toMatchObject({
          bindingId: expect.any(String),
          pluginId: remoteCredential ? expect.any(String) : `live-admission-${c.id}`,
          audienceId: expect.any(String),
          principal: { kind: "owner" },
          scopeCeiling: WRITER,
        });
        if (remoteCredential) {
          expect(authority.authPolicy?.authMethod).toBe("remote-ingress");
          expect(authority.sharedGeneration).toBeUndefined();
        }
        expect(Object.isFrozen(authority.ingress)).toBe(true);
        expect(Object.isFrozen(authority.ingress?.principal)).toBe(true);
        expect(Object.isFrozen(authority.ingress?.scopeCeiling)).toBe(true);
      }
    }
    if (scenario === "before-start") {
      await producer.revoke();
    }
    c.releaseFirst.resolve();
    if (producer.predecessor) {
      await c.wait(producer.predecessor.completion);
    }
    if (
      scenario === "before-start" &&
      !["http-bearer", "live-grant", "live-remote-ingress"].includes(kind)
    ) {
      await expect(c.wait(c.original.controllerInput.settlement.promise)).rejects.toBeInstanceOf(
        GatewayOperatorRecoveryAuthorizationError,
      );
      const observer = await fixture.admin(c.signal);
      const history = await observer.request<History>("chat.history", { sessionKey: c.sessionKey });
      const refused = history.pendingInputs.items.find((input) => input.runId === c.queuedRunId);
      expect(refused).toMatchObject({ state: "cancelled", endCause: "policy-refused" });
      expect(JSON.stringify(refused?.message)).toContain(c.queuedText);
      expect(c.queuedCalls).toBe(0);
    } else {
      await c.wait(c.recoveredReached.promise);
      assert(c.latestRunId);
      if (kind === "live-grant") {
        expect(c.observedRunScopes.length).toBeGreaterThan(0);
        for (const scopes of c.observedRunScopes) {
          expect(scopes.toSorted()).toEqual(
            (scenario === "before-start" ? WRITER : [...WRITER, "operator.approvals"]).toSorted(),
          );
        }
      }
      const running = c.latestRunId;
      if (scenario === "stop") {
        expect(await admin.request("chat.abort", { sessionKey: c.sessionKey })).toMatchObject({
          aborted: true,
        });
        expect(await c.wait(c.terminal(running).promise)).toBe("aborted");
        c.releaseRecovered.resolve();
      } else {
        if (scenario === "after-start") {
          await producer.revoke();
        }
        c.releaseRecovered.resolve();
        expect(await c.wait(c.terminal(running).promise)).toBe("final");
      }
      const observer = await fixture.admin(c.signal);
      const history = await observer.request<History>("chat.history", { sessionKey: c.sessionKey });
      if (scenario === "stop") {
        expect(JSON.stringify(history.messages)).not.toContain(c.answer);
      } else {
        expect(JSON.stringify(history.messages)).toContain(c.answer);
      }
      expect(c.queuedCalls).toBe(1);
    }
    if (liveCredential) {
      expect(liveStartDecisions).toBeGreaterThan(0);
    }
    expect(fixture.providerErrors).toEqual([]);
  } finally {
    decisionObserver.mockRestore();
    await producer.release();
  }
}
