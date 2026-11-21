import { randomUUID } from "node:crypto";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { assert, expect, vi } from "vitest";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import type { AdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import { executeSqliteQuerySync } from "../infra/kysely-sync.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { runWithGatewayIndependentRootWorkAdmission } from "../process/gateway-work-admission.js";
import { publishUserProfileAuthorityChange } from "../state/user-profile-events.js";
import { publishUserProfilesChange } from "../state/user-profile-list.js";
import { runUserProfileWriteTransaction } from "../state/user-profile-mutation.js";
import { ensureCanonicalUserProfileForOpenClawIdIdentity } from "../state/user-profile-openclaw-id.js";
import {
  ensureCanonicalUserProfileForEmail,
  linkCanonicalUserProfileEmail,
  setCanonicalUserProfileRole,
} from "../state/user-profile-writes.js";
import { userProfilesDb } from "../state/user-profiles-internal.js";
import { resolveGatewayAuthForConfig } from "./auth-resolve.js";
import {
  checkGatewayHttpRequestAuth,
  resolveSharedSecretHttpOperatorScopes,
} from "./http-auth-utils.js";
import { markGatewayIngressTransport } from "./ingress-attribution.js";
import { runOpenAiCompatibleAgentCommand } from "./openai-compatible-agent-run.js";
import {
  PROXY_USER,
  WRITER,
  type LiveAdmissionKind,
  type LiveAdmissionProducer,
} from "./operator-admission.contracts.test-support.js";
import {
  prepareAdmissionOcidPeer,
  prepareAdmissionOperator,
} from "./operator-admission.credentials.test-support.js";
import { runCronAdmissionCase } from "./operator-admission.cron.test-support.js";
import {
  isLiveCredentialKind,
  prepareLiveCredentialProducer,
} from "./operator-admission.live-credentials.test-support.js";
import { prepareRemoteIngressProducer } from "./operator-admission.remote.test-support.js";
import type { AdmissionFixture } from "./operator-admission.table.test-support.js";
import * as operatorRun from "./operator-run-authority.js";
import { captureQueuedOperatorRecoverySource } from "./operator-run-recovery-source.js";
import { dispatchGatewayRequestInProcess } from "./server-in-process-dispatch.js";
import {
  captureOperatorToolGatewayContinuationContext,
  dispatchGatewayMethodInProcess,
} from "./server-plugin-in-process-dispatch.js";
import { createSyntheticPluginRuntimeClient } from "./server-plugin-runtime-client.js";
import { prepareSessionPrincipalRunAuthority } from "./session-sharing-authorization-async.js";
import { prepareSessionSystemTurnAuthority } from "./session-system-turn-authority.js";

type Scenario =
  | "before-start"
  | "after-start"
  | "stop"
  | "secondary-email-removed"
  | "profile-deleted";
type History = {
  messages: unknown[];
  pendingInputs: {
    items: Array<{ runId: string; state: string; message: unknown }>;
  };
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
  if (kind === "live-ingress") {
    // Share the actual host binding builder; live rows deliberately register no recovery.
    const binding = await prepareAdmissionOperator(fixture, c, {
      credential: "principal",
      scopes: WRITER,
    });
    assert("close" in binding);
    const self = await binding.request<{ profile: { id: string } }>("users.self", {});
    await fixture.setSessionOwner(self.profile.id);
    return {
      send: (params) => binding.request("chat.send", params),
      revoke: async () => {
        c.consent.abort();
      },
      release: () => binding.close(),
    };
  }
  const profile =
    kind === "http-ocid" || kind === "openai-compatible"
      ? await ensureCanonicalUserProfileForOpenClawIdIdentity({ accountId: c.id })
      : await ensureCanonicalUserProfileForEmail(`live-${c.id}@example.test`);
  const next = structuredClone(fixture.config);
  assert(next.gateway?.roles);
  next.gateway.roles.definitions["live-refused"] = {
    scopes: [],
    agents: [],
    sessions: { others: "none" },
  };
  await fixture.publish(next, c.signal);
  await setCanonicalUserProfileRole(profile.id, "operator");
  await fixture.setSessionOwner(profile.id);
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
      const peerKey = await prepareAdmissionOcidPeer(c);
      markGatewayIngressTransport(req, {
        kind: "openclaw-id-tunnel",
        peerKey,
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
              authenticatedUserProfile: requestAuth.authenticatedUserProfile,
              operatorRoleActor: requestAuth.operatorRoleActor,
              openclawIdPrincipal: requestAuth.openclawIdPrincipal,
              operatorAccessAuthority: requestAuth.operatorAccessAuthority,
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
              authenticatedUserProfile: requestAuth.authenticatedUserProfile,
              operatorRoleActor: requestAuth.operatorRoleActor,
              openclawIdPrincipal: requestAuth.openclawIdPrincipal,
              operatorAccessAuthority: requestAuth.operatorAccessAuthority,
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
      operatorRoleActor: { kind: "operator", profileId: prepared.authority.profileId },
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
    assert(scenario !== "secondary-email-removed" && scenario !== "profile-deleted");
    return await runCronAdmissionCase(kind, scenario, fixture);
  }
  const secondaryEmail = `secondary-${c.id}@example.test`;
  if (scenario === "secondary-email-removed") {
    const profile = await ensureCanonicalUserProfileForEmail(PROXY_USER);
    await linkCanonicalUserProfileEmail(secondaryEmail, profile.id);
  }
  const producer = await prepareLiveProducer(kind, fixture);
  const credentialKind = isLiveCredentialKind(kind);
  const liveCredential =
    credentialKind || kind === "live-ingress" || kind === "live-remote-ingress";
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
    const original = c.original;
    assert(original?.controllerInput, "Real chat acceptance must own its queue receipt");
    const controllerInput = original.controllerInput;
    if (liveCredential) {
      const authority = original.operatorAuthority;
      assert(authority, "The real transport must queue its actual operator authority");
      expect(authority.signal?.aborted).not.toBe(true);
      expect(captureQueuedOperatorRecoverySource(authority)).toEqual({
        kind: "unavailable",
        reason: credentialKind ? "decode-failed" : "remote-ingress-no-source",
      });
    }
    if (scenario === "secondary-email-removed") {
      const other = await ensureCanonicalUserProfileForEmail(`other-${c.id}@example.test`);
      await linkCanonicalUserProfileEmail(secondaryEmail, other.id);
    }
    if (scenario === "profile-deleted") {
      const profileId = original.operatorAuthority?.canonicalIdentity?.profileId;
      assert(profileId, "The queued live source must retain its real canonical profile");
      runUserProfileWriteTransaction(({ db }) => {
        expect(
          executeSqliteQuerySync(
            db,
            userProfilesDb(db)
              .deleteFrom("user_profiles")
              .where("id", "=", profileId)
              .returning("id"),
          ).rows,
        ).toEqual([{ id: profileId }]);
        publishUserProfileAuthorityChange(db, profileId);
        publishUserProfilesChange(db, profileId);
      }, {});
    }
    if (scenario === "before-start") {
      await producer.revoke();
    }
    c.releaseFirst.resolve();
    if (producer.predecessor) {
      await c.wait(producer.predecessor.completion);
    }
    if (
      scenario === "profile-deleted" ||
      (scenario === "before-start" &&
        !["http-bearer", "live-grant", "live-role", "live-remote-ingress"].includes(kind))
    ) {
      // Physical custody can settle normally even when the next start is refused.
      await c.wait(controllerInput.settlement.promise.catch(() => undefined));
      const observer = await fixture.admin(c.signal);
      const history = await observer.request<History>("chat.history", { sessionKey: c.sessionKey });
      const refused = history.pendingInputs.items.find((input) => input.runId === c.queuedRunId);
      // Admission promises retained cancellation, not a particular failure categorization.
      expect(refused).toMatchObject({ state: "cancelled" });
      expect(JSON.stringify(refused?.message)).toContain(c.queuedText);
      expect(c.queuedCalls).toBe(0);
    } else {
      await c.wait(c.recoveredReached.promise);
      if (kind === "live-grant" || kind === "live-role") {
        expect(c.observedRunScopes.length).toBeGreaterThan(0);
        for (const scopes of c.observedRunScopes) {
          expect(scopes.toSorted()).toEqual(
            (scenario === "before-start" ? WRITER : [...WRITER, "operator.approvals"]).toSorted(),
          );
        }
      }
      await fixture.finishQueuedRun(producer.revoke);
    }
    expect(fixture.providerErrors).toEqual([]);
  } finally {
    await producer.release();
  }
}
