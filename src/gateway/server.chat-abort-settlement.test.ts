// Real WebSocket coverage for delivery settlement after an acknowledged abort.
import path from "node:path";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { closeGatewayTestWebSocket } from "../../test/helpers/gateway-websocket.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { dispatchInboundMessage } from "../auto-reply/dispatch.js";
import type { GetReplyOptions } from "../auto-reply/get-reply-options.types.js";
import { createReplyOperation } from "../auto-reply/reply/reply-run-registry.js";
import { clearConfigCache } from "../config/config.js";
import { observeGatewayConnectionWork } from "./server-held-work.test-support.js";
import {
  connectOk,
  createGatewaySuiteHarness,
  dispatchInboundMessageMock,
  installGatewayTestHooks,
  onceMessage,
  rpcReq,
  testState,
  writeSessionStore,
} from "./test-helpers.js";
import { releaseGatewaySessionStoreFixture } from "./test/server-sessions-resources.test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

const temporaryDirectories = useAutoCleanupTempDirTracker(afterEach);
type GatewayHarness = Awaited<ReturnType<typeof createGatewaySuiteHarness>>;
type GatewaySocket = Awaited<ReturnType<GatewayHarness["openWs"]>>;
let gateway: GatewayHarness;
const connectionReleases: Promise<void>[] = [];
let restoreConnectionObserver: (() => void) | undefined;

function trackChatTerminalStates(socket: GatewaySocket, runId: string): string[] {
  const terminalStates: string[] = [];
  socket.on("message", (raw) => {
    try {
      const frame = JSON.parse(rawDataToString(raw)) as {
        type?: string;
        event?: string;
        payload?: { runId?: string; state?: string };
      };
      if (
        frame.type === "event" &&
        frame.event === "chat" &&
        frame.payload?.runId === runId &&
        typeof frame.payload.state === "string"
      ) {
        terminalStates.push(frame.payload.state);
      }
    } catch {
      // The owned test socket may also carry unrelated gateway events.
    }
  });
  return terminalStates;
}

beforeAll(async () => {
  const observer = await observeGatewayConnectionWork(connectionReleases);
  restoreConnectionObserver = observer.restore;
  try {
    gateway = await createGatewaySuiteHarness();
  } finally {
    observer.stopCapture();
  }
});

afterAll(async () => {
  await gateway.close();
  restoreConnectionObserver?.();
});

afterEach(async () => {
  await runQaGatewayFixture(
    async () => {
      for (const dir of temporaryDirectories.dirs) {
        await releaseGatewaySessionStoreFixture(dir);
      }
    },
    () => {
      dispatchInboundMessageMock.mockReset();
      testState.sessionStorePath = undefined;
      clearConfigCache();
    },
  );
});

describe("gateway WebSocket chat abort settlement", () => {
  test.each([
    "fulfilled",
    "rejected",
    "queued-fulfilled",
    "queued-rejected",
    "accepted-injection",
  ] as const)(
    "preserves an acknowledged abort and completes its preinstalled waiter after %s dispatch",
    async (settlement) => {
      const sessionDirectory = temporaryDirectories.make("openclaw-chat-abort-dispatch-");
      testState.sessionStorePath = path.join(sessionDirectory, "sessions.json");
      await writeSessionStore({
        entries: {
          main: {
            sessionId: "sess-main",
            updatedAt: Date.now(),
          },
        },
      });

      const agentJobs = await import("./agent-turn/agent-job.js");
      const connectionOffset = connectionReleases.length;
      const socket = await gateway.openWs();
      const dispatchRelease = createDeferred();
      const waitInstalled = createDeferred();
      const runId = `real-websocket-explicit-abort-before-${settlement}-dispatch`;
      const terminalStates = trackChatTerminalStates(socket, runId);
      const dispatches: Array<ReturnType<typeof dispatchInboundMessage>> = [];
      const frames: Promise<unknown>[] = [];
      let waitWork: ReturnType<typeof agentJobs.waitForAgentJob> | undefined;
      let waitSettled = false;
      let queuedLifecycle: GetReplyOptions["turnAdoptionLifecycle"];
      let injectionOperation: ReturnType<typeof createReplyOperation> | undefined;
      let injectionSignal: AbortSignal | undefined;
      const injectionWork: Promise<void>[] = [];
      const waitForAgentJob = agentJobs.waitForAgentJob;
      const waitObserver = vi.spyOn(agentJobs, "waitForAgentJob").mockImplementation((params) => {
        const work = waitForAgentJob(params);
        if (params.runId === runId) {
          waitWork = work;
          void work.then(
            () => {
              waitSettled = true;
            },
            () => {
              waitSettled = true;
            },
          );
          // The real owner installs its waiter synchronously before returning this promise.
          waitInstalled.resolve();
        }
        return work;
      });

      try {
        await connectOk(socket);
        if (settlement === "accepted-injection") {
          injectionOperation = createReplyOperation({
            sessionKey: "agent:main:main",
            sessionId: "sess-main",
            resetTriggered: false,
          });
          const fingerprint = "accepted-steer-tools";
          injectionOperation.bindToolAuthoritySnapshot({
            fingerprint: () => fingerprint,
            project: () => fingerprint,
          });
          injectionOperation.bindToolAuthorityRoute({
            provider: "test-provider",
            model: "test-model",
          });
          injectionOperation.setPhase("running");
          injectionOperation.attachBackend({
            kind: "embedded",
            runId: "accepted-steer-backing-run",
            toolAuthorityFingerprint: fingerprint,
            cancel: () => {},
            messageInjectionV2: {
              version: 2,
              isAvailable: () => true,
              queueMessage: (_text, options, assertCurrent) => {
                assertCurrent();
                injectionSignal = options?.abortSignal;
                options?.onQueueAccepted?.(true);
                const work = dispatchRelease.promise.then(() => {});
                injectionWork.push(work);
                return work;
              },
            },
          });
        } else {
          dispatchInboundMessageMock.mockImplementationOnce((args: unknown) => {
            const work = (async () => {
              if (settlement.startsWith("queued-")) {
                queuedLifecycle = (args as Parameters<typeof dispatchInboundMessage>[0])
                  .replyOptions?.turnAdoptionLifecycle;
              }
              await dispatchRelease.promise;
              if (settlement.endsWith("rejected")) {
                throw new Error("dispatch rejected after an explicitly aborted run");
              }
              return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
            })();
            dispatches.push(work);
            void work.catch(() => {});
            return work;
          });
        }

        const sendParameters = {
          sessionKey: "main",
          message: "abort this dispatched message",
          idempotencyKey: runId,
          ...(settlement === "accepted-injection" ? { queueMode: "steer" } : {}),
        };
        const started = await rpcReq(socket, "chat.send", sendParameters);
        expect(started.ok).toBe(true);
        expect(started.payload).toMatchObject({ runId, status: "started" });
        if (settlement === "accepted-injection") {
          expect(injectionWork).toHaveLength(1);
          expect(injectionSignal?.aborted).toBe(false);
          expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
        } else {
          await vi.waitFor(() => expect(dispatchInboundMessageMock).toHaveBeenCalledOnce(), {
            interval: 10,
            timeout: 2_000,
          });
        }

        const waitResponse = rpcReq(socket, "agent.wait", { runId, timeoutMs: 2_000 });
        frames.push(waitResponse);
        void waitResponse.catch(() => {});
        await waitInstalled.promise;
        if (settlement.startsWith("queued-")) {
          expect(queuedLifecycle?.onDeferred?.()).toBe(true);
        }
        const abortedFrame = onceMessage(
          socket,
          (frame) =>
            frame.type === "event" &&
            frame.event === "chat" &&
            frame.payload?.runId === runId &&
            frame.payload?.state === "aborted",
          2_000,
        );
        frames.push(abortedFrame);
        void abortedFrame.catch(() => {});
        const aborted = await rpcReq(socket, "chat.abort", {
          sessionKey: "main",
          runId,
        });
        expect(aborted.ok).toBe(true);
        expect(aborted.payload).toMatchObject({ ok: true, aborted: true, runIds: [runId] });
        await expect(abortedFrame).resolves.toMatchObject({
          payload: { runId, state: "aborted" },
        });
        expect(waitSettled).toBe(false);
        if (settlement === "accepted-injection") {
          expect(injectionSignal?.aborted).toBe(true);
        }

        dispatchRelease.resolve();
        await expect(waitResponse).resolves.toMatchObject({
          ok: true,
          payload: { runId, status: "error", stopReason: "rpc", endedAt: expect.any(Number) },
        });

        // Replay can itself record an aborted receipt, so it must follow the original wait.
        // It also orders any contradictory terminal frame before this cached response.
        const replay = await rpcReq(socket, "chat.send", sendParameters);
        expect(replay.ok).toBe(true);
        expect(replay.payload).toMatchObject({ runId, status: "timeout", summary: "aborted" });
        expect(terminalStates).toEqual(["aborted"]);
      } finally {
        dispatchRelease.resolve();
        await runQaGatewayFixture(
          () => closeGatewayTestWebSocket(socket),
          async () => {
            await Promise.allSettled([...dispatches, ...injectionWork]);
            queuedLifecycle?.onSettled?.();
            await Promise.allSettled([
              ...frames,
              waitWork,
              ...connectionReleases.slice(connectionOffset),
            ]);
          },
          () => injectionOperation?.complete(),
          () => waitObserver.mockRestore(),
        );
      }
    },
  );
});
