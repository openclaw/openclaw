import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { assert, expect } from "vitest";
import { awaitGateBeforeSettlement } from "../../test/helpers/promise.js";
import { TEST_TLS_CERT_PEM, TEST_TLS_KEY_PEM } from "../../test/helpers/tls-fixture.js";
import * as queueLifecycle from "../auto-reply/reply/queue/lifecycle.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { readSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import { readSessionQueuedInputPage } from "../config/sessions/session-pending-input-history.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { waitForGatewayActiveWork } from "../infra/gateway-active-work.js";
import { GatewayOperatorRecoveryAuthorizationError } from "../infra/restart-recovery-errors.js";
import type { GatewayIngressPrincipalBindingV1 } from "../plugins/gateway-ingress.types.js";
import { extractTextFromChatContent } from "../shared/chat-content.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { setCanonicalUserProfileRole } from "../state/user-profile-writes.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { GatewayClient } from "./client.js";
import { listenProvider } from "./gateway-provider-fixture.test-support.js";
import {
  setOpenClawIdMemberAccountLookup,
  setOpenClawIdTunnelPrincipalLookup,
  setOpenClawIdTunnelPrincipalResolver,
} from "./openclaw-id/tunnel-principal.js";
import {
  ADMIN,
  ADMIN_USER,
  ORIGIN,
  PROXY_USER,
  WRITER,
  type Mode,
  type Row,
  type Scenario,
} from "./operator-admission.contracts.test-support.js";
import {
  observeAdmissionFixture,
  prepareAdmissionOperator,
  prepareNativeSend,
  replayAdmissionInput,
  revokeAdmissionSource,
} from "./operator-admission.credentials.test-support.js";
import { runLiveAdmissionCase } from "./operator-admission.live.test-support.js";
import { AdmissionCase, AdmissionFixture } from "./operator-admission.table.test-support.js";
import { decodeQueuedOperatorRecoverySource } from "./operator-run-recovery-source.codec.js";
import { kernelGatewayTestStateOptions } from "./test-helpers.env.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

type History = {
  messages: unknown[];
  pendingInputs: {
    items: Array<{ runId: string; state: string; endCause?: string; message: unknown }>;
  };
};

export async function createFixture(mode: Mode): Promise<AdmissionFixture> {
  const state = await createOpenClawTestState(kernelGatewayTestStateOptions(`admission-${mode}`));
  if (mode === "trusted-proxy") {
    setTestEnvValue("OPENCLAW_GATEWAY_PASSWORD", randomUUID());
  }
  const provider = createServer();
  const model = buildMockOpenAiResponsesProvider(await listenProvider(provider), "admission-table");
  const certPath = await state.writeText("tls/cert.pem", TEST_TLS_CERT_PEM);
  const keyPath = await state.writeText("tls/key.pem", TEST_TLS_KEY_PEM);
  const config: OpenClawConfig = {
    agents: {
      defaults: {
        workspace: state.workspaceDir,
        skipBootstrap: true,
        utilityModel: "",
        model: { primary: model.modelRef },
        models: {
          [model.modelRef]: {
            agentRuntime: { id: "openclaw" },
            params: { transport: "sse", openaiWsWarmup: false },
          },
        },
      },
    },
    models: {
      mode: "replace",
      providers: {
        [model.providerId]: { ...model.config, request: { allowPrivateNetwork: true } },
      },
    },
    plugins: { enabled: false, slots: { memory: "none" } },
    tools: { deny: ["group:runtime"], codeMode: { enabled: false }, toolSearch: false },
    messages: { queue: { mode: "followup" } },
    gateway: {
      auth:
        mode === "trusted-proxy"
          ? {
              mode,
              trustedProxy: {
                userHeader: "x-forwarded-user",
                requiredHeaders: ["x-forwarded-proto"],
                allowUsers: [PROXY_USER, ADMIN_USER],
                allowLoopback: true,
                deviceAutoApprove: { enabled: true, scopes: WRITER },
              },
              identityScopes: { [PROXY_USER]: WRITER, [ADMIN_USER]: ADMIN },
            }
          : mode === "password"
            ? { mode, password: "admission-password" }
            : {
                mode,
                token: "admission-token",
                allowTailscale: true,
                identityScopes: { [PROXY_USER]: WRITER },
              },
      trustedProxies: ["127.0.0.1"],
      openclawId: { enabled: true },
      controlUi: { allowedOrigins: [ORIGIN] },
      tls: { enabled: true, autoGenerate: false, certPath, keyPath },
      reload: { mode: "hybrid" },
      roles: {
        default: "operator",
        definitions: {
          operator: {
            sessions: { others: "write" },
            agents: "*",
            scopes: ["operator.admin", ...WRITER],
          },
        },
      },
    },
  };
  const fixture = new AdmissionFixture(state, provider, config);
  provider.on("request", (request, response) => {
    void fixture.respond(request, response).catch((error: unknown) => {
      fixture.providerErrors.push(error);
      response.destroy(error instanceof Error ? error : undefined);
    });
  });
  observeAdmissionFixture(fixture);
  try {
    await fixture.start();
    return fixture;
  } catch (error) {
    await fixture.close();
    throw error;
  }
}
async function durableDrain(fixture: AdmissionFixture, c: AdmissionCase) {
  assert(c.original?.controllerInput);
  const recorder = c.original.userTurnTranscriptRecorder;
  assert(recorder?.relinquishPendingInput && recorder.waitForPendingInputSettlement);
  // Transfer custody through its real owners while the predecessor still holds the turn.
  // Relinquish finishes the old receipt without a terminal write; abandonment cannot
  // subsequently cancel it. Retiring the original source prevents a second execution.
  recorder.relinquishPendingInput();
  await recorder.waitForPendingInputSettlement();
  queueLifecycle.completeFollowupRunLifecycle(c.original);
  await c.wait(c.original.controllerInput.settlement.promise);
  expect(c.original.controllerInput.phase).toBe("consumed");
  const page = await readSessionQueuedInputPage(c.target);
  const stored = page.rows.find((row) => row.run_id === c.queuedRunId);
  assert(
    stored?.origin_source_json,
    "Real accepted input must retain its original recovery source",
  );
  expect(extractTextFromChatContent(JSON.parse(stored.message_json).content)).toBe(c.queuedText);
  if (
    [
      "legacy-fallback",
      "legacy-method-disabled",
      "legacy-rotated",
      "legacy-tailscale",
      "legacy-tailscale-narrowed",
    ].includes(c.scenario)
  ) {
    // Compatibility boundary: erase only the absent historical field from a real,
    // relinquished persisted row. Never substitute manufactured authority.
    const source = structuredClone(
      decodeQueuedOperatorRecoverySource(JSON.parse(stored.origin_source_json)),
    );
    assert(source.kind === "gateway" && source.snapshot.sourceIngress !== "principal");
    if (c.row.credential === "fallback") {
      expect(source.snapshot.authPolicy.authMethod).toBe("password");
      expect(source.snapshot.authPolicy.fallbackCredentialGeneration).toEqual(expect.any(String));
      delete source.snapshot.authPolicy.fallbackCredentialGeneration;
    } else {
      expect(source.snapshot.authPolicy.authMethod).toBe("tailscale");
      expect(source.snapshot.device).toBeDefined();
      delete source.snapshot.device;
    }
    const database = openOpenClawAgentDatabase({ agentId: "main", path: c.target.storePath });
    expect(
      database.db
        .prepare("UPDATE session_pending_inputs SET origin_source_json = ? WHERE input_id = ?")
        .run(JSON.stringify(source), stored.input_id).changes,
    ).toBe(1);
    const legacy = (await readSessionQueuedInputPage(c.target)).rows.find(
      (row) => row.input_id === stored.input_id,
    );
    assert(legacy?.origin_source_json);
    if (c.row.credential === "fallback") {
      expect(legacy.origin_source_json).not.toContain("fallbackCredentialGeneration");
    } else {
      expect(JSON.parse(legacy.origin_source_json).snapshot.device).toBeUndefined();
    }
  }
  if (
    (c.scenario === "before-start" && c.row.credential !== "principal") ||
    [
      "method-disabled",
      "legacy-method-disabled",
      "legacy-rotated",
      "fallback-proxy-policy",
      "legacy-tailscale-narrowed",
      "narrowed-grant",
      "narrowed-token",
      "narrowed-ingress",
      "device-token-revoked",
      "device-role-unapproved",
      "owner-disabled",
      "widened-grant",
      "narrowed-role",
      "empty-after-role",
      "owner-unavailable",
      "pairing-unavailable",
    ].includes(c.scenario)
  ) {
    await revokeAdmissionSource(fixture, c);
  }
  const deferred = await replayAdmissionInput(fixture, c, stored.origin_source_json);
  if (["owner-unavailable", "pairing-unavailable", "generation-unavailable"].includes(c.scenario)) {
    assert(deferred, "An unavailable owner must defer, not refuse or consume accepted work");
    const retained = (await readSessionQueuedInputPage(c.target)).rows.find(
      (row) => row.input_id === stored.input_id,
    );
    expect(retained).toMatchObject({
      state: "queued",
      origin_source_json: stored.origin_source_json,
      message_json: stored.message_json,
    });
    expect(c.queuedCalls).toBe(0);
    if (c.scenario === "owner-unavailable") {
      assert(c.claw);
      const authority = c.claw.authority;
      setOpenClawIdTunnelPrincipalLookup((key) => authority.currentPeer(key));
    }
    await c.wait(deferred.resume());
  } else {
    expect(deferred).toBeUndefined();
  }
  c.releaseFirst.resolve();
}

export async function runCase(
  fixture: AdmissionFixture,
  row: Row,
  scenario: Scenario,
  signal: AbortSignal,
  restartSentinel = false,
) {
  const c = new AdmissionCase(row, scenario, signal, fixture.state);
  const fallbackEnv = captureEnv(["OPENCLAW_GATEWAY_PASSWORD"]);
  fixture.current = c;
  try {
    if (row.ingress === "live") {
      assert(scenario === "before-start" || scenario === "after-start" || scenario === "stop");
      await runLiveAdmissionCase(row.credential, scenario, fixture);
      return;
    }
    let operator: Pick<GatewayClient, "request"> | GatewayIngressPrincipalBindingV1 | undefined;
    let nativeSend: (() => Promise<unknown>) | undefined;
    if (row.credential === "channel") {
      nativeSend = await prepareNativeSend(fixture, c);
    } else {
      operator = await prepareAdmissionOperator(fixture, c);
      c.profileId = (
        await operator.request<{ profile: { id: string } }>("users.self", {})
      ).profile.id;
    }
    assert(c.profileId);
    await replaceSessionEntry(c.target, {
      sessionId: c.target.sessionId,
      updatedAt: Date.now(),
      createdActor: { type: "human", source: "profile", id: c.profileId },
    });
    if (scenario === "goal-agent-excluded") {
      assert(operator && row.credential === "trusted-proxy");
      const allowed = structuredClone(fixture.config);
      assert(allowed.gateway?.roles?.definitions.operator);
      allowed.gateway.roles.definitions["goal-target"] = {
        ...allowed.gateway.roles.definitions.operator,
        agents: ["main"],
        scopes: [...WRITER],
      };
      await fixture.publish(allowed, c.signal);
      await setCanonicalUserProfileRole(c.profileId, "goal-target");
      const started = await operator.request<{ runId: string }>("chat.send", {
        sessionKey: c.sessionKey,
        sessionId: c.target.sessionId,
        message: c.queuedText,
        idempotencyKey: c.id,
        deliver: false,
        intent: { kind: "session-goal-start", version: 1, issuedAtMs: Date.now() },
      });
      await c.wait(
        awaitGateBeforeSettlement(
          c.recoveredReached.promise,
          c.terminal(started.runId).promise,
          "Goal start settled before reaching the provider",
        ),
      );
      expect((await readSessionEntryReadOnlyInWorker(c.target))?.goal).toMatchObject({
        status: "active",
        continuationTurns: 0,
      });
      const narrowed = structuredClone(fixture.config);
      assert(narrowed.gateway?.roles?.definitions["goal-target"]);
      narrowed.gateway.roles.definitions["goal-target"].agents = ["other"];
      await fixture.publish(narrowed, c.signal);
      c.releaseRecovered.resolve();
      expect(await c.wait(c.terminal(started.runId).promise)).toBe("final");
      const drained = await c.wait(waitForGatewayActiveWork(30_000));
      expect(drained.drained, JSON.stringify(drained.snapshot.blockers)).toBe(true);
      expect((await readSessionEntryReadOnlyInWorker(c.target))?.goal).toMatchObject({
        status: "paused",
        continuationTurns: 0,
        lastStatusNote: "Paused after an error. Resume to continue.",
      });
      expect(c.queuedCalls).toBe(1);
      expect(fixture.providerErrors).toEqual([]);
      return;
    }
    const admin = await fixture.admin(signal);
    const first = await admin.request<{ runId: string }>("chat.send", {
      sessionKey: c.sessionKey,
      message: "hold predecessor",
      deliver: false,
      idempotencyKey: randomUUID(),
    });
    await c.wait(
      awaitGateBeforeSettlement(
        c.firstReached.promise,
        c.terminal(first.runId).promise,
        "Predecessor settled before reaching the provider",
      ),
    );
    if (nativeSend) {
      await c.wait(nativeSend());
    } else {
      assert(operator);
      c.queuedRunId = (
        await operator.request<{ runId: string }>("chat.send", {
          sessionKey: c.sessionKey,
          message: c.queuedText,
          deliver: false,
          queueMode: "followup",
          idempotencyKey: c.id,
        })
      ).runId;
    }
    await c.wait(c.enqueued.promise);
    if (scenario === "live-ocid-grant") {
      const next = structuredClone(fixture.config);
      assert(next.gateway?.auth?.identityScopes);
      next.gateway.auth.identityScopes[`openclaw-id:${c.id}`] = ["operator.approvals"];
      await fixture.publish(next, c.signal);
    }
    if (restartSentinel) {
      assert(fixture.server);
      c.restarting = true;
      await fixture.server.close({ reason: "gateway restarting", restartExpectedMs: 1_500 });
      await fixture.closeClients();
      await fixture.claim?.release();
      assert(row.credential === "trusted-proxy" && scenario === "method-disabled");
      fixture.config = structuredClone(fixture.baseline);
      fixture.config.gateway!.auth = {
        ...fixture.config.gateway!.auth,
        mode: "token",
        token: "admission-restarted-token",
      };
      await fixture.start(false);
      await c.wait(c.drainEntered.promise);
      c.releaseDrain.resolve();
      await c.wait(c.drained.promise);
      assert(fixture.server);
      await fixture.server.startupSettled;
    } else if (row.credential === "channel" || scenario === "live-ocid-grant") {
      // Native rows lack durable sources; the OCID row deliberately exceeds codec limits.
      // Both use the ordinary in-memory lifecycle -> prepare/decide boundary.
      c.releaseFirst.resolve();
    } else {
      await durableDrain(fixture, c);
    }
    // Durable replay queues another source. Revoke at its final memory admission,
    // so a second preparation cannot mask removal of the synchronous credential check.
    if (scenario === "before-start" && ["principal", "channel"].includes(row.credential)) {
      await c.wait(c.prepared.promise);
      await revokeAdmissionSource(fixture, c);
      c.releasePrepared.resolve();
      await c.wait(c.finalAdmissionSettled.promise);
      if (row.credential === "principal") {
        expect(c.finalAdmissionError).toBeInstanceOf(GatewayOperatorRecoveryAuthorizationError);
      }
    }
    if (
      [
        "before-start",
        "method-disabled",
        "legacy-method-disabled",
        "legacy-rotated",
        "empty-after-role",
        "device-token-revoked",
        "device-role-unapproved",
        "owner-disabled",
      ].includes(scenario)
    ) {
      if (!restartSentinel) {
        await c.wait(c.terminal(first.runId).promise);
      }
      if (scenario === "legacy-method-disabled") {
        // The durable attempt settled before restoring fallback auth for the observer.
        fallbackEnv.restore();
      }
      const observer = await fixture.admin(signal);
      const history = await observer.request<History>("chat.history", {
        sessionKey: c.sessionKey,
      });
      const refused = history.pendingInputs.items.find((input) =>
        c.queuedRunId
          ? input.runId === c.queuedRunId
          : JSON.stringify(input.message).includes(c.queuedText),
      );
      expect(refused).toMatchObject({
        state: "cancelled",
        endCause: ["principal", "channel"].includes(row.credential) ? "policy-refused" : "revoked",
      });
      expect(JSON.stringify(refused?.message)).toContain(c.queuedText);
      expect(c.queuedCalls).toBe(0);
    } else {
      await c.wait(c.recoveredReached.promise);
      assert(c.latestRunId);
      if (scenario === "live-ocid-grant") {
        expect(c.observedRunScopes).not.toEqual([]);
        for (const scopes of c.observedRunScopes) {
          expect(scopes.toSorted()).toEqual([...WRITER, "operator.approvals"].toSorted());
        }
      }
      const running = c.latestRunId;
      if (scenario !== "stop") {
        if (scenario === "after-start") {
          await revokeAdmissionSource(fixture, c);
        }
        if (
          [
            "narrowed-grant",
            "widened-grant",
            "narrowed-role",
            "narrowed-token",
            "narrowed-ingress",
            "legacy-tailscale-narrowed",
          ].includes(scenario)
        ) {
          expect(c.observedRunScopes).not.toEqual([]);
          for (const scopes of c.observedRunScopes) {
            expect(scopes.toSorted()).toEqual([...WRITER].toSorted());
          }
        } else if (scenario === "legacy-tailscale") {
          expect(c.observedRunScopes).not.toEqual([]);
          for (const scopes of c.observedRunScopes) {
            expect(scopes.toSorted()).toEqual(
              [...WRITER, "operator.approvals", "operator.pairing"].toSorted(),
            );
          }
        }
        c.releaseRecovered.resolve();
        expect(await c.wait(c.terminal(running).promise)).toBe("final");
      } else {
        const observer = await fixture.admin(signal);
        expect(await observer.request("chat.abort", { sessionKey: c.sessionKey })).toMatchObject({
          aborted: true,
        });
        expect(await c.wait(c.terminal(running).promise)).toBe("aborted");
        c.releaseRecovered.resolve();
      }
      const observer = await fixture.admin(signal);
      const history = await observer.request<History>("chat.history", {
        sessionKey: c.sessionKey,
      });
      if (scenario !== "stop") {
        expect(JSON.stringify(history.messages)).toContain(c.answer);
      } else {
        expect(JSON.stringify(history.messages)).not.toContain(c.answer);
      }
      expect(c.queuedCalls).toBe(1);
    }
    expect(fixture.providerErrors).toEqual([]);
  } finally {
    fallbackEnv.restore();
    c.releaseFirst.resolve();
    c.releaseDrain.resolve();
    c.releasePrepared.resolve();
    c.releaseRecovered.resolve();
    try {
      const observer = await fixture.admin();
      await observer.request("chat.abort", { sessionKey: c.sessionKey });
    } finally {
      await fixture.closeClients();
      c.service.abort();
      setOpenClawIdTunnelPrincipalResolver(undefined);
      setOpenClawIdTunnelPrincipalLookup(undefined);
      setOpenClawIdMemberAccountLookup(undefined);
      if (
        c.profileId &&
        ["narrowed-role", "empty-after-role", "goal-agent-excluded"].includes(scenario)
      ) {
        await setCanonicalUserProfileRole(c.profileId, "operator");
      }
      if (!restartSentinel && JSON.stringify(fixture.config) !== JSON.stringify(fixture.baseline)) {
        await fixture.publish(structuredClone(fixture.baseline));
      }
      fixture.current = undefined;
    }
  }
}
