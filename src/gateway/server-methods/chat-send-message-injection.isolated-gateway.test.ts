import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { RawData, WebSocket } from "ws";
import { installQueueRuntimeErrorSilencer } from "../../auto-reply/reply/queue.test-helpers.js";
import * as replyRunRegistryModule from "../../auto-reply/reply/reply-run-registry.js";
import { createReplyOperation } from "../../auto-reply/reply/reply-run-registry.operation.js";
import { replyRunRegistry } from "../../auto-reply/reply/reply-run-registry.registry.js";
import { forceClearReplyOperation } from "../../auto-reply/reply/reply-run-registry.state.js";
import {
  dispatchInboundMessageMock,
  installGatewayTestHooks,
  mockGetReplyFromConfigOnce,
  rpcReq,
  testState,
  writeSessionStore,
} from "../test-helpers.js";
import { installConnectedControlUiServerSuite } from "../test-with-server.js";

installGatewayTestHooks({ scope: "suite" });
installQueueRuntimeErrorSilencer();

const SESSION_KEY = "agent:main:main";
const SOURCE_TURN_ID = "source-failclosed-1";

type WireResponse = {
  ok: boolean;
  payload?: { status?: string; runId?: string; message?: string };
  error?: { message?: string; code?: string };
};

type DispatchInboundParams = {
  dispatcher: {
    sendFinalReply: (payload: { text: string }) => boolean;
    markComplete: () => void;
    waitForIdle: () => Promise<void>;
  };
};

const dispatchCapture = { calls: 0 };
const resolverCapture: {
  calls: number;
  ctxBody?: string;
  runId?: string;
  messageInjectionDisposition?: unknown;
} = { calls: 0 };

type ChatWirePayload = {
  runId?: string;
  state?: string;
  message?: { text?: string; content?: unknown };
};

function visibleMessageText(message: unknown): string {
  if (!message || typeof message !== "object") {
    return "";
  }
  const rec = message as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof rec.text === "string") {
    parts.push(rec.text);
  }
  if (Array.isArray(rec.content)) {
    for (const block of rec.content) {
      if (block && typeof block === "object") {
        const text = (block as Record<string, unknown>).text;
        if (typeof text === "string") {
          parts.push(text);
        }
      }
    }
  }
  return parts.join(" ");
}

let ws: WebSocket;
const sharedTempDirs: string[] = [];
let liveOperation: ReturnType<typeof createReplyOperation> | undefined;

installConnectedControlUiServerSuite((started) => {
  ws = started.ws;
});

function clearLiveOperation(cause: string) {
  if (liveOperation) {
    try {
      forceClearReplyOperation(liveOperation, cause);
    } catch {
      // Best-effort cleanup of an operation left behind by a failed test.
    }
    liveOperation = undefined;
  }
}

beforeEach(() => {
  dispatchInboundMessageMock.mockReset();
  dispatchCapture.calls = 0;
  resolverCapture.calls = 0;
  delete resolverCapture.ctxBody;
  delete resolverCapture.runId;
  delete resolverCapture.messageInjectionDisposition;
  clearLiveOperation("test-cleanup");
  dispatchInboundMessageMock.mockImplementation(async (params: unknown) => {
    const p = params as DispatchInboundParams;
    dispatchCapture.calls += 1;
    p.dispatcher.sendFinalReply({ text: "after-fix follow-up reply" });
    p.dispatcher.markComplete();
    await p.dispatcher.waitForIdle();
    return { queuedFinal: true, counts: { final: 1, block: 0, tool: 0 } };
  });
});

async function seedActiveTurn(params: {
  sessionKey: string;
  sessionId: string;
  runId: string;
  terminalRunId: string;
  sourceTurnId?: string;
  deliverySourceRunId?: string;
}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-iso-gw-"));
  sharedTempDirs.push(dir);
  testState.sessionStorePath = path.join(dir, "sessions.json");
  await writeSessionStore({
    entries: {
      [params.sessionKey]: {
        sessionId: params.sessionId,
        updatedAt: Date.now(),
        restartRecoveryTerminalRunIds: [params.terminalRunId],
        ...(params.deliverySourceRunId
          ? { restartRecoveryDeliverySourceRunId: params.deliverySourceRunId }
          : {}),
        status: "running",
      },
    },
  });
  const operation = createReplyOperation({
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    resetTriggered: false,
  });
  liveOperation = operation;
  operation.setPhase("running");
  operation.attachBackend({
    kind: "embedded",
    runId: params.runId,
    cancel: () => {},
    isStreaming: () => false,
    messageInjection: {
      isAvailable: () => true,
      queueMessage: async () => {},
    },
  });
  if (params.sourceTurnId) {
    replyRunRegistry.bindSourceTurnId(operation, params.sourceTurnId);
  }
}

afterAll(async () => {
  clearLiveOperation("test-cleanup-final");
  for (const dir of sharedTempDirs.splice(0)) {
    // Defer removal until Gateway teardown; Windows may still hold SQLite handles.
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
  testState.sessionStorePath = undefined;
});

describe("terminal-receipt steer fence isolated-gateway proof (#128971)", () => {
  it.each([
    {
      name: "a tombstone for the active source",
      sessionKey: SESSION_KEY,
      sessionId: "session-failclosed",
      runId: "live-run-failclosed",
      terminalRunId: SOURCE_TURN_ID,
      sourceTurnId: SOURCE_TURN_ID,
      deliverySourceRunId: SOURCE_TURN_ID,
      message: "round-8 isolated-gateway inbound",
      replyText: "after-fix follow-up reply from the production dispatcher",
    },
    {
      name: "a retained tombstone with unknown active source identity",
      sessionKey: "agent:main:unknown-source",
      sessionId: "session-unknown-source",
      runId: "live-run-unknown-source",
      terminalRunId: "source-old",
      message: "unknown-source isolated-gateway inbound",
      replyText: "unknown-source follow-up reply from the production dispatcher",
    },
  ])(
    "$name rejects steering and delivers exactly one follow-up reply over the real transport",
    { timeout: 30_000 },
    async (scenario) => {
      await seedActiveTurn(scenario);
      const registrySpy = vi.spyOn(replyRunRegistryModule, "beginReplyMessageInjectionTarget");

      // Resetting this seam uses the production dispatcher and delivery owner;
      // only the reply source is controlled. Observe its final on the real socket.
      dispatchInboundMessageMock.mockReset();
      mockGetReplyFromConfigOnce(async (ctx, opts) => {
        resolverCapture.calls += 1;
        resolverCapture.ctxBody = (ctx as { Body?: string }).Body;
        const options = (opts ?? {}) as { runId?: string; messageInjectionDisposition?: unknown };
        resolverCapture.runId = options.runId;
        resolverCapture.messageInjectionDisposition = options.messageInjectionDisposition;
        return { text: scenario.replyText };
      });

      const runId = `idem-iso-gw-${randomUUID()}`;
      const chatFrames: ChatWirePayload[] = [];
      const onChatFrame = (raw: RawData) => {
        try {
          const frame = JSON.parse(rawDataToString(raw)) as {
            type?: string;
            event?: string;
            payload?: ChatWirePayload;
          };
          if (frame.type === "event" && frame.event === "chat" && frame.payload?.runId === runId) {
            chatFrames.push(frame.payload);
          }
        } catch {
          // Unrelated frames on the shared test socket.
        }
      };
      ws.on("message", onChatFrame);
      try {
        const res = (await rpcReq(
          ws,
          "chat.send",
          {
            sessionKey: scenario.sessionKey,
            message: scenario.message,
            idempotencyKey: runId,
            queueMode: "steer",
          },
          20_000,
        )) as WireResponse;

        expect(res.ok).toBe(true);
        expect(res.payload?.status).toBe("started");
        expect(res.payload?.runId).toBe(runId);
        expect(registrySpy).not.toHaveBeenCalled();
        await vi.waitFor(() => expect(resolverCapture.calls).toBe(1), {
          interval: 50,
          timeout: 15_000,
        });
        expect(resolverCapture.ctxBody).toBe(scenario.message);
        expect(resolverCapture.runId).toBe(runId);
        expect(resolverCapture.messageInjectionDisposition).toBe("rejected");
        expect(dispatchCapture.calls).toBe(0);

        await vi.waitFor(
          () => {
            expect(chatFrames.some((frame) => frame.state === "final")).toBe(true);
          },
          { interval: 50, timeout: 15_000 },
        );
        // Quiet-period check: no second terminal may follow the first.
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 300);
        });
        const finals = chatFrames.filter((frame) => frame.state === "final");
        expect(finals.length).toBe(1);
        expect(visibleMessageText(finals[0]?.message)).toContain(scenario.replyText);
      } finally {
        ws.off("message", onChatFrame);
      }
      registrySpy.mockRestore();
    },
  );

  it(
    "isolated gateway: still steers when the tombstone belongs to an unrelated prior source turn",
    { timeout: 30_000 },
    async () => {
      await seedActiveTurn({
        sessionKey: SESSION_KEY,
        sessionId: "session-unrelated",
        runId: "live-run-unrelated",
        terminalRunId: "source-old",
        sourceTurnId: SOURCE_TURN_ID,
      });
      const registrySpy = vi
        .spyOn(replyRunRegistryModule, "beginReplyMessageInjectionTarget")
        .mockImplementation(() => ({
          targetRunId: "live-run-unrelated",
          acceptance: Promise.resolve(true),
          outcome: Promise.resolve({ status: "accepted" as const }),
        }));

      const runId = `idem-iso-gw-unrelated-${randomUUID()}`;
      const res = (await rpcReq(
        ws,
        "chat.send",
        {
          sessionKey: SESSION_KEY,
          message: "unrelated-tombstone inbound",
          idempotencyKey: runId,
          queueMode: "steer",
        },
        20_000,
      )) as WireResponse;

      expect(res.ok).toBe(true);
      expect(res.payload?.status).toBe("started");
      expect(registrySpy).toHaveBeenCalledTimes(1);
      expect(dispatchCapture.calls).toBe(0);
      registrySpy.mockRestore();
    },
  );
});
