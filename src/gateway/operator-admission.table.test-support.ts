import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID, X509Certificate } from "node:crypto";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { assert, expect, vi } from "vitest";
import type { IrohEndpointKey } from "../../packages/openclaw-id-protocol/src/index.js";
import { acquireGatewayTestClient } from "../../test/helpers/gateway-client.js";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { TEST_TLS_CERT_PEM } from "../../test/helpers/tls-fixture.js";
import type { TurnGrant } from "../agents/admitted-run-operator-authority.types.js";
import type { FollowupRun } from "../auto-reply/reply/queue/types.js";
import { clearConfigCache, clearRuntimeConfigSnapshot, writeConfigFile } from "../config/config.js";
import {
  attachRuntimeConfigWriteApplication,
  createRuntimeConfigWriteApplication,
} from "../config/runtime-write-application.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadOrCreateDeviceIdentity, type DeviceIdentity } from "../infra/device-identity.js";
import type { GatewayIngressPrincipalBindingV1 } from "../plugins/gateway-ingress.types.js";
import type { Deferred } from "../shared/deferred.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import type { OpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { acquireTestPortBlock, type TestPortClaim } from "../test-utils/port-claims.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import type { GatewayClient, GatewayClientOptions } from "./client.js";
import { closeProvider } from "./gateway-provider-fixture.test-support.js";
import type { LinkedClaw } from "./openclaw-id/openclaw-id.test-support.js";
import {
  setOpenClawIdMemberAccountLookup,
  setOpenClawIdTunnelPrincipalLookup,
  setOpenClawIdTunnelPrincipalResolver,
} from "./openclaw-id/tunnel-principal.js";
import {
  ADMIN,
  ADMIN_USER,
  WRITER,
  proxyHeaders,
  type Row,
  type Scenario,
} from "./operator-admission.contracts.test-support.js";
import type { GatewayKernelRuntime } from "./server-kernel-request-runtime.js";
import * as kernelModule from "./server-kernel.js";
import type { GatewayServer } from "./server-public.js";
import { startGatewayServer } from "./server.js";
import { startClaimedGateway } from "./test-helpers.listener.js";

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
  readonly finalAdmissionSettled = createDeferred();
  readonly recoveredReached = createDeferred();
  readonly releaseRecovered = createDeferred();
  readonly providerCancelled = createDeferred();
  readonly consent = new AbortController();
  readonly service = new AbortController();
  readonly deliveries: unknown[] = [];
  readonly terminals = new Map<string, Deferred<string>>();
  readonly observedRunScopes: string[][] = [];
  readonly replayGrants: TurnGrant[] = [];
  readonly queuedOwners: boolean[] = [];
  ownerToolChecks = 0;
  ingressScopeCeiling = [...WRITER];
  readonly identity: DeviceIdentity;
  original?: FollowupRun;
  finalAdmissionError?: unknown;
  profileId?: string;
  latestRunId?: string;
  queuedRunId?: string;
  peerKey?: IrohEndpointKey;
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
    this.identity = loadOrCreateDeviceIdentity({
      path: state.path(this.id, "client", "credentials.sqlite"),
    });
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
    const create = vi.isMockFunction(kernelModule.createGatewayKernel)
      ? vi.mocked(kernelModule.createGatewayKernel).getMockImplementation()
      : kernelModule.createGatewayKernel;
    assert(create);
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
      response.once("close", () => {
        if (!response.writableEnded) {
          c.providerCancelled.resolve();
        }
      });
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
    await writeConfigFile(
      next,
      attachRuntimeConfigWriteApplication({ allowConfigSizeDrop: true }, application),
    );
    expect(await (signal ? withinTest(application.result, signal) : application.result)).toBe(
      "applied",
    );
    this.config = next;
    const c = this.current;
    if (c?.claw && next.gateway?.openclawId?.enabled !== false) {
      // Reload republishes daemon I/O; this fixture's signed claw remains that owner.
      const authority = c.claw.authority;
      setOpenClawIdTunnelPrincipalResolver((key) => authority.resolvePeer(key));
      setOpenClawIdTunnelPrincipalLookup((key) => authority.currentPeer(key));
      setOpenClawIdMemberAccountLookup((id) => id === c.id);
    }
  }
  async setSessionOwner(profileId: string) {
    const c = this.current;
    assert(c);
    c.profileId = profileId;
    await replaceSessionEntry(c.target, {
      sessionId: c.target.sessionId,
      updatedAt: Date.now(),
      createdActor: { type: "human", source: "profile", id: profileId },
    });
  }
  async finishQueuedRun(revoke: () => Promise<void>) {
    const c = this.current;
    assert(c?.latestRunId);
    const running = c.latestRunId;
    const admin = await this.admin(c.signal);
    if (c.scenario === "stop") {
      const stopped =
        c.row.credential === "channel"
          ? await admin.request("sessions.abort", { key: c.sessionKey })
          : await admin.request("chat.abort", { sessionKey: c.sessionKey });
      // sessions.abort reports session status; chat.abort reports a run cancellation.
      expect(stopped).toMatchObject(
        c.row.credential === "channel" ? { ok: true, status: "aborted" } : { aborted: true },
      );
      if (c.row.credential === "channel") {
        const claim = c.original?.controllerInput?.claim;
        assert(claim);
        // Stop must cancel the real provider while its response is still held.
        await c.wait(c.providerCancelled.promise);
        c.releaseRecovered.resolve();
        await c.wait(claim.settlement.promise);
      } else {
        c.releaseRecovered.resolve();
        expect(await c.wait(c.terminal(running).promise)).toBe("aborted");
      }
    } else {
      if (c.scenario === "after-start") {
        await revoke();
      }
      c.releaseRecovered.resolve();
      expect(await c.wait(c.terminal(running).promise)).toBe("final");
    }
    const observer = await this.admin(c.signal);
    const history = await observer.request<{ messages: unknown[] }>("chat.history", {
      sessionKey: c.sessionKey,
    });
    if (c.scenario === "stop") {
      expect(JSON.stringify(history.messages)).not.toContain(c.answer);
    } else {
      expect(JSON.stringify(history.messages)).toContain(c.answer);
    }
    expect(c.queuedCalls).toBe(1);
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
