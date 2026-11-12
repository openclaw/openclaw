// Scenario-owned proof for composed preview App SDK Gateway contracts.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import { describe, expect, it, vi } from "vitest";
import {
  EnvironmentsCreateParamsSchema,
  EnvironmentsCreateResultSchema,
  EnvironmentsListResultSchema,
  EnvironmentsStatusResultSchema,
} from "../../packages/gateway-protocol/src/index.js";
import {
  ArtifactsDownloadResultSchema,
  ArtifactsGetResultSchema,
  ArtifactsListResultSchema,
} from "../../packages/gateway-protocol/src/schema/artifacts.js";
import { collectUntil } from "../../packages/sdk/src/client.test-support.js";
import { GatewayClientTransport, OpenClaw } from "../../packages/sdk/src/index.js";
import {
  createSdkWebSocketServer,
  replySdkRequest,
} from "../../packages/sdk/src/transport.websocket.test-support.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { getRuntimeConfig } from "../config/config.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.entry.js";
import { persistSessionTranscriptTurn } from "../config/sessions/session-accessor.js";
import { isSessionHistoryWorkerCold } from "../config/sessions/session-transcript-worker-runtime.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { registerAgentRunContext } from "../infra/agent-run-registry.js";
import { withTimeout } from "../infra/fs-safe.js";
import { prewarmGatewaySessionHistory } from "./server-history-prewarm.js";
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

function assertSchema(schema: TSchema, value: unknown, label: string): void {
  if (!Value.Check(schema, value)) {
    throw new Error(`${label} failed Gateway schema validation`);
  }
}

// Generic agent/event/artifact wire behavior lives in packages/sdk/src/index.e2e.test.ts.
// Retain this real handler composition for the worker-create schema and projection.
async function proveWorkerCreation(): Promise<void> {
  const dateNow = vi.spyOn(Date, "now").mockReturnValue(10_000);
  const gateway = await createSdkWebSocketServer();
  let oc: OpenClaw | undefined;
  try {
    const record: WorkerEnvironmentServiceRecord = {
      resourceReceipt: null,
      retention: null,
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
    const context = {
      workerEnvironmentService: {
        create: async () => record,
      } satisfies Pick<WorkerEnvironmentServiceContract, "create">,
    } as unknown as GatewayRequestHandlerOptions["context"];
    gateway.setRequestHandler((socket, frame) => {
      void (async () => {
        expect(frame.method).toBe("environments.create");
        assertSchema(EnvironmentsCreateParamsSchema, frame.params, "environments.create params");
        const respond: RespondFn = (ok, payload, error) => {
          if (ok) {
            assertSchema(EnvironmentsCreateResultSchema, payload, "environments.create result");
          }
          replySdkRequest(socket, frame.id, ok ? payload : error, ok);
        };
        await environmentsHandlers["environments.create"]!({
          req: { type: "req", ...frame },
          params: frame.params,
          client: null,
          isWebchatConnect: () => false,
          respond,
          context,
        });
      })().catch((error: unknown) =>
        replySdkRequest(
          socket,
          frame.id,
          {
            code: "TEST_ASSERTION_FAILED",
            message: String(error),
          },
          false,
        ),
      );
    });
    oc = new OpenClaw({
      transport: new GatewayClientTransport({
        url: gateway.url,
        deviceIdentity: null,
        requestTimeoutMs: 2_000,
      }),
    });
    await expect(
      oc.environments.create({
        profileId: "development",
        idempotencyKey: "sdk-environment-create",
      }),
    ).resolves.toMatchObject({
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
    try {
      await oc?.close();
    } finally {
      try {
        await gateway.close();
      } finally {
        dateNow.mockRestore();
      }
    }
  }
}

async function proveRealGatewayContracts(): Promise<void> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sdk-a2-gateway-"));
  const sessionKey = "agent:main:sdk-real-gateway";
  const sessionId = "sdk-real-gateway-session";
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
    await writeSessionStore({
      entries: { [sessionKey]: { sessionId, updatedAt: Date.now() } },
    });
    await persistSessionTranscriptTurn(
      { agentId: "main", sessionKey, sessionId, storePath: testState.sessionStorePath },
      {
        messages: [
          {
            message: {
              role: "assistant",
              content: [
                { type: "file", data: "aGVsbG8=", mimeType: "text/plain", title: "sdk-result.txt" },
              ],
            },
          },
        ],
        updateMode: "none",
      },
    );

    const token = "sdk-real-gateway-token";
    started = await startServer(token, { controlUiEnabled: false });
    // The minimal test Gateway skips the post-ready sidecar that prewarms history workers,
    // and backend SDK clients do not trigger the operator connect prewarm. Join the same
    // owner so request budgets measure warm reads, not first worker boot.
    await prewarmGatewaySessionHistory(getRuntimeConfig());
    expect(isSessionHistoryWorkerCold()).toBe(false);
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
    const eventsPromise = collectUntil(run.events(), (event) => event.type === "run.completed");
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
    expect(environments.environments).toContainEqual(
      expect.objectContaining({ id: "gateway", type: "local", status: "available" }),
    );
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

  it("proves event, run, artifact, environment, and schema contracts", async () => {
    await proveWorkerCreation();
    await proveRealGatewayContracts();
  }, 30_000);
});
