import { describe, expect, it, vi } from "vitest";
import type {
  WorkerTranscriptCommitParams,
  WorkerLiveEventParams,
} from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import type { WorkerInferenceStartParams } from "../../packages/gateway-protocol/src/schema/worker-inference.js";
import { buildWorkerConnectParams, type WorkerLaunchDescriptor } from "./launch-descriptor.js";
import {
  WorkerAdmissionDeadlineExceededError,
  WorkerConnectionStoppedError,
} from "./worker-connection-contract.js";
import { createWorkerConnection } from "./worker-connection.js";
import { WorkerInferenceProxyClient } from "./worker-rpc-inference-client.js";
import { WorkerLiveEventClient } from "./worker-rpc-live-event-client.js";
import { WorkerTranscriptCommitClient } from "./worker-rpc-transcript-client.js";

type WorkerReconnectFixture = {
  setup: (options?: {
    heartbeatIntervalMs?: number;
    admissionFailure?: "gateway-unavailable";
    ignoreFirstAdmission?: boolean;
    ignoreHeartbeat?: boolean;
    silenceFirstTranscript?: boolean;
    silenceFirstLiveEvent?: boolean;
    silenceFirstInference?: boolean;
  }) => Promise<{
    gateway: {
      socketPath: string;
      methods: string[];
      connectionCount: number;
      liveEventRequests: WorkerLiveEventParams[];
      transcriptRequests: WorkerTranscriptCommitParams[];
      inferenceRequests: WorkerInferenceStartParams[];
    };
    launch: WorkerLaunchDescriptor;
  }>;
  waitForFast: <T>(
    callback: () => T | Promise<T>,
    options?: { timeout?: number; interval?: number },
  ) => Promise<T>;
  ownerEpoch: number;
  runId: string;
  sessionId: string;
  modelRef: WorkerInferenceStartParams["modelRef"];
};

export function registerWorkerReconnectTests({
  setup,
  waitForFast,
  ownerEpoch: OWNER_EPOCH,
  runId: RUN_ID,
  sessionId: SESSION_ID,
  modelRef: MODEL_REF,
}: WorkerReconnectFixture) {
  describe("worker reconnect clients", () => {
    it("isolates ready listener failures while admitting the worker and starting heartbeats", async () => {
      const { gateway, launch } = await setup({ heartbeatIntervalMs: 1 });
      const connection = createWorkerConnection({
        endpoint: { kind: "unix", socketPath: gateway.socketPath },
        connectParams: buildWorkerConnectParams(launch),
      });
      let healthyReadyCalls = 0;
      connection.onReady(() => {
        throw new Error("induced ready observer failure");
      });
      connection.onReady(() => {
        healthyReadyCalls += 1;
      });

      try {
        await expect(connection.start()).resolves.toMatchObject({ ownerEpoch: OWNER_EPOCH });
        expect(healthyReadyCalls).toBe(1);
        await waitForFast(() => expect(gateway.methods).toContain("worker.heartbeat"));
      } finally {
        await connection.stop();
      }
    });

    it("fails closed when the overall admission deadline expires", async () => {
      const { gateway, launch } = await setup({ admissionFailure: "gateway-unavailable" });
      const connection = createWorkerConnection({
        endpoint: { kind: "unix", socketPath: gateway.socketPath },
        connectParams: buildWorkerConnectParams(launch),
        admissionTimeoutMs: 25,
        admissionDeadlineMs: 250,
        reconnectBackoff: { initialMs: 1, maxMs: 1, factor: 1, jitter: 0 },
      });
      try {
        await expect(connection.start()).rejects.toBeInstanceOf(
          WorkerAdmissionDeadlineExceededError,
        );
        expect(gateway.connectionCount).toBeGreaterThan(1);
        expect(connection.state).toMatchObject({
          kind: "failed",
          error: expect.any(WorkerAdmissionDeadlineExceededError),
        });
        await expect(connection.waitForExit()).resolves.toMatchObject({
          kind: "failed",
          error: expect.any(WorkerAdmissionDeadlineExceededError),
        });
      } finally {
        await connection.stop();
      }
    });

    it("times out a silent admission attempt and admits on reconnect", async () => {
      const { gateway, launch } = await setup({ ignoreFirstAdmission: true });
      const connection = createWorkerConnection({
        endpoint: { kind: "unix", socketPath: gateway.socketPath },
        connectParams: buildWorkerConnectParams(launch),
        admissionTimeoutMs: 25,
        reconnectBackoff: { initialMs: 1, maxMs: 1, factor: 1, jitter: 0 },
      });
      try {
        await expect(connection.start()).resolves.toMatchObject({ ownerEpoch: OWNER_EPOCH });
        expect(gateway.connectionCount).toBeGreaterThanOrEqual(2);
      } finally {
        await connection.stop();
      }
    });

    it("times out a silent heartbeat and reconnects", async () => {
      const { gateway, launch } = await setup({
        ignoreHeartbeat: true,
        heartbeatIntervalMs: 1,
      });
      const connection = createWorkerConnection({
        endpoint: { kind: "unix", socketPath: gateway.socketPath },
        connectParams: buildWorkerConnectParams(launch),
        requestTimeoutMs: 25,
        reconnectBackoff: { initialMs: 1, maxMs: 1, factor: 1, jitter: 0 },
      });
      try {
        await connection.start();
        await waitForFast(() => expect(gateway.connectionCount).toBeGreaterThanOrEqual(2));
      } finally {
        await connection.stop();
      }
    });

    it("replays exact RPC payloads after silent response timeouts", async () => {
      const { gateway, launch } = await setup({
        silenceFirstTranscript: true,
        silenceFirstLiveEvent: true,
        silenceFirstInference: true,
      });
      const connection = createWorkerConnection({
        endpoint: { kind: "unix", socketPath: gateway.socketPath },
        connectParams: buildWorkerConnectParams(launch),
        requestTimeoutMs: 40,
        reconnectBackoff: { initialMs: 1, maxMs: 1, factor: 1, jitter: 0 },
      });
      const transcript = new WorkerTranscriptCommitClient(connection, {
        runEpoch: OWNER_EPOCH,
        baseLeafId: "leaf-base",
        initialSeq: 8,
      });
      const live = new WorkerLiveEventClient(connection, { runEpoch: OWNER_EPOCH });
      const inference = new WorkerInferenceProxyClient(connection);
      try {
        await connection.start();
        await transcript.commit([
          {
            role: "user",
            content: [{ type: "text", text: "silent transcript" }],
            timestamp: 1,
          },
        ]);
        live.enqueuePreview(RUN_ID, {
          kind: "assistant",
          payload: { text: "silent live event", delta: "silent live event" },
        });
        await waitForFast(() => expect(gateway.liveEventRequests).toHaveLength(2));
        await live.emitTerminal(RUN_ID, {
          kind: "lifecycle",
          payload: { phase: "finishing", startedAt: 1, endedAt: 2 },
        });
        await inference.start({
          runEpoch: OWNER_EPOCH,
          sessionId: SESSION_ID,
          runId: RUN_ID,
          turnId: "silent-inference",
          modelRef: MODEL_REF,
          context: { messages: [] },
          options: {},
        });

        expect(gateway.transcriptRequests).toHaveLength(2);
        expect(gateway.transcriptRequests[1]).toEqual(gateway.transcriptRequests[0]);
        expect(gateway.liveEventRequests).toHaveLength(3);
        expect(gateway.liveEventRequests[1]).toEqual(gateway.liveEventRequests[0]);
        expect(gateway.inferenceRequests).toHaveLength(2);
        expect(gateway.inferenceRequests[1]).toEqual(gateway.inferenceRequests[0]);
        expect(gateway.connectionCount).toBeGreaterThanOrEqual(4);
      } finally {
        inference.dispose();
        live.dispose();
        await connection.stop();
      }
    });

    it("settles an in-flight commit and a later live emit after stop", async () => {
      const { gateway, launch } = await setup({ silenceFirstTranscript: true });
      const connection = createWorkerConnection({
        endpoint: { kind: "unix", socketPath: gateway.socketPath },
        connectParams: buildWorkerConnectParams(launch),
        requestTimeoutMs: 5_000,
        reconnectBackoff: { initialMs: 1, maxMs: 1, factor: 1, jitter: 0 },
      });
      const originalWaitForReady = connection.waitForReady.bind(connection);
      const waitForReady = vi.spyOn(connection, "waitForReady").mockImplementation(() => {
        if (waitForReady.mock.calls.length > 4) {
          throw new Error("worker client retried after terminal stop");
        }
        return originalWaitForReady();
      });
      const transcript = new WorkerTranscriptCommitClient(connection, {
        runEpoch: OWNER_EPOCH,
        baseLeafId: "leaf-base",
        initialSeq: 8,
      });
      let live: WorkerLiveEventClient | undefined;
      try {
        await connection.start();
        const commit = transcript.commit([
          {
            role: "user",
            content: [{ type: "text", text: "commit interrupted by stop" }],
            timestamp: 1,
          },
        ]);
        await waitForFast(() => expect(gateway.transcriptRequests).toHaveLength(1));

        await connection.stop();
        await expect(commit).rejects.toBeInstanceOf(WorkerConnectionStoppedError);

        live = new WorkerLiveEventClient(connection, { runEpoch: OWNER_EPOCH });
        live.enqueuePreview(RUN_ID, {
          kind: "assistant",
          payload: { text: "late live event", delta: "late live event" },
        });
        await expect(
          live.emitTerminal(RUN_ID, {
            kind: "lifecycle",
            payload: { phase: "finishing", startedAt: 1, endedAt: 2 },
          }),
        ).rejects.toBeInstanceOf(WorkerConnectionStoppedError);
        expect(waitForReady.mock.calls.length).toBeLessThanOrEqual(2);
        expect(gateway.liveEventRequests).toHaveLength(0);
      } finally {
        live?.dispose();
        await connection.stop();
      }
    });
  });
}
