/**
 * Loopback Gateway proof of terminal-receipt steering classification. Synthetic
 * active sources exercise the real chat.send handler and wire delivery; the
 * rejection cases restore the production dispatcher with a fixed reply source.
 */

import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RawData, WebSocket } from "ws";
import { createDeferred, withinTest } from "../../../test/helpers/promise.js";
import type { dispatchInboundMessage } from "../../auto-reply/dispatch.js";
import { installQueueRuntimeErrorSilencer } from "../../auto-reply/reply/queue.test-helpers.js";
import { listSessionPendingInputs } from "../../config/sessions/session-accessor.js";
import {
  areDiagnosticsEnabledForProcess,
  onTrustedInternalDiagnosticEvent,
  setDiagnosticsEnabledForProcess,
  type DiagnosticEventPayload,
} from "../../infra/diagnostic-events.js";
import {
  getGatewayContextResolver,
  withPluginRuntimeGatewayContextResolver,
} from "../../plugins/runtime/gateway-request-scope.js";
import type { ReplyBackendMessageInjectionV2 } from "../../sessions/session-controller.contracts.js";
import {
  createReplyOperation,
  bindSessionControllerSourceTurnId,
} from "../../sessions/session-controller.js";
import {
  captureSessionControllerSettlement,
  captureSessionTarget,
} from "../../sessions/session-controller.lifecycle.js";
import { retireSessionControllerInput } from "../../sessions/session-controller.mailbox-source.js";
import { reserveSessionControllerSource } from "../../sessions/session-controller.mailbox.js";
import { getGatewayRecoveryRuntime } from "../server-recovery-runtime-context.js";
import {
  dispatchInboundMessageMock,
  gatewayReplyMock,
  installGatewayTestHooks,
  mockGetReplyFromConfigOnce,
  onceMessage,
  rpcReq,
  testState,
  writeSessionStore,
} from "../test-helpers.js";
import { installConnectedControlUiServerSuite } from "../test-with-server.js";

installGatewayTestHooks({ scope: "suite" });
installQueueRuntimeErrorSilencer();

const SESSION_KEY = "agent:main:main";
const SOURCE_TURN_ID = "source-failclosed-1";

type ChatWirePayload = {
  runId?: string;
  state?: string;
  message?: { text?: string; content?: unknown };
};

let ws: WebSocket;
let sessionStoreDir: string | undefined;
let liveOperation: ReturnType<typeof createReplyOperation> | undefined;

installConnectedControlUiServerSuite((started) => {
  ws = started.ws;
});

function clearLiveOperation() {
  if (liveOperation) {
    try {
      liveOperation.complete();
    } catch {
      // Best-effort cleanup of an operation left behind by a failed test.
    }
    liveOperation = undefined;
  }
}

beforeEach(() => {
  dispatchInboundMessageMock.mockReset();
  dispatchInboundMessageMock.mockImplementation(async (params: unknown) => {
    const { dispatcher } = params as Parameters<typeof dispatchInboundMessage>[0];
    dispatcher.sendFinalReply({ text: "after-fix follow-up reply" });
    dispatcher.markComplete();
    await dispatcher.waitForIdle();
    return { queuedFinal: true, counts: { final: 1, block: 0, tool: 0 } };
  });
});

afterEach(async () => {
  const sessionKey = liveOperation?.key;
  // Capture producer custody before completing the synthetic active turn.
  const settled =
    sessionKey && testState.sessionStorePath
      ? captureSessionControllerSettlement({
          scope: testState.sessionStorePath,
          identities: [sessionKey],
        })
      : undefined;
  clearLiveOperation();
  await settled;
});

async function seedActiveTurn(params: {
  sessionKey?: string;
  terminalRunId: string;
  sourceTurnId?: string;
  deliverySourceRunId?: string;
}) {
  const { sessionKey = SESSION_KEY } = params;
  const sessionId = "session-steer";
  // One suite Gateway keeps one physical store; retained populated stores collide in discovery.
  sessionStoreDir ??= await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-iso-gw-"));
  testState.sessionStorePath = path.join(sessionStoreDir, "sessions.json");
  await writeSessionStore({
    entries: {
      [sessionKey]: {
        sessionId,
        updatedAt: Date.now(),
        restartRecoveryTerminalRunIds: [params.terminalRunId],
        restartRecoveryDeliverySourceRunId: params.deliverySourceRunId,
      },
    },
  });
  const runtime = getGatewayRecoveryRuntime();
  const resolveGatewayContext = runtime && getGatewayContextResolver(runtime);
  if (!resolveGatewayContext) {
    throw new Error("Expected the suite Gateway runtime owner");
  }
  const operation = withPluginRuntimeGatewayContextResolver(resolveGatewayContext, () =>
    createReplyOperation({
      sessionKey,
      sessionId,
      agentId: "main",
      target: captureSessionTarget({
        storeScope: testState.sessionStorePath!,
        sessionKey,
        incarnation: sessionId,
        agentId: "main",
      }),
      resetTriggered: false,
    }),
  );
  liveOperation = operation;
  const fingerprint = "isolated-steer-authority";
  operation.bindToolAuthoritySnapshot({
    fingerprint: () => fingerprint,
    project: () => fingerprint,
  });
  operation.bindToolAuthorityRoute({ provider: "test-provider", model: "test-model" });
  const queueMessage = vi.fn<ReplyBackendMessageInjectionV2["queueMessage"]>(
    async (_text, _options, assertCurrent) => {
      assertCurrent();
    },
  );
  operation.setPhase("running");
  operation.attachBackend({
    kind: "embedded",
    runId: "live-run-steer",
    supportsTranscriptCommitWait: true,
    toolAuthorityFingerprint: fingerprint,
    cancel: () => {},
    isStreaming: () => false,
    messageInjectionV2: { version: 2, isAvailable: () => true, queueMessage },
  });
  if (params.sourceTurnId) {
    bindSessionControllerSourceTurnId(operation, params.sourceTurnId);
  }
  return queueMessage;
}

afterAll(async () => {
  clearLiveOperation();
  if (sessionStoreDir) {
    // Defer removal until Gateway teardown; Windows may still hold SQLite handles.
    await fs.rm(sessionStoreDir, { recursive: true, force: true }).catch(() => undefined);
    sessionStoreDir = undefined;
  }
  testState.sessionStorePath = undefined;
});

describe("terminal-receipt steer fence isolated-gateway proof (#128971)", () => {
  it("acknowledges ordered durable steers and classifies their delayed completion as steering", async ({
    signal,
  }) => {
    const queueMessage = await seedActiveTurn({
      terminalRunId: "source-old",
      sourceTurnId: SOURCE_TURN_ID,
    });
    const older = reserveSessionControllerSource(SESSION_KEY, {
      policy: { mode: "followup" },
      target: captureSessionTarget({
        storeScope: testState.sessionStorePath!,
        sessionKey: SESSION_KEY,
        incarnation: "session-steer",
        agentId: "main",
      }),
    });
    expect(older.mailbox.owner.active).toBe(liveOperation);
    const commit = createDeferred();
    const injected = createDeferred();
    const reported = createDeferred<DiagnosticEventPayload>();
    const previousDiagnostics = areDiagnosticsEnabledForProcess();
    setDiagnosticsEnabledForProcess(true);
    const stop = onTrustedInternalDiagnosticEvent(
      (event) => {
        if (
          event.type === "diagnostic.phase.completed" &&
          event.name === "chat.send.runAdmission" &&
          event.details?.stage === "steer"
        ) {
          reported.resolve(event);
        }
      },
      { include: ["diagnostic.phase.completed"] },
    );
    let clock = 0;
    const now = vi.spyOn(performance, "now").mockImplementation(() => clock);
    const runIds = ["ordered-steer-first", "ordered-steer-second"];
    const messages = ["First synthetic steering input.", "Second synthetic steering input."];
    queueMessage.mockImplementation(async (_text, options, assertCurrent) => {
      assertCurrent();
      options?.onQueueAccepted?.(true);
      if (queueMessage.mock.calls.length === 2) {
        injected.resolve();
      }
      await commit.promise;
      assertCurrent();
      await options?.userTurnTranscriptRecorder?.persistApproved();
    });
    try {
      for (const [index, runId] of runIds.entries()) {
        // `older` is retired only after this loop, so an acknowledgement that waited for
        // injection would never arrive; the default RPC timeout still fails that case.
        // A tighter bound is unsafe: the first call pays cold handler setup (>1s on CI).
        const response = await rpcReq(ws, "chat.send", {
          sessionKey: SESSION_KEY,
          message: messages[index],
          idempotencyKey: runId,
          queueMode: "steer",
        });
        expect(response).toMatchObject({ ok: true, payload: { status: "started", runId } });
      }
      expect(queueMessage).not.toHaveBeenCalled();
      expect(
        await listSessionPendingInputs({
          agentId: "main",
          sessionKey: SESSION_KEY,
          sessionId: "session-steer",
          storePath: testState.sessionStorePath!,
        }),
      ).toMatchObject({
        items: runIds.map((runId) => ({ runId, state: "queued" })),
        total: 2,
      });
      retireSessionControllerInput(older);
      await withinTest(injected.promise, signal);
      expect(queueMessage.mock.calls.map(([text]) => text)).toEqual(messages);
      expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
      clock = 120_001;
      commit.resolve();
      expect(await withinTest(reported.promise, signal)).toMatchObject({
        name: "chat.send.runAdmission",
        durationMs: clock,
        details: { stage: "steer" },
      });
      expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
    } finally {
      retireSessionControllerInput(older);
      commit.resolve();
      now.mockRestore();
      stop();
      setDiagnosticsEnabledForProcess(previousDiagnostics);
    }
  });

  it.for([
    {
      name: "a tombstone for the active source",
      terminalRunId: SOURCE_TURN_ID,
      sourceTurnId: SOURCE_TURN_ID,
      deliverySourceRunId: SOURCE_TURN_ID,
    },
    {
      name: "a retained tombstone with unknown active source identity",
      sessionKey: "agent:main:unknown-source",
      terminalRunId: "source-old",
    },
  ])(
    "$name rejects steering and delivers exactly one follow-up reply over the real transport",
    { timeout: 30_000 },
    async (scenario, { signal }) => {
      const sessionKey = scenario.sessionKey ?? SESSION_KEY;
      const message = "isolated-gateway inbound";
      const replyText = "follow-up reply from the production dispatcher";
      const queueMessage = await seedActiveTurn(scenario);
      // Exercise the production dispatcher; only its reply source is controlled.
      dispatchInboundMessageMock.mockReset();
      mockGetReplyFromConfigOnce(async () => ({ text: replyText }));

      const runId = `idem-iso-gw-${randomUUID()}`;
      const chatFrames: ChatWirePayload[] = [];
      const finalReceived = createDeferred();
      const onChatFrame = (raw: RawData) => {
        try {
          const frame = JSON.parse(rawDataToString(raw)) as {
            type?: string;
            event?: string;
            payload?: ChatWirePayload;
          };
          if (frame.type === "event" && frame.event === "chat" && frame.payload?.runId === runId) {
            chatFrames.push(frame.payload);
            if (frame.payload.state === "final") {
              finalReceived.resolve();
            }
          }
        } catch {
          // Unrelated frames on the shared test socket.
        }
      };
      ws.on("message", onChatFrame);
      try {
        const res = await rpcReq(
          ws,
          "chat.send",
          {
            sessionKey,
            message,
            idempotencyKey: runId,
            queueMode: "steer",
          },
          20_000,
        );

        expect(res, JSON.stringify(res)).toMatchObject({
          ok: true,
          payload: { status: "started", runId },
        });
        expect(queueMessage).not.toHaveBeenCalled();
        expect(dispatchInboundMessageMock).not.toHaveBeenCalled();

        await withinTest(finalReceived.promise, signal);
        const settled = captureSessionControllerSettlement({
          scope: testState.sessionStorePath!,
          identities: [sessionKey, "session-steer"],
        });
        clearLiveOperation();
        await settled;
        // The producer is settled; a pong drains earlier frames on this same connection.
        const pong = once(ws, "pong", { signal });
        ws.ping();
        await withinTest(pong, signal);
        const finals = chatFrames.filter((frame) => frame.state === "final");
        expect(finals).toHaveLength(1);
        expect(finals[0]).toMatchObject({
          message: { content: [{ text: expect.stringContaining(replyText) }] },
        });
      } finally {
        ws.off("message", onChatFrame);
      }
    },
  );
});

it(
  "keeps public chat.send runnable when sessions.patch marks the conversation read",
  { timeout: 30_000 },
  async ({ signal }) => {
    const sessionKey = "agent:main:read-ack-admission";
    const sessionId = "read-ack-session";
    sessionStoreDir ??= await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-iso-gw-"));
    testState.sessionStorePath = path.join(sessionStoreDir, "sessions.json");
    await writeSessionStore({ entries: { [sessionKey]: { sessionId, updatedAt: Date.now() } } });
    dispatchInboundMessageMock.mockReset();
    gatewayReplyMock.mockClear();
    const replyText = "Accepted prompt completed after its read acknowledgement";
    mockGetReplyFromConfigOnce(async () => ({ text: replyText }));

    const entered = createDeferred();
    const resume = createDeferred();
    const markerQueued = createDeferred();
    const entries = await import("../../config/sessions/session-accessor.sqlite-entry.js");
    const read = entries.loadSessionEntryForAdmission;
    const readSpy = vi
      .spyOn(entries, "loadSessionEntryForAdmission")
      .mockImplementationOnce(async (...args) => {
        const result = await read(...args);
        entered.resolve();
        await resume.promise;
        return result;
      });
    const lifecycle = await import("../../sessions/session-controller.lifecycle.js");
    const mutate = lifecycle.runSessionMutation;
    const mutationSpy = vi.spyOn(lifecycle, "runSessionMutation").mockImplementation((params) => {
      const result = mutate(params);
      if (params.kind === "read-marker") {
        markerQueued.resolve();
      }
      return result;
    });
    const runId = randomUUID();
    const final = onceMessage<{ type: string; event?: string; payload?: ChatWirePayload }>(
      ws,
      (frame) =>
        frame.type === "event" &&
        frame.event === "chat" &&
        frame.payload?.runId === runId &&
        frame.payload.state === "final",
      25_000,
    );
    let patch: ReturnType<typeof rpcReq> | undefined;
    try {
      const accepted = await rpcReq(ws, "chat.send", {
        sessionKey,
        message: "Synthetic read-acknowledgement overlap",
        idempotencyKey: runId,
      });
      expect(accepted).toMatchObject({ ok: true, payload: { status: "started", runId } });
      await withinTest(entered.promise, signal);
      patch = rpcReq(ws, "sessions.patch", { key: sessionKey, unread: false });
      await withinTest(markerQueued.promise, signal);
      resume.resolve();
      expect(await withinTest(patch, signal)).toMatchObject({ ok: true });
      expect((await withinTest(final, signal)).payload).toMatchObject({
        message: { content: [{ text: expect.stringContaining(replyText) }] },
      });
      await captureSessionControllerSettlement({
        scope: testState.sessionStorePath!,
        identities: [sessionKey],
      });
      const duplicate = await rpcReq(ws, "chat.send", {
        sessionKey,
        message: "Synthetic read-acknowledgement overlap",
        idempotencyKey: runId,
      });
      expect(duplicate).toMatchObject({ ok: true });
      expect(gatewayReplyMock).toHaveBeenCalledOnce();
      expect(
        await listSessionPendingInputs({
          agentId: "main",
          sessionKey,
          sessionId,
          storePath: testState.sessionStorePath!,
        }),
      ).toMatchObject({ total: 0 });
    } finally {
      resume.resolve();
      await Promise.allSettled([patch, final]);
      readSpy.mockRestore();
      mutationSpy.mockRestore();
    }
  },
);
