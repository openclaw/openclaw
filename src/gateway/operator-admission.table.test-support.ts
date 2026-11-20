import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID, X509Certificate } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { assert, expect, vi } from "vitest";
import { acquireGatewayTestClient } from "../../test/helpers/gateway-client.js";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { TEST_TLS_CERT_PEM, TEST_TLS_KEY_PEM } from "../../test/helpers/tls-fixture.js";
import * as queueLifecycle from "../auto-reply/reply/queue/lifecycle.js";
import type { FollowupRun } from "../auto-reply/reply/queue/types.js";
import { clearConfigCache, clearRuntimeConfigSnapshot, writeConfigFile } from "../config/config.js";
import {
  attachRuntimeConfigWriteApplication,
  createRuntimeConfigWriteApplication,
} from "../config/runtime-write-application.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { readSessionQueuedInputPage } from "../config/sessions/session-pending-input-history.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadOrCreateDeviceIdentity, type DeviceIdentity } from "../infra/device-identity.js";
import { GatewayOperatorRecoveryAuthorizationError } from "../infra/restart-recovery-errors.js";
import type { GatewayIngressPrincipalBindingV1 } from "../plugins/gateway-ingress.types.js";
import { extractTextFromChatContent } from "../shared/chat-content.js";
import type { Deferred } from "../shared/deferred.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { setCanonicalUserProfileRole } from "../state/user-profile-writes.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { acquireTestPortBlock, type TestPortClaim } from "../test-utils/port-claims.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import type { GatewayClient, GatewayClientOptions } from "./client.js";
import { closeProvider, listenProvider } from "./gateway-provider-fixture.test-support.js";
import type { LinkedClaw } from "./openclaw-id/openclaw-id.test-support.js";
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
  replayAdmissionInput,
  proxyHeaders,
  observeAdmissionFixture,
  prepareAdmissionOperator,
  prepareNativeSend,
  revokeAdmissionSource,
} from "./operator-admission.credentials.test-support.js";
import {
  runLiveAdmissionCase,
  type LiveAdmissionKind,
} from "./operator-admission.live.test-support.js";
import {
  decodeQueuedOperatorRecoverySource,
  type OperatorRunRecoverySnapshot,
} from "./operator-run-recovery-source.codec.js";
import type { GatewayKernelRuntime } from "./server-kernel-request-runtime.js";
import * as kernelModule from "./server-kernel.js";
import type { GatewayServer } from "./server-public.js";
import { startGatewayServer } from "./server.js";
import { kernelGatewayTestStateOptions } from "./test-helpers.env.js";
import { startClaimedGateway } from "./test-helpers.listener.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

type AuthMethod = Exclude<
  OperatorRunRecoverySnapshot,
  { sourceIngress: "principal" }
>["authPolicy"]["authMethod"];
type Credential =
  | AuthMethod
  | "fallback"
  | "proxy-device"
  | "tailscale-device"
  | "ocid-owner"
  | "ocid-member"
  | "principal"
  | "channel";
type SavedRow = {
  credential: Credential;
  ingress: OperatorRunRecoverySnapshot["sourceIngress"] | "channel";
};
export type Row = SavedRow | { credential: LiveAdmissionKind; ingress: "live" };
type History = {
  messages: unknown[];
  pendingInputs: {
    items: Array<{ runId: string; state: string; endCause?: string; message: unknown }>;
  };
};
export type Mode = "token" | "password" | "trusted-proxy";
type Scenario =
  | "before-start"
  | "after-start"
  | "stop"
  | "method-disabled"
  | "legacy-method-disabled"
  | "legacy-fallback"
  | "legacy-rotated"
  | "fallback-proxy-policy"
  | "legacy-tailscale"
  | "legacy-tailscale-narrowed"
  | "narrowed-grant"
  | "narrowed-token"
  | "narrowed-ingress"
  | "device-token-revoked"
  | "device-role-unapproved"
  | "generation-unavailable"
  | "owner-disabled"
  | "widened-grant"
  | "narrowed-role"
  | "empty-after-role"
  | "pairing-unavailable"
  | "owner-unavailable";
export class AdmissionCase {
  readonly id = randomUUID();
  readonly sessionKey = `agent:main:admission-${this.id}`;
  readonly queuedText = `accepted input ${this.id}`;
  readonly answer = `completed input ${this.id}`;
  readonly target = {
    agentId: "main",
    sessionKey: this.sessionKey,
    sessionId: randomUUID(),
    storePath: resolveOpenClawAgentSqlitePath({ agentId: "main" }),
  };
  readonly firstReached = createDeferred();
  readonly releaseFirst = createDeferred();
  readonly enqueued = createDeferred();
  readonly drainEntered = createDeferred();
  readonly releaseDrain = createDeferred();
  readonly drained = createDeferred();
  readonly prepared = createDeferred();
  readonly releasePrepared = createDeferred();
  readonly finalAdmissionSettled = createDeferred();
  readonly recoveredReached = createDeferred();
  readonly releaseRecovered = createDeferred();
  readonly consent = new AbortController();
  readonly service = new AbortController();
  readonly deliveries: unknown[] = [];
  readonly terminals = new Map<string, Deferred<string>>();
  readonly observedRunScopes: string[][] = [];
  ingressScopeCeiling = [...WRITER];
  readonly identity: DeviceIdentity;
  original?: FollowupRun;
  finalAdmissionError?: unknown;
  profileId?: string;
  latestRunId?: string;
  queuedRunId?: string;
  peerKey?: string;
  claw?: LinkedClaw;
  consentCurrent = true;
  preparedHeld = false;
  restarting = false;
  queuedCalls = 0;

  constructor(
    readonly row: Row,
    readonly scenario: Scenario,
    readonly signal: AbortSignal,
    state: OpenClawTestState,
  ) {
    this.identity = loadOrCreateDeviceIdentity({ path: state.path(this.id, "credentials.sqlite") });
  }
  terminal(runId: string) {
    let result = this.terminals.get(runId);
    if (!result) {
      result = createDeferred<string>();
      this.terminals.set(runId, result);
    }
    return result;
  }
  wait<T>(promise: PromiseLike<T>) {
    return withinTest(promise, this.signal);
  }
}

export class AdmissionFixture {
  kernel?: GatewayKernelRuntime;
  server?: GatewayServer;
  claim?: TestPortClaim;
  current?: AdmissionCase;
  readonly clients: GatewayClient[] = [];
  readonly bindings: GatewayIngressPrincipalBindingV1[] = [];
  readonly restores: Array<() => void> = [];
  readonly providerErrors: unknown[] = [];
  readonly preparingFollowup = new AsyncLocalStorage<FollowupRun>();
  config: OpenClawConfig;

  constructor(
    readonly state: OpenClawTestState,
    readonly provider: Server,
    readonly baseline: OpenClawConfig,
  ) {
    this.config = structuredClone(baseline);
  }

  async start(waitReady = true) {
    await this.state.writeConfig(this.config);
    clearRuntimeConfigSnapshot();
    clearConfigCache();
    const create = kernelModule.createGatewayKernel;
    const capture = vi
      .spyOn(kernelModule, "createGatewayKernel")
      .mockImplementation(async (...args) => {
        const kernel = await create(...args);
        this.kernel = kernel;
        return kernel;
      });
    this.claim = await acquireTestPortBlock({ offsets: [0, 1, 2, 3, 4] });
    try {
      process.env.OPENCLAW_CONFIG_PATH = this.state.configPath;
      const port = this.claim.port;
      this.server = await startClaimedGateway(this.claim, () =>
        startGatewayServer(port, { bind: "loopback", controlUiEnabled: false }),
      );
    } finally {
      capture.mockRestore();
    }
    assert(this.kernel && this.server);
    if (waitReady) {
      await this.server.startupSettled;
    }
  }

  async respond(request: IncomingMessage, response: ServerResponse) {
    let body = "";
    for await (const chunk of request) {
      body += String(chunk);
    }
    const c = this.current;
    assert(c, "Unexpected background provider work");
    const queued = body.includes(c.queuedText);
    if (queued) {
      c.queuedCalls++;
      c.recoveredReached.resolve();
      await c.releaseRecovered.promise;
    } else if (!c.restarting) {
      c.firstReached.resolve();
      await c.releaseFirst.promise;
    }
    if (!response.destroyed) {
      writeOpenAiResponsesText(response, {
        text: queued ? c.answer : "predecessor completed",
        messageId: randomUUID(),
        responseId: randomUUID(),
      });
    }
  }

  async connect(options: Omit<GatewayClientOptions, "url">, signal?: AbortSignal) {
    assert(this.claim);
    const client = await acquireGatewayTestClient(
      {
        url: `wss://127.0.0.1:${this.claim.port}`,
        tlsFingerprint: new X509Certificate(TEST_TLS_CERT_PEM).fingerprint256,
        clientName: GATEWAY_CLIENT_NAMES.TEST,
        mode: GATEWAY_CLIENT_MODES.TEST,
        scopes: ADMIN,
        ...options,
      },
      {
        timeoutMs: 15_000,
        timeoutMessage: "Admission handshake timed out",
        closeMessage: "Admission handshake closed",
        signal,
      },
    );
    this.clients.push(client);
    return client;
  }
  async admin(signal?: AbortSignal) {
    const auth = this.config.gateway!.auth!;
    return await this.connect(
      auth.mode === "trusted-proxy"
        ? { edgeAuthHeaders: proxyHeaders(ADMIN_USER), deviceIdentity: null }
        : auth.mode === "password"
          ? { password: typeof auth.password === "string" ? auth.password : undefined }
          : { token: typeof auth.token === "string" ? auth.token : undefined },
      signal,
    );
  }
  async publish(next: OpenClawConfig, signal?: AbortSignal) {
    const application = createRuntimeConfigWriteApplication();
    await writeConfigFile(next, attachRuntimeConfigWriteApplication({}, application));
    expect(await (signal ? withinTest(application.result, signal) : application.result)).toBe(
      "applied",
    );
    this.config = next;
  }

  async durableDrain(c: AdmissionCase) {
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
      await revokeAdmissionSource(this, c);
    }
    const deferred = await replayAdmissionInput(this, c, stored.origin_source_json);
    if (
      ["owner-unavailable", "pairing-unavailable", "generation-unavailable"].includes(c.scenario)
    ) {
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

  async run(row: Row, scenario: Scenario, signal: AbortSignal, restartSentinel = false) {
    const c = new AdmissionCase(row, scenario, signal, this.state);
    const fallbackEnv = captureEnv(["OPENCLAW_GATEWAY_PASSWORD"]);
    this.current = c;
    try {
      if (row.ingress === "live") {
        assert(scenario === "before-start" || scenario === "after-start" || scenario === "stop");
        await runLiveAdmissionCase(row.credential, scenario, this);
        return;
      }
      let operator: Pick<GatewayClient, "request"> | GatewayIngressPrincipalBindingV1 | undefined;
      let nativeSend: (() => Promise<unknown>) | undefined;
      if (row.credential === "channel") {
        nativeSend = await prepareNativeSend(this, c);
      } else {
        operator = await prepareAdmissionOperator(this, c);
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
      const admin = await this.admin(signal);
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
      if (restartSentinel) {
        assert(this.server);
        c.restarting = true;
        await this.server.close({ reason: "gateway restarting", restartExpectedMs: 1_500 });
        await this.closeClients();
        await this.claim?.release();
        assert(row.credential === "trusted-proxy" && scenario === "method-disabled");
        this.config = structuredClone(this.baseline);
        this.config.gateway!.auth = {
          ...this.config.gateway!.auth,
          mode: "token",
          token: "admission-restarted-token",
        };
        await this.start(false);
        await c.wait(c.drainEntered.promise);
        c.releaseDrain.resolve();
        await c.wait(c.drained.promise);
        assert(this.server);
        await this.server.startupSettled;
      } else if (row.credential === "channel") {
        // Native durable rows deliberately lack recovery sources today. Exercise the
        // real in-memory lifecycle -> restore -> prepare/decide boundary instead.
        c.releaseFirst.resolve();
      } else {
        await this.durableDrain(c);
      }
      // Durable replay queues another source. Revoke at its final memory admission,
      // so a second preparation cannot mask removal of the synchronous credential check.
      if (scenario === "before-start" && ["principal", "channel"].includes(row.credential)) {
        await c.wait(c.prepared.promise);
        await revokeAdmissionSource(this, c);
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
        const observer = await this.admin(signal);
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
          endCause: ["principal", "channel"].includes(row.credential)
            ? "policy-refused"
            : "revoked",
        });
        expect(JSON.stringify(refused?.message)).toContain(c.queuedText);
        expect(c.queuedCalls).toBe(0);
      } else {
        await c.wait(c.recoveredReached.promise);
        assert(c.latestRunId);
        const running = c.latestRunId;
        if (scenario !== "stop") {
          if (scenario === "after-start") {
            await revokeAdmissionSource(this, c);
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
          const observer = await this.admin(signal);
          expect(await observer.request("chat.abort", { sessionKey: c.sessionKey })).toMatchObject({
            aborted: true,
          });
          expect(await c.wait(c.terminal(running).promise)).toBe("aborted");
          c.releaseRecovered.resolve();
        }
        const observer = await this.admin(signal);
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
      expect(this.providerErrors).toEqual([]);
    } finally {
      fallbackEnv.restore();
      c.releaseFirst.resolve();
      c.releaseDrain.resolve();
      c.releasePrepared.resolve();
      c.releaseRecovered.resolve();
      try {
        const observer = await this.admin();
        await observer.request("chat.abort", { sessionKey: c.sessionKey });
      } finally {
        await this.closeClients();
        c.service.abort();
        setOpenClawIdTunnelPrincipalResolver(undefined);
        setOpenClawIdTunnelPrincipalLookup(undefined);
        setOpenClawIdMemberAccountLookup(undefined);
        if (c.profileId && ["narrowed-role", "empty-after-role"].includes(scenario)) {
          await setCanonicalUserProfileRole(c.profileId, "operator");
        }
        if (!restartSentinel && JSON.stringify(this.config) !== JSON.stringify(this.baseline)) {
          await this.publish(structuredClone(this.baseline));
        }
        this.current = undefined;
      }
    }
  }

  async closeClients() {
    await Promise.all(this.clients.splice(0).map((client) => client.stopAndWait()));
    await Promise.all(this.bindings.splice(0).map((binding) => binding.close()));
  }
  async close() {
    try {
      await this.closeClients();
      await this.server?.close({ reason: "admission pool complete" });
    } finally {
      await this.claim?.release();
      await closeProvider(this.provider);
      for (const restore of this.restores) {
        restore();
      }
      await this.state.cleanup();
    }
  }
}

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
    messages: { queue: { mode: "followup", debounceMs: 0 } },
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
      reload: { mode: "hot", debounceMs: 0 },
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
