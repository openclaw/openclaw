import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";
import { type RawData, WebSocket } from "ws";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import * as acpSessionMetadata from "../acp/runtime/session-meta-readonly.js";
import type { MessagingToolSourceReplyPayload } from "../agents/embedded-agent-messaging.types.js";
import { buildSourceReplyPayloadState } from "../agents/embedded-agent-runner/run/source-reply-payloads.js";
import * as embeddedAgent from "../agents/embedded-agent.js";
import { getReplyFromConfig } from "../auto-reply/reply/get-reply.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import * as entryReads from "../config/sessions/session-entry-read-runtime.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import {
  claimAgentRunContext,
  registerAgentRunContext,
  releaseAgentRunContext,
} from "../infra/agent-run-registry.js";
import { getRpcSource } from "../sessions/session-controller.rpc-sources.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { persistInternalSourceReply } from "./internal-source-reply-persistence.js";
import { installGatewayServerChatTestSuite } from "./server.chat.gateway-server-chat.test-support.js";
import { removeChatTestDirectory as removeTempDir } from "./session-test-directories.test-support.js";
import {
  connectOk,
  dispatchInboundMessageMock,
  gatewayReplyMock,
  mockGetReplyFromConfigOnce,
  onceMessage,
  rpcReq,
  testState,
  trackConnectChallengeNonce,
  writeSessionStore,
} from "./test-helpers.js";

// Lazy reply modules must retain this same spy across cases instead of a disposed one.
const runEmbeddedAgent = vi.spyOn(embeddedAgent, "runEmbeddedAgent");
beforeEach(() => {
  runEmbeddedAgent.mockReset();
});
afterAll(() => {
  runEmbeddedAgent.mockRestore();
});

let ws: WebSocket;
let port: number;
const gatewaySuite = installGatewayServerChatTestSuite((started) => {
  ws = started.ws;
  port = started.port;
});
const {
  expectAgentWaitTimeout,
  expectRecordFields,
  sendChatAndExpectStarted,
  settleGatewayFixture,
  waitForAgentRunDrained,
  withMainSessionStore,
} = gatewaySuite;

async function openBrowser(
  id: (typeof GATEWAY_CLIENT_NAMES)[keyof typeof GATEWAY_CLIENT_NAMES] = GATEWAY_CLIENT_NAMES.CONTROL_UI,
) {
  const browser = new WebSocket(`ws://127.0.0.1:${port}`, {
    headers: { origin: `http://127.0.0.1:${port}` },
  });
  trackConnectChallengeNonce(browser);
  await new Promise<void>((resolve) => {
    browser.once("open", resolve);
  });
  await connectOk(browser, {
    client: {
      id,
      version: id === GATEWAY_CLIENT_NAMES.WEBCHAT ? "1.0.0" : "test",
      platform: id === GATEWAY_CLIENT_NAMES.WEBCHAT ? "test" : "web",
      mode: GATEWAY_CLIENT_MODES.WEBCHAT,
    },
  });
  return browser;
}

function terminalEvent(browser: WebSocket, runId: string) {
  const terminal = onceMessage(
    browser,
    (frame) =>
      frame.type === "event" &&
      frame.event === "chat" &&
      frame.payload?.runId === runId &&
      ["aborted", "error", "final"].includes(String(frame.payload?.state)),
  );
  void terminal.catch(() => undefined);
  return terminal;
}

async function expectRpc(
  browser: WebSocket,
  method: string,
  params: unknown,
  payload: Record<string, unknown>,
) {
  const response = await rpcReq(browser, method, params);
  expect(response).toMatchObject({ ok: true, payload });
}

const emitLifecycle = (runId: string, data: Record<string, unknown>) =>
  emitAgentEvent({ runId, stream: "lifecycle", data });

describe("gateway server chat lifecycle", () => {
  test("sessions.abort stops a chat before agent adoption", async () => {
    await withMainSessionStore(async (dir) => {
      const browser = await openBrowser();
      await expectRpc(browser, "sessions.subscribe", {}, { subscribed: true });

      const stoppedRunId = "pre-adoption-stop";
      const successorRunId = "after-pre-adoption-stop";
      const preparationEntered = createDeferred();
      const releasePreparation = createDeferred();
      const abortObserved = createDeferred();
      const embeddedEntered = createDeferred();
      const actualRead = entryReads.readSessionEntryInWorker;
      let heldPreparation = false;
      let replyPreparationStarted = false;
      using readSpy = vi
        .spyOn(entryReads, "readSessionEntryInWorker")
        .mockImplementation(async (...args) => {
          const entry = await actualRead(...args);
          if (!heldPreparation && replyPreparationStarted && getRpcSource(stoppedRunId) && entry) {
            heldPreparation = true;
            preparationEntered.resolve();
            await releasePreparation.promise;
          }
          return entry;
        });
      void readSpy;
      const execution = runEmbeddedAgent.mockImplementation(async () => {
        embeddedEntered.resolve();
        return { payloads: [{ text: "Synthetic successor answer" }], meta: { durationMs: 0 } };
      });
      gatewayReplyMock.mockImplementation(async (...args) => {
        const signal = args[1]?.abortSignal;
        if (signal?.aborted) {
          abortObserved.resolve();
        } else {
          signal?.addEventListener("abort", () => abortObserved.resolve(), { once: true });
        }
        replyPreparationStarted = true;
        return await getReplyFromConfig(...args);
      });

      const stoppedTerminal = terminalEvent(browser, stoppedRunId);
      try {
        await expectRpc(
          browser,
          "chat.send",
          {
            sessionKey: "main",
            message: "hold this turn before adoption",
            idempotencyKey: stoppedRunId,
          },
          { runId: stoppedRunId, status: "started" },
        );
        await preparationEntered.promise;

        const stopping = rpcReq(browser, "sessions.abort", {
          key: "main",
          clearQueued: true,
        });
        await abortObserved.promise;
        releasePreparation.resolve();
        const aborted = await stopping;
        expect(aborted).toMatchObject({
          ok: true,
          payload: { abortedRunId: stoppedRunId, status: "aborted" },
        });
        await stoppedTerminal;
        await gatewaySuite.requestExecution.waitForCompletion(stoppedRunId);
        await expectRpc(
          browser,
          "agent.wait",
          { runId: stoppedRunId, timeoutMs: 0 },
          { runId: stoppedRunId, status: "error" },
        );
        const stoppedEntry = loadSessionEntry({
          agentId: "main",
          sessionKey: "main",
          storePath: path.join(dir, "sessions.json"),
          readConsistency: "latest",
        });

        const successorTerminal = terminalEvent(browser, successorRunId);
        await expectRpc(
          browser,
          "chat.send",
          {
            sessionKey: "main",
            message: "run after the stopped pre-adoption turn",
            idempotencyKey: successorRunId,
          },
          { runId: successorRunId, status: "started" },
        );
        const terminal = await successorTerminal;
        expect(terminal.payload).toMatchObject({ runId: successorRunId, state: "final" });
        await embeddedEntered.promise;
        expect(execution).toHaveBeenCalledOnce();
        expect(stoppedEntry).toMatchObject({
          status: "killed",
          abortedLastRun: true,
          lastRunId: stoppedRunId,
        });
      } finally {
        releasePreparation.resolve();
        gatewayReplyMock.mockReset();
        await Promise.allSettled([
          stoppedTerminal,
          gatewaySuite.requestExecution.waitForCompletion(stoppedRunId),
          gatewaySuite.requestExecution.waitForCompletion(successorRunId),
        ]);
        browser.close();
      }
    });
  });

  test("chat.send replays cancellation when admission fails after its source is stopped", async () => {
    await withMainSessionStore(async () => {
      const browser = await openBrowser();
      const runId = "idem-stopped-admission-read-failure";
      const reading = createDeferred();
      const aborted = createDeferred();
      const finishRead = createDeferred();
      const actualRead = acpSessionMetadata.readAcpSessionMetaForEntries;
      using readSpy = vi
        .spyOn(acpSessionMetadata, "readAcpSessionMetaForEntries")
        .mockImplementation(async (...args) => {
          const source = getRpcSource(runId);
          if (!source) {
            return actualRead(...args);
          }
          source.input.abortSignal.addEventListener("abort", () => aborted.resolve(), {
            once: true,
          });
          reading.resolve();
          await finishRead.promise;
          throw new Error("metadata read failed after source cancellation");
        });
      void readSpy;
      const params = {
        sessionKey: "main",
        message: "do not revive this stopped input",
        idempotencyKey: runId,
      };
      const send = rpcReq(browser, "chat.send", params);
      let reset: ReturnType<typeof rpcReq> | undefined;
      try {
        await reading.promise;
        reset = rpcReq(browser, "sessions.reset", { key: "main", reason: "new" });
        await aborted.promise;
        finishRead.resolve();
        expect(await send).toMatchObject({
          ok: true,
          payload: { runId, status: "timeout", summary: "aborted" },
        });
        expect(await reset).toMatchObject({ ok: true });
        await expectRpc(browser, "chat.send", params, {
          runId,
          status: "timeout",
          summary: "aborted",
        });
        expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
      } finally {
        finishRead.resolve();
        await Promise.allSettled([send, ...(reset ? [reset] : [])]);
        browser.close();
      }
    });
  });

  test("agent.wait ignores lifecycle completion while same-runId chat.send is active", async () => {
    await withMainSessionStore(async () => {
      const runId = "idem-wait-chat-active-with-agent-lifecycle";
      const blockedReply = createDeferred();
      const runtimeStarted = createDeferred();
      mockGetReplyFromConfigOnce(async (_ctx, opts) => {
        opts?.onAgentRunStart?.(runId);
        const runtimeOwner = claimAgentRunContext(
          runId,
          {
            agentId: "main",
            projectSessionActive: true,
            sessionId: "sess-main",
            sessionKey: "agent:main:main",
          },
          { ownsContext: true, trackOwner: true },
        );
        expect(runtimeOwner).toBeDefined();
        runtimeStarted.resolve();
        try {
          await blockedReply.promise;
        } finally {
          releaseAgentRunContext(runId, runtimeOwner);
        }
      });

      try {
        const subscribeRes = await rpcReq(ws, "sessions.subscribe", {});
        expect(subscribeRes.ok).toBe(true);
        await sendChatAndExpectStarted(runId, "hold chat run open");
        // The ACK precedes dispatch; emit lifecycle only after the runtime owns this run.
        await runtimeStarted.promise;

        const terminalSessionChange = onceMessage(
          ws,
          (event) =>
            event.type === "event" &&
            event.event === "sessions.changed" &&
            event.payload?.phase === "end" &&
            event.payload?.runId === runId,
          8_000,
        );
        emitLifecycle(runId, { phase: "start", startedAt: 1 });
        emitLifecycle(runId, { phase: "end", startedAt: 1, endedAt: 2 });

        expect((await terminalSessionChange).payload?.activeRunIds).toBeNull();
        const waitWhileChatActive = await rpcReq(ws, "agent.wait", {
          runId,
          timeoutMs: 40,
        });
        expectAgentWaitTimeout(waitWhileChatActive);

        // Coalescing may replace the reason label; assert current ownership instead.
        const settledSessionChange = onceMessage(
          ws,
          (event) =>
            event.type === "event" &&
            event.event === "sessions.changed" &&
            event.payload?.sessionKey === "agent:main:main" &&
            event.payload?.hasActiveRun === false &&
            Array.isArray(event.payload?.activeRunIds) &&
            event.payload.activeRunIds.length === 0 &&
            event.payload?.lastRunId === runId,
          8_000,
        );
        blockedReply.resolve();
        const settledEvent = await settledSessionChange.catch((cause: unknown) => {
          throw new Error("Gateway did not publish settled run ownership after chat.send cleanup", {
            cause,
          });
        });
        await waitForAgentRunDrained(runId);
        expectRecordFields(settledEvent.payload, {
          activeRunIds: [],
          hasActiveRun: false,
          lastRunId: runId,
        });
      } finally {
        blockedReply.resolve();
      }
    });
  });

  test("chat.send publishes one terminal for persisted native message-tool replies", async () => {
    await withMainSessionStore(async () => {
      const runId = "idem-message-tool-owned-terminal";
      const sessionKey = "agent:main:main";
      const answer = "Both subagents finished.";
      const terminals: Array<Record<string, unknown>> = [];
      const collectTerminal = (data: RawData) => {
        const frame = JSON.parse(rawDataToString(data)) as {
          event?: string;
          payload?: Record<string, unknown>;
        };
        if (
          frame.event === "chat" &&
          frame.payload?.runId === runId &&
          ["aborted", "error", "final"].includes(String(frame.payload.state))
        ) {
          terminals.push(frame.payload);
        }
      };
      const execution = runEmbeddedAgent.mockImplementation(async (params) => {
        expect(params).toMatchObject({ deferTerminalLifecycle: true, sessionKey });
        const publish = async (
          stream: "lifecycle" | "assistant",
          data: Record<string, unknown>,
        ) => {
          await params.onAgentEvent?.({ stream, data });
          emitAgentEvent({ runId, stream, data });
        };
        await publish("lifecycle", { phase: "start", startedAt: 1 });
        const sourceReply = (
          text: string,
          sourceReplyFinal: boolean,
        ): MessagingToolSourceReplyPayload => ({
          text,
          sourceReplyFinal,
          transcriptOwner: true,
          idempotencyKey: `${runId}:${sourceReplyFinal ? "final" : "progress"}`,
        });
        const payloads = [
          sourceReply("Both A and B are still running.", false),
          sourceReply(answer, true),
        ];
        for (const payload of payloads) {
          await persistInternalSourceReply({
            cfg: params.config ?? {},
            sessionKey,
            expectedSessionId: params.sessionId,
            agentId: "main",
            payload: { text: payload.text },
            runId,
            idempotencyKey: payload.idempotencyKey,
            sourceReplyFinal: payload.sourceReplyFinal,
          });
        }
        await publish("assistant", { text: answer, delta: answer });
        // The real native caller owns the terminal after the attempt's finishing event.
        await publish("lifecycle", { phase: "finishing", startedAt: 1, endedAt: 2 });
        return {
          sourceReplyDeliveryState: "delivered" as const,
          messagingToolSourceReplyPayloads: payloads,
          payloads: buildSourceReplyPayloadState({
            payloads,
            runId,
            sessionKey,
            agentId: "main",
          }).replyItems,
          meta: {
            durationMs: 1,
            terminalReply: { disposition: "visible" as const, text: answer },
            finalAssistantVisibleText: answer,
          },
        };
      });
      mockGetReplyFromConfigOnce((...args) => getReplyFromConfig(...args));

      expect((await rpcReq(ws, "sessions.subscribe", {})).ok).toBe(true);
      ws.on("message", collectTerminal);
      try {
        await sendChatAndExpectStarted(runId, "check on the subagents");
        await waitForAgentRunDrained(runId);
      } finally {
        ws.off("message", collectTerminal);
      }

      expect(execution).toHaveBeenCalledOnce();
      expect(terminals, JSON.stringify(terminals)).toHaveLength(1);
      expect(terminals[0]).toMatchObject({
        state: "final",
        message: { content: [{ type: "text", text: answer }] },
      });
    });
  });

  test("agent events include sessionKey and agent.wait preserves lifecycle metadata", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gw-"));
    testState.sessionStorePath = path.join(dir, "sessions.json");
    await writeSessionStore({
      entries: {
        main: { sessionId: "sess-main", updatedAt: Date.now(), verboseLevel: "off" },
      },
    });
    const webchatWs = await openBrowser(GATEWAY_CLIENT_NAMES.WEBCHAT);
    try {
      registerAgentRunContext("run-tool-1", {
        sessionKey: "main",
        verboseLevel: "on",
      });

      {
        const agentEvtP = onceMessage(
          webchatWs,
          (o) => o.type === "event" && o.event === "agent" && o.payload?.runId === "run-tool-1",
          8000,
        );

        emitAgentEvent({
          runId: "run-tool-1",
          stream: "assistant",
          data: { text: "hello" },
        });

        const evt = await agentEvtP;
        const payload = evt.payload && typeof evt.payload === "object" ? evt.payload : {};
        expect(payload).toMatchObject({ sessionKey: "main", stream: "assistant" });
      }

      const agentJobs = await import("./agent-turn/agent-job.js");
      for (const cached of [false, true]) {
        const terminalRunId = `run-wait-terminal-${cached}`;
        const terminal = { phase: "end", startedAt: 200, endedAt: 210 };
        const registered = createDeferred();
        const waitForJob = agentJobs.waitForAgentJob;
        using waitSpy = vi.spyOn(agentJobs, "waitForAgentJob").mockImplementationOnce((params) => {
          const pending = waitForJob(params);
          registered.resolve();
          return pending;
        });
        void waitSpy;
        if (cached) {
          emitLifecycle(terminalRunId, terminal);
        }
        const terminalWait = rpcReq(webchatWs, "agent.wait", {
          runId: terminalRunId,
          timeoutMs: 200,
        });
        if (!cached) {
          await awaitGateBeforeSettlement(
            registered.promise,
            terminalWait,
            "agent.wait settled before registering its waiter",
          );
          emitLifecycle(terminalRunId, terminal);
        }
        expect(await terminalWait).toMatchObject({
          ok: true,
          payload: { status: "ok", startedAt: 200, endedAt: 210 },
        });
      }
      expect(
        await rpcReq(webchatWs, "agent.wait", { runId: "run-wait-empty", timeoutMs: 30 }),
      ).toMatchObject({
        ok: true,
        payload: { status: "timeout" },
      });
      const runId = "run-wait-start";
      const waiting = rpcReq(webchatWs, "agent.wait", { runId, timeoutMs: 200 });
      emitLifecycle(runId, { phase: "start", startedAt: 123 });
      queueMicrotask(() => emitLifecycle(runId, { phase: "end", endedAt: 456 }));
      expect(await waiting).toMatchObject({
        ok: true,
        payload: { status: "ok", startedAt: 123, endedAt: 456 },
      });
      const pendingError = rpcReq(webchatWs, "agent.wait", {
        runId: "run-wait-err",
        timeoutMs: 50,
      });
      queueMicrotask(() => emitLifecycle("run-wait-err", { phase: "error", error: "boom" }));
      expect(await pendingError).toMatchObject({
        ok: true,
        payload: { status: "timeout", error: "boom", pendingError: true },
      });
    } finally {
      await settleGatewayFixture();
      webchatWs.close();
      await removeTempDir(dir);
      testState.sessionStorePath = undefined;
    }
  });
});
