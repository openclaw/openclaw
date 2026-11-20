import { randomUUID } from "node:crypto";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { assert, expect, vi } from "vitest";
import { formatIrohEndpointKey } from "../../packages/openclaw-id-protocol/src/index.js";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import type { AdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import * as cronCreator from "../agents/cron-creator-authority-context.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import * as cronRun from "../cron/run-admission.js";
import type { CronStandingGrantAuthority } from "../cron/standing-grant-authority.types.js";
import type { CronStoredJob } from "../cron/types.js";
import { getAgentRunContext } from "../infra/agent-run-registry.js";
import { publicKeyRawBase64UrlFromPem } from "../infra/device-identity.js";
import { approveDevicePairing } from "../infra/device-pairing-approval.js";
import { removePairedDevice, requestDevicePairing } from "../infra/device-pairing.js";
import { GatewayOperatorRecoveryAuthorizationError } from "../infra/restart-recovery-errors.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { runWithGatewayIndependentRootWorkAdmission } from "../process/gateway-work-admission.js";
import { ensureCanonicalUserProfileForOpenClawIdIdentity } from "../state/user-profile-openclaw-id.js";
import {
  ensureCanonicalUserProfileForEmail,
  setCanonicalUserProfileRole,
} from "../state/user-profile-writes.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { createAgentRuntimeIdentity } from "./agent-runtime-identity-token.js";
import { resolveGatewayAuthForConfig } from "./auth-resolve.js";
import {
  mintCronCreatorAuthorityGrant,
  revokeCronCreatorAuthorityRunScope,
} from "./cron-creator-authority-grant.js";
import type { CronCreatorAuthorityRunScope } from "./cron-creator-authority-grant.types.js";
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
import { ORIGIN } from "./operator-admission.credentials.test-support.js";
import type { AdmissionFixture } from "./operator-admission.table.test-support.js";
import * as operatorRun from "./operator-run-authority.js";
import { captureQueuedOperatorRecoverySource } from "./operator-run-recovery-source.js";
import { dispatchGatewayRequestInProcess } from "./server-in-process-dispatch.js";
import type { GatewayClient } from "./server-methods/types.js";
import {
  captureOperatorToolGatewayContinuationContext,
  dispatchGatewayMethodInProcess,
} from "./server-plugin-in-process-dispatch.js";
import {
  createSyntheticPluginRuntimeClient,
  mergePluginRuntimeClientInternal,
} from "./server-plugin-runtime-client.js";
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
type Producer = {
  client: GatewayClient;
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
): Promise<Producer> {
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
    const scope = {
      client: producer.client,
      context,
      resolveGatewayContext: context.resolveGatewayContext,
      hasCurrentClientAuthority: producer.hasCurrentClientAuthority,
      isWebchatConnect: () => false,
    };
    const send = () =>
      dispatchGatewayRequestInProcess<{ runId: string }>(
        "chat.send",
        {
          sessionKey: c.sessionKey,
          message: c.queuedText,
          deliver: false,
          queueMode: "followup",
          idempotencyKey: c.id,
        },
        {
          client: producer.client,
          context,
          hasCurrentClientAuthority: producer.hasCurrentClientAuthority,
        },
      );
    const accepted = await withPluginRuntimeGatewayRequestScope(scope, async () => {
      if (kind !== "plugin-in-process") {
        return await send();
      }
      const continuation = await captureOperatorToolGatewayContinuationContext(
        { agentId: "main", sessionKey: c.sessionKey },
        { retainRequester: true },
      );
      assert(continuation?.operatorAuthority);
      try {
        // On the saved-only implementation this throws before input acceptance.
        // Dispatch consumes the freshly admitted requester scope, not the old source.
        return await continuation.runWithRequester(() =>
          dispatchGatewayMethodInProcess<{ runId: string }>("chat.send", {
            sessionKey: c.sessionKey,
            message: c.queuedText,
            deliver: false,
            queueMode: "followup",
            idempotencyKey: c.id,
          }),
        );
      } finally {
        continuation.release();
      }
    });
    c.queuedRunId = accepted.runId;
    await c.wait(c.enqueued.promise);
    assert(c.original?.controllerInput, "Real chat acceptance must own its queue receipt");
    if (scenario === "before-start") {
      await producer.revoke();
    }
    c.releaseFirst.resolve();
    if (producer.predecessor) {
      await c.wait(producer.predecessor.completion);
    }
    if (scenario === "before-start" && kind !== "http-bearer") {
      await expect(c.wait(c.original.controllerInput.settlement.promise)).rejects.toBeInstanceOf(
        GatewayOperatorRecoveryAuthorizationError,
      );
      const history = await admin.request<History>("chat.history", { sessionKey: c.sessionKey });
      const refused = history.pendingInputs.items.find((input) => input.runId === c.queuedRunId);
      expect(refused).toMatchObject({ state: "cancelled", endCause: "policy-refused" });
      expect(JSON.stringify(refused?.message)).toContain(c.queuedText);
      expect(c.queuedCalls).toBe(0);
    } else {
      await c.wait(c.recoveredReached.promise);
      assert(c.latestRunId);
      const running = c.latestRunId;
      if (scenario === "stop") {
        expect(await admin.request("chat.abort", { sessionKey: c.sessionKey })).toMatchObject({
          aborted: true,
        });
        expect(await c.wait(c.terminal(running).promise)).toBe("aborted");
        c.releaseRecovered.resolve();
      } else {
        await producer.revoke();
        c.releaseRecovered.resolve();
        expect(await c.wait(c.terminal(running).promise)).toBe("final");
      }
      const history = await admin.request<History>("chat.history", { sessionKey: c.sessionKey });
      if (scenario === "stop") {
        expect(JSON.stringify(history.messages)).not.toContain(c.answer);
      } else {
        expect(JSON.stringify(history.messages)).toContain(c.answer);
      }
      expect(c.queuedCalls).toBe(1);
    }
    expect(fixture.providerErrors).toEqual([]);
  } finally {
    await producer.release();
  }
}

async function runCronAdmissionCase(
  kind: "cron-standing-grant" | "cron-management-grant" | "cron-operator-source",
  scenario: Scenario,
  fixture: AdmissionFixture,
) {
  const c = fixture.current;
  assert(c && fixture.kernel);
  const context = fixture.kernel.gatewayRequestContext;
  const pending = await requestDevicePairing({
    deviceId: c.identity.deviceId,
    publicKey: publicKeyRawBase64UrlFromPem(c.identity.publicKeyPem),
    role: "operator",
    scopes: ["operator.admin"],
  });
  await approveDevicePairing(pending.request.requestId, { callerScopes: ["operator.admin"] });
  const auth = resolveGatewayAuthForConfig({ config: fixture.config });
  const operator = await fixture.connect(
    {
      token: auth.token,
      password: auth.password,
      deviceIdentity: c.identity,
      clientName: GATEWAY_CLIENT_NAMES.CONTROL_UI,
      mode: GATEWAY_CLIENT_MODES.WEBCHAT,
      origin: ORIGIN,
      scopes: ["operator.admin"],
    },
    c.signal,
  );
  const self = await operator.request<{ profile: { id: string } }>("users.self", {});
  c.profileId = self.profile.id;
  await replaceSessionEntry(c.target, {
    sessionId: c.target.sessionId,
    updatedAt: Date.now(),
    createdActor: { type: "human", source: "profile", id: c.profileId },
  });
  const admin = await fixture.admin(c.signal);
  const creatorSessionKey = `${c.sessionKey}:creator`;
  let creatorScope: CronCreatorAuthorityRunScope | undefined;
  let standingAuthority: CronStandingGrantAuthority | undefined;
  let job: CronStoredJob | undefined;
  const create = cronCreator.createCronCreatorAuthorityCapability;
  const creatorObserver = vi
    .spyOn(cronCreator, "createCronCreatorAuthorityCapability")
    .mockImplementation((...args) => {
      const capability = create(...args);
      if (capability?.managementEntitlement) {
        creatorScope = capability;
      }
      return capability;
    });
  const prepare = cronRun.prepareCronRunAdmission;
  const runObserver = vi.spyOn(cronRun, "prepareCronRunAdmission").mockImplementation((params) => {
    const admitted = prepare(params);
    if (params.jobId === job?.id) {
      standingAuthority = admitted.standingGrantAuthority;
    }
    return admitted;
  });
  try {
    const created = await operator.request<{ id: string }>("cron.add", {
      name: `live admission ${c.id}`,
      agentId: "main",
      enabled: false,
      schedule: { kind: "every", everyMs: 86_400_000 },
      sessionTarget: `session:${c.sessionKey}`,
      sessionKey: c.sessionKey,
      wakeMode: "now",
      payload: { kind: "agentTurn", message: c.queuedText },
      delivery: { mode: "none" },
    });
    job = await context.cron.readJob(created.id);
    assert(job, "cron.add must persist its actual job");
    if (kind === "cron-operator-source") {
      assert(job.operatorSource, "The real Control UI producer must retain its operator source");
    }
    let run: { runId: string };
    if (kind === "cron-management-grant") {
      const creator = await operator.request<{ runId: string }>("chat.send", {
        sessionKey: creatorSessionKey,
        message: "hold creator capability",
        deliver: false,
        idempotencyKey: randomUUID(),
      });
      await c.wait(c.firstReached.promise);
      assert(
        creatorScope?.managementEntitlement,
        "A real Control UI turn must issue its management capability",
      );
      expect(creatorScope.runId).toBe(creator.runId);
      const delegated = getAgentRunContext(creator.runId)?.delegatedAuthority;
      assert(delegated, "Management must use the creator's actual admitted execution");
      const grant = mintCronCreatorAuthorityGrant(creatorScope, undefined, undefined, {
        method: "cron.run",
        authority: delegated,
      });
      const identity = await createAgentRuntimeIdentity({
        agentId: "main",
        sessionKey: creatorSessionKey,
        operationalRunInstance: delegated.operationalRunInstance,
        approvalAuthority: delegated,
        cronManagementGrant: grant,
      });
      assert(identity);
      const client = mergePluginRuntimeClientInternal(
        createSyntheticPluginRuntimeClient({ scopes: [] }),
        { agentRuntimeIdentity: identity },
      );
      if (scenario === "before-start") {
        revokeCronCreatorAuthorityRunScope(creatorScope);
        await expect(
          dispatchGatewayRequestInProcess(
            "cron.run",
            { id: job.id, mode: "force" },
            { client, context },
          ),
        ).rejects.toThrow("missing scope:");
        expect((await context.cron.readJob(job.id))?.payload).toEqual(job.payload);
        expect(c.queuedCalls).toBe(0);
        return;
      }
      run = await dispatchGatewayRequestInProcess<{ runId: string }>(
        "cron.run",
        { id: job.id, mode: "force" },
        { client, context },
      );
    } else {
      if (scenario === "before-start" && kind === "cron-operator-source") {
        await removePairedDevice(c.identity.deviceId);
      }
      run = await admin.request<{ runId: string }>("cron.run", { id: job.id, mode: "force" });
    }
    const finished = context.cron.waitForManualRun(run.runId, 30_000, c.signal);
    if (scenario === "before-start" && kind === "cron-operator-source") {
      expect(await c.wait(finished)).toBe(true);
      const history = await admin.request<{
        entries: Array<{ status: string; error?: string; summary?: string }>;
      }>("cron.runs", { id: job.id, runId: run.runId, limit: 1 });
      expect(history.entries).toHaveLength(1);
      expect(history.entries[0]).toMatchObject({ status: "error" });
      expect(`${history.entries[0].error ?? ""} ${history.entries[0].summary ?? ""}`).toMatch(
        /operator|authority|revok|grant/i,
      );
      expect((await context.cron.readJob(job.id))?.payload).toEqual(job.payload);
      expect(c.queuedCalls).toBe(0);
      return;
    }
    await c.wait(
      awaitGateBeforeSettlement(
        c.recoveredReached.promise,
        finished,
        "Cron occurrence settled before reaching the provider",
      ),
    );
    assert(c.latestRunId);
    const running = c.latestRunId;
    if (kind === "cron-standing-grant") {
      assert(standingAuthority, "A real scheduled occurrence must own its receipt capability");
      const authority = standingAuthority;
      expect(() => authority.assertCurrent()).not.toThrow();
    }
    if (scenario === "stop") {
      expect(await admin.request("chat.abort", { sessionKey: c.sessionKey })).toMatchObject({
        aborted: true,
      });
      expect(await c.wait(c.terminal(running).promise)).toBe("aborted");
      c.releaseRecovered.resolve();
    } else if (scenario === "before-start") {
      // This is the receipt capability's next-use boundary, not operator
      // admission. Its in-flight guards remain in LIFETIME_CHECK_CALLS until
      // the later lifetime PR; removing a job must retire the receipt.
      await admin.request("cron.remove", { id: job.id });
      assert(standingAuthority);
      const authority = standingAuthority;
      expect(() => authority.assertCurrent()).toThrow();
      c.releaseRecovered.resolve();
    } else {
      if (kind === "cron-management-grant") {
        assert(creatorScope);
        revokeCronCreatorAuthorityRunScope(creatorScope);
      } else {
        await removePairedDevice(c.identity.deviceId);
      }
      c.releaseRecovered.resolve();
      expect(await c.wait(c.terminal(running).promise)).toBe("final");
    }
    expect(await c.wait(finished)).toBe(true);
    if (kind === "cron-standing-grant" && scenario === "stop") {
      assert(standingAuthority);
      const authority = standingAuthority;
      expect(() => authority.assertCurrent()).toThrow();
    }
    if (scenario !== "before-start") {
      const history = await admin.request<{ entries: Array<{ status: string }> }>("cron.runs", {
        id: job.id,
        runId: run.runId,
        limit: 1,
      });
      expect(history.entries).toHaveLength(1);
      if (scenario === "after-start") {
        expect(history.entries[0]).toMatchObject({ status: "ok" });
      }
    }
    expect(fixture.providerErrors).toEqual([]);
  } finally {
    c.releaseFirst.resolve();
    c.releaseRecovered.resolve();
    try {
      await admin.request("chat.abort", { sessionKey: creatorSessionKey });
    } finally {
      try {
        if (job) {
          await admin.request("cron.remove", { id: job.id });
        }
      } finally {
        creatorObserver.mockRestore();
        runObserver.mockRestore();
      }
    }
  }
}
