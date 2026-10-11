// Scenario-owned proof for composed preview App SDK Gateway contracts.
import fs from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import {
  AgentParamsSchema,
  ArtifactsListParamsSchema,
  EnvironmentsCreateParamsSchema,
  EnvironmentsCreateResultSchema,
  EnvironmentsListResultSchema,
  EnvironmentsStatusResultSchema,
} from "../../packages/gateway-protocol/src/index.js";
import { AgentWaitParamsSchema } from "../../packages/gateway-protocol/src/schema/agent.js";
import {
  ArtifactsDownloadResultSchema,
  ArtifactsGetResultSchema,
  ArtifactsListResultSchema,
} from "../../packages/gateway-protocol/src/schema/artifacts.js";
import {
  GatewayClientTransport,
  OpenClaw,
  type OpenClawEvent,
} from "../../packages/sdk/src/index.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.entry.js";
import { CURRENT_SESSION_VERSION } from "../config/sessions/version.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { registerAgentRunContext } from "../infra/agent-run-registry.js";
import { withTimeout } from "../utils/with-timeout.js";
import { environmentsHandlers } from "./server-methods/environments.js";
import type { GatewayRequestHandlerOptions, RespondFn } from "./server-methods/types.js";
import * as lifecycleState from "./session-lifecycle-state.js";
import { createPreparedLifecycleWriteTracker } from "./session-lifecycle-state.test-support.js";
import {
  installGatewayTestHooks,
  startServer,
  testState,
  writeSessionStore,
} from "./test-helpers.js";
import type {
  WorkerEnvironmentServiceContract,
  WorkerEnvironmentServiceRecord,
} from "./worker-environments/service-contract.js";

vi.mock("../infra/device-pairing.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/device-pairing.js")>();
  return {
    ...actual,
    listDevicePairing: vi.fn(async () => ({ pending: [], paired: [] })),
    resolveNodePairingState: vi.fn(),
  };
});

vi.mock("../infra/device-pairing-node.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/device-pairing-node.js")>();
  return {
    ...actual,
    listNodePairing: vi.fn(async () => ({ pending: [], paired: [] })),
  };
});

type JsonObject = Record<string, unknown>;
type FakeGatewayRequest = {
  id: string;
  method: string;
  params?: unknown;
};
type FakeGateway = {
  url: string;
  close: () => Promise<void>;
};

const fakeServers: WebSocketServer[] = [];

function sendJson(socket: WebSocket, payload: JsonObject): void {
  socket.send(JSON.stringify(payload));
}

function requireJsonObject(value: unknown, label: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as JsonObject;
}

function assertSchema(schema: TSchema, value: unknown, label: string): void {
  if (!Value.Check(schema, value)) {
    throw new Error(`${label} failed Gateway schema validation`);
  }
}

async function closeFakeServer(server: WebSocketServer): Promise<void> {
  for (const socket of server.clients) {
    socket.terminate();
  }
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

function workerRecord(): WorkerEnvironmentServiceRecord {
  return {
    environmentId: "worker-sdk-e2e",
    providerId: "testbox",
    profileId: "development",
    leaseId: "lease-sdk-e2e",
    sharedHost: null,
    state: "requested",
    ownerEpoch: 1,
    createdAtMs: 1_000,
    idleSinceAtMs: null,
    destroyRequestedAtMs: null,
    attachedSessionIds: ["session-sdk-e2e"],
    desktopAvailable: false,
    desktopApps: [],
    tunnelStatus: "stopped",
  };
}

async function createFakeGateway(): Promise<FakeGateway> {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  fakeServers.push(server);
  await new Promise<void>((resolve) => {
    server.once("listening", resolve);
  });
  let seq = 1;
  const environmentContext = {
    workerEnvironmentService: {
      create: async () => workerRecord(),
    } satisfies Pick<WorkerEnvironmentServiceContract, "create">,
  } as unknown as GatewayRequestHandlerOptions["context"];

  server.on("connection", (socket) => {
    socket.binaryType = "nodebuffer";
    sendJson(socket, {
      type: "event",
      event: "connect.challenge",
      seq: seq++,
      payload: { nonce: "sdk-a2-nonce", ts: 1_000 },
    });

    socket.on("message", (raw) => {
      void (async () => {
        const frame = JSON.parse(rawDataToString(raw)) as FakeGatewayRequest;
        const reply = (payload: unknown): void => {
          sendJson(socket, { type: "res", id: frame.id, ok: true, payload });
        };

        if (frame.method === "connect") {
          reply({
            type: "hello-ok",
            protocol: 1,
            server: { version: "sdk-a2", connId: "conn-sdk-a2" },
            features: {
              methods: ["agent", "agent.wait", "artifacts.list", "connect", "environments.create"],
              events: ["agent"],
            },
            snapshot: {
              presence: [],
              health: {},
              stateVersion: { presence: 0, health: 0 },
              uptimeMs: 1,
            },
            auth: { role: "operator", scopes: [] },
            policy: {
              maxPayload: 262144,
              maxBufferedBytes: 262144,
              tickIntervalMs: 30000,
            },
          });
          return;
        }

        if (frame.method === "agent") {
          const params = frame.params ?? {};
          assertSchema(AgentParamsSchema, params, "agent params");
          reply({
            status: "accepted",
            runId: "run-sdk-e2e",
            sessionKey: "main",
          });
          setTimeout(() => {
            const payloads = [
              {
                stream: "lifecycle",
                ts: 1_001,
                data: { phase: "start" },
              },
              {
                stream: "assistant",
                ts: 1_002,
                data: { delta: "hello from fake gateway" },
              },
              {
                stream: "lifecycle",
                ts: 1_003,
                data: { phase: "end" },
              },
            ];
            for (const payload of payloads) {
              sendJson(socket, {
                type: "event",
                event: "agent",
                seq: seq++,
                stateVersion: { presence: 7, health: 9 },
                payload: {
                  runId: "run-sdk-e2e",
                  sessionId: "session-sdk-e2e",
                  sessionKey: "main",
                  agentId: "main",
                  ...payload,
                },
              });
            }
          }, 50);
          return;
        }

        if (frame.method === "agent.wait") {
          assertSchema(AgentWaitParamsSchema, frame.params ?? {}, "agent.wait params");
          reply({
            status: "ok",
            runId: "run-sdk-e2e",
            sessionKey: "main",
            startedAt: 123,
            endedAt: 456,
          });
          return;
        }

        if (frame.method === "artifacts.list") {
          assertSchema(ArtifactsListParamsSchema, frame.params ?? {}, "artifacts.list params");
          expect(frame.params).toEqual({ runId: "run-sdk-e2e" });
          const result = {
            artifacts: [
              {
                id: "artifact-sdk-e2e",
                type: "file",
                title: "sdk-result.txt",
                download: { mode: "bytes" },
              },
            ],
          };
          assertSchema(ArtifactsListResultSchema, result, "artifacts.list result");
          reply(result);
          return;
        }

        if (frame.method === "environments.create") {
          const params = requireJsonObject(frame.params ?? {}, "environments.create params");
          assertSchema(EnvironmentsCreateParamsSchema, params, "environments.create params");
          const respond: RespondFn = (ok, payload, error) => {
            if (!ok) {
              sendJson(socket, { type: "res", id: frame.id, ok: false, error });
              return;
            }
            assertSchema(EnvironmentsCreateResultSchema, payload, "environments.create result");
            reply(payload);
          };
          await environmentsHandlers[frame.method]!({
            req: { type: "req", id: frame.id, method: frame.method, params },
            params,
            client: null,
            isWebchatConnect: () => false,
            respond,
            context: environmentContext,
          });
          return;
        }

        sendJson(socket, {
          type: "res",
          id: frame.id,
          ok: false,
          error: { code: "UNKNOWN_METHOD", message: `unhandled method ${frame.method}` },
        });
      })().catch((error: unknown) => {
        const frame = JSON.parse(rawDataToString(raw)) as FakeGatewayRequest;
        sendJson(socket, {
          type: "res",
          id: frame.id,
          ok: false,
          error: {
            code: "TEST_ASSERTION_FAILED",
            message: `${frame.method}: ${String(error)}`,
          },
        });
      });
    });
  });

  const address = server.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${address.port}`,
    close: async () => {
      const index = fakeServers.indexOf(server);
      if (index >= 0) {
        fakeServers.splice(index, 1);
      }
      await closeFakeServer(server);
    },
  };
}

async function collectUntilCompleted(events: AsyncIterable<OpenClawEvent>) {
  const collected: OpenClawEvent[] = [];
  for await (const event of events) {
    collected.push(event);
    if (event.type === "run.completed") {
      break;
    }
  }
  return collected;
}

async function proveDeterministicGatewayContracts(): Promise<void> {
  const dateNow = vi.spyOn(Date, "now").mockReturnValue(10_000);
  const gateway = await createFakeGateway();
  const oc = new OpenClaw({
    transport: new GatewayClientTransport({
      url: gateway.url,
      deviceIdentity: null,
      requestTimeoutMs: 2_000,
    }),
  });
  try {
    const agent = await oc.agents.get("main");
    const run = await agent.run({
      input: "say hello",
      sessionKey: "main",
      idempotencyKey: "sdk-a2-run",
    });
    const [appEvents, runEvents, result] = await Promise.all([
      withTimeout(collectUntilCompleted(oc.events()), 2_000, {
        message: "timed out waiting for app-wide SDK events",
      }),
      withTimeout(collectUntilCompleted(run.events()), 2_000, {
        message: "timed out waiting for per-run SDK events",
      }),
      run.wait({ timeoutMs: 2_000 }),
    ]);
    const expectedEvents = (
      [
        { seq: 2, ts: 1_001, type: "run.started", stream: "lifecycle", data: { phase: "start" } },
        {
          seq: 3,
          ts: 1_002,
          type: "assistant.delta",
          stream: "assistant",
          data: { delta: "hello from fake gateway" },
        },
        { seq: 4, ts: 1_003, type: "run.completed", stream: "lifecycle", data: { phase: "end" } },
      ] as const
    ).map<OpenClawEvent>(({ seq, ts, type, stream, data }) => ({
      version: 1,
      id: `${seq}:agent:run-sdk-e2e:main:${ts}`,
      ts,
      type,
      runId: "run-sdk-e2e",
      sessionId: "session-sdk-e2e",
      sessionKey: "main",
      agentId: "main",
      data,
      raw: {
        event: "agent",
        seq,
        stateVersion: { presence: 7, health: 9 },
        payload: {
          runId: "run-sdk-e2e",
          sessionId: "session-sdk-e2e",
          sessionKey: "main",
          agentId: "main",
          stream,
          ts,
          data,
        },
      },
    }));
    expect(appEvents).toEqual(expectedEvents);
    expect(runEvents).toEqual(expectedEvents);
    expect(result).toMatchObject({
      runId: "run-sdk-e2e",
      sessionKey: "main",
      status: "completed",
      startedAt: 123,
      endedAt: 456,
    });

    await expect(oc.artifacts.list({ runId: "run-sdk-e2e" })).resolves.toEqual({
      artifacts: [
        {
          id: "artifact-sdk-e2e",
          type: "file",
          title: "sdk-result.txt",
          download: { mode: "bytes" },
        },
      ],
    });

    const created = await oc.environments.create({
      profileId: "development",
      idempotencyKey: "sdk-environment-create",
    });
    expect(created).toMatchObject({
      id: "worker-sdk-e2e",
      status: "starting",
      worker: {
        providerId: "testbox",
        profileId: "development",
        leaseId: "lease-sdk-e2e",
        state: "requested",
        ageMs: 9_000,
        attachedSessionIds: ["session-sdk-e2e"],
        tunnelStatus: "stopped",
      },
    });
  } finally {
    await oc.close();
    await gateway.close();
    dateNow.mockRestore();
  }
}

async function proveRealGatewayContracts(): Promise<void> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sdk-a2-gateway-"));
  const sessionKey = "agent:main:sdk-real-gateway";
  const sessionId = "sdk-real-gateway-session";
  const transcriptPath = path.join(tempDir, `${sessionId}.jsonl`);
  const previousSessionStorePath = testState.sessionStorePath;
  const runId = "sdk-real-gateway-run";
  const timeoutRunId = "sdk-real-gateway-timeout";
  const pendingLifecycleEvents = new Set([
    `${runId}:start`,
    `${runId}:end`,
    `${timeoutRunId}:start`,
    `${timeoutRunId}:error`,
  ]);
  const lifecycleWritesAccepted = createDeferred();
  const lifecycleWrites = createPreparedLifecycleWriteTracker();
  const prepareLifecycle = lifecycleState.prepareGatewaySessionLifecycleEvent;
  const lifecyclePersistence = vi
    .spyOn(lifecycleState, "prepareGatewaySessionLifecycleEvent")
    .mockImplementation((params) => {
      const persist = prepareLifecycle(params);
      const phase = params.event.data?.phase;
      if (
        (params.event.runId !== runId && params.event.runId !== timeoutRunId) ||
        (phase !== "start" && phase !== "end" && phase !== "error")
      ) {
        return persist;
      }
      const write = lifecycleWrites.track(persist);
      pendingLifecycleEvents.delete(`${params.event.runId}:${phase}`);
      if (pendingLifecycleEvents.size === 0) {
        lifecycleWritesAccepted.resolve();
      }
      return write;
    });
  let started: Awaited<ReturnType<typeof startServer>> | undefined;
  let oc: OpenClaw | undefined;
  testState.sessionStorePath = path.join(tempDir, "sessions.json");

  try {
    await fs.writeFile(
      transcriptPath,
      `${JSON.stringify({ type: "session", version: CURRENT_SESSION_VERSION, id: sessionId })}\n${JSON.stringify(
        {
          type: "message",
          id: "sdk-artifact-message",
          parentId: null,
          timestamp: "2026-08-03T00:00:00.000Z",
          message: {
            role: "assistant",
            content: [
              {
                type: "file",
                data: "aGVsbG8=",
                mimeType: "text/plain",
                title: "sdk-result.txt",
              },
            ],
            __openclaw: { seq: 2, runId: "sdk-artifact-run" },
          },
        },
      )}\n`,
    );
    await writeSessionStore({
      entries: {
        [sessionKey]: {
          sessionId,
          sessionFile: transcriptPath,
          updatedAt: Date.now(),
        },
      },
    });

    const token = "sdk-real-gateway-token";
    started = await startServer(token, { controlUiEnabled: false });
    oc = new OpenClaw({
      transport: new GatewayClientTransport({
        url: `ws://127.0.0.1:${started.port}`,
        token,
        deviceIdentity: null,
        requestTimeoutMs: 2_000,
      }),
    });
    await oc.connect();

    registerAgentRunContext(runId, { sessionKey, verboseLevel: "off" });
    const run = await oc.runs.get(runId);
    await expect(run.wait({ timeoutMs: 0 })).resolves.toMatchObject({
      runId,
      status: "accepted",
    });
    const eventsPromise = collectUntilCompleted(run.events());
    emitAgentEvent({
      runId,
      stream: "lifecycle",
      data: { phase: "start", startedAt: 111 },
    });
    emitAgentEvent({
      runId,
      stream: "assistant",
      data: { delta: "hello from real gateway" },
    });
    emitAgentEvent({
      runId,
      stream: "lifecycle",
      data: { phase: "end", endedAt: 222 },
    });
    const realEvents = await withTimeout(eventsPromise, 2_000, {
      message: "timed out waiting for real Gateway SDK events",
    });
    expect(realEvents.map((event) => event.type)).toEqual([
      "run.started",
      "assistant.delta",
      "run.completed",
    ]);
    expect(realEvents.map((event) => event.sessionKey)).toEqual([
      sessionKey,
      sessionKey,
      sessionKey,
    ]);
    await expect(run.wait({ timeoutMs: 2_000 })).resolves.toMatchObject({
      runId,
      status: "completed",
      startedAt: 111,
      endedAt: 222,
    });

    registerAgentRunContext(timeoutRunId, { sessionKey, verboseLevel: "off" });
    emitAgentEvent({
      runId: timeoutRunId,
      stream: "lifecycle",
      data: { phase: "start", startedAt: 333 },
    });
    emitAgentEvent({
      runId: timeoutRunId,
      stream: "lifecycle",
      data: {
        phase: "error",
        startedAt: 333,
        endedAt: 444,
        aborted: true,
        stopReason: "timeout",
        timeoutPhase: "provider",
        providerStarted: true,
        error: "provider timed out",
        fallbackExhaustedFailure: true,
      },
    });
    await expect(oc.runs.wait(timeoutRunId, { timeoutMs: 2_000 })).resolves.toMatchObject({
      runId: timeoutRunId,
      status: "timed_out",
      startedAt: 333,
      endedAt: 444,
      error: { message: "provider timed out" },
    });

    // run.wait can precede acceptance, and accepted writes may still wait in the owner queue.
    await lifecycleWritesAccepted.promise;
    await lifecycleWrites.drain();
    expect(loadSessionEntry({ storePath: testState.sessionStorePath, sessionKey })).toMatchObject({
      sessionId,
      status: "timeout",
      lastRunId: timeoutRunId,
      startedAt: 333,
      endedAt: 444,
    });

    const artifacts = await oc.artifacts.list({ sessionKey });
    assertSchema(ArtifactsListResultSchema, artifacts, "real artifacts.list result");
    expect(artifacts.artifacts).toHaveLength(1);
    const artifactId = artifacts.artifacts[0]?.id ?? "";
    const artifact = await oc.artifacts.get(artifactId, { sessionKey });
    assertSchema(ArtifactsGetResultSchema, artifact, "real artifacts.get result");
    expect(artifact.artifact).toMatchObject({
      id: artifactId,
      type: "file",
      title: "sdk-result.txt",
      mimeType: "text/plain",
    });
    const download = await oc.artifacts.download(artifactId, { sessionKey });
    assertSchema(ArtifactsDownloadResultSchema, download, "real artifacts.download result");
    expect(download).toMatchObject({
      artifact: { id: artifactId },
      encoding: "base64",
      data: "aGVsbG8=",
    });

    const environments = await oc.environments.list();
    assertSchema(EnvironmentsListResultSchema, environments, "real environments.list result");
    expect(environments.environments).toContainEqual({
      id: "gateway",
      type: "local",
      label: "Gateway local",
      status: "available",
      platform: process.platform,
      sessionHost: true,
      trust: "persistent",
      capabilities: ["agent.run", "sessions", "tools", "workspace"],
    });
    const gatewayEnvironment = await oc.environments.status("gateway");
    assertSchema(
      EnvironmentsStatusResultSchema,
      gatewayEnvironment,
      "real environments.status result",
    );
    expect(gatewayEnvironment).toMatchObject({
      id: "gateway",
      type: "local",
      status: "available",
    });
    await expect(
      oc.environments.create({
        profileId: "development",
        idempotencyKey: "sdk-real-environment-create",
      }),
    ).rejects.toThrow("cloud worker environments are not configured");
    await expect(oc.environments.destroy("worker-sdk-missing")).rejects.toThrow(
      "unknown environmentId",
    );
  } finally {
    try {
      await oc?.close();
      await started?.server.close();
    } finally {
      try {
        await lifecycleWrites.drain();
      } finally {
        lifecyclePersistence.mockRestore();
        started?.envSnapshot.restore();
        testState.sessionStorePath = previousSessionStorePath;
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    }
  }
}

describe("composed preview App SDK Gateway contracts", () => {
  installGatewayTestHooks({ scope: "test" });

  afterEach(async () => {
    await Promise.all(fakeServers.splice(0).map(closeFakeServer));
  });

  it("proves event, run, artifact, environment, and schema contracts", async () => {
    await proveDeterministicGatewayContracts();
    await proveRealGatewayContracts();
  }, 30_000);
});
