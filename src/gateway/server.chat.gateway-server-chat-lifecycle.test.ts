import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { afterAll, beforeEach, describe, expect, test, vi } from "vitest";
import { type RawData, WebSocket } from "ws";
import { createDeferred } from "../../test/helpers/promise.js";
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
  expectAgentWaitStartedAt,
  expectAgentWaitTimeout,
  expectRecordFields,
  sendChatAndExpectStarted,
  settleGatewayFixture,
  waitForAgentRunDrained,
  withMainSessionStore,
} = gatewaySuite;

describe("gateway server chat lifecycle", () => {
  test("sessions.abort terminalizes a restart-safe chat before agent adoption", async () => {
    await withMainSessionStore(async (dir) => {
      const browser = new WebSocket(`ws://127.0.0.1:${port}`, {
        headers: { origin: `http://127.0.0.1:${port}` },
      });
      trackConnectChallengeNonce(browser);
      await new Promise<void>((resolve) => {
        browser.once("open", resolve);
      });
      await connectOk(browser, {
        client: {
          id: GATEWAY_CLIENT_NAMES.CONTROL_UI,
          version: "test",
          platform: "web",
          mode: GATEWAY_CLIENT_MODES.WEBCHAT,
        },
      });
      expect(await rpcReq(browser, "sessions.subscribe", {})).toMatchObject({
        ok: true,
        payload: { subscribed: true },
      });

      const stoppedRunId = "restart-safe-pre-adoption-stop";
      const successorRunId = "restart-safe-after-pre-adoption-stop";
      const preparationEntered = createDeferred();
      const releasePreparation = createDeferred();
      const abortObserved = createDeferred();
      const embeddedEntered = createDeferred();
      const actualRead = entryReads.readSessionEntryInWorker;
      let heldPreparation = false;
      using readSpy = vi
        .spyOn(entryReads, "readSessionEntryInWorker")
        .mockImplementation(async (...args) => {
          const entry = await actualRead(...args);
          if (
            !heldPreparation &&
            entry?.restartRecoveryDeliveryRunId === stoppedRunId &&
            entry.restartRecoveryDeliverySourceRunId === stoppedRunId
          ) {
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
        return await getReplyFromConfig(...args);
      });

      const stoppedTerminal = onceMessage(
        browser,
        (frame) =>
          frame.type === "event" &&
          frame.event === "chat" &&
          frame.payload?.runId === stoppedRunId &&
          ["aborted", "error", "final"].includes(String(frame.payload?.state)),
      );
      void stoppedTerminal.catch(() => undefined);
      try {
        const accepted = await rpcReq(browser, "chat.send", {
          sessionKey: "main",
          message: "hold this restart-safe turn before adoption",
          idempotencyKey: stoppedRunId,
        });
        expect(accepted).toMatchObject({
          ok: true,
          payload: { runId: stoppedRunId, status: "started" },
        });
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
        expect(
          await rpcReq(browser, "agent.wait", { runId: stoppedRunId, timeoutMs: 0 }),
        ).toMatchObject({ ok: true, payload: { runId: stoppedRunId, status: "error" } });
        const stoppedEntry = loadSessionEntry({
          agentId: "main",
          sessionKey: "main",
          storePath: path.join(dir, "sessions.json"),
          readConsistency: "latest",
        });

        const successorTerminal = onceMessage(
          browser,
          (frame) =>
            frame.type === "event" &&
            frame.event === "chat" &&
            frame.payload?.runId === successorRunId &&
            ["aborted", "error", "final"].includes(String(frame.payload?.state)),
        );
        void successorTerminal.catch(() => undefined);
        const successor = await rpcReq(browser, "chat.send", {
          sessionKey: "main",
          message: "run after the stopped pre-adoption turn",
          idempotencyKey: successorRunId,
        });
        expect(successor).toMatchObject({
          ok: true,
          payload: { runId: successorRunId, status: "started" },
        });
        const terminal = await successorTerminal;
        expect(terminal.payload).toMatchObject({ runId: successorRunId, state: "final" });
        await embeddedEntered.promise;
        expect(execution).toHaveBeenCalledOnce();
        expect(stoppedEntry).toMatchObject({
          status: "killed",
          abortedLastRun: true,
          lastRunId: stoppedRunId,
          restartRecoveryTerminalRunIds: expect.arrayContaining([stoppedRunId]),
        });
        expect(stoppedEntry?.restartRecoveryDeliveryRunId).toBeUndefined();
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
      const browser = new WebSocket(`ws://127.0.0.1:${port}`, {
        headers: { origin: `http://127.0.0.1:${port}` },
      });
      trackConnectChallengeNonce(browser);
      await new Promise<void>((resolve) => {
        browser.once("open", resolve);
      });
      await connectOk(browser, {
        client: {
          id: GATEWAY_CLIENT_NAMES.CONTROL_UI,
          version: "test",
          platform: "web",
          mode: GATEWAY_CLIENT_MODES.WEBCHAT,
        },
      });
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
        const replay = await rpcReq(browser, "chat.send", params);
        expect(replay).toMatchObject({
          ok: true,
          payload: { runId, status: "timeout", summary: "aborted" },
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
        emitAgentEvent({
          runId,
          stream: "lifecycle",
          data: { phase: "start", startedAt: 1 },
        });
        emitAgentEvent({
          runId,
          stream: "lifecycle",
          data: { phase: "end", startedAt: 1, endedAt: 2 },
        });

        expect((await terminalSessionChange).payload?.activeRunIds).toBeNull();
        const waitWhileChatActive = await rpcReq(ws, "agent.wait", {
          runId,
          timeoutMs: 40,
        });
        expectAgentWaitTimeout(waitWhileChatActive);

        // Match the published ownership fact, not the `reason` label: sessions.changed
        // coalesces bursts per session key and keeps only the newest payload, so any
        // same-key mutation inside that window legitimately replaces the label while
        // the row (activeRunIds/lastRunId) is still rebuilt at broadcast time.
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
        expect(params.deferTerminalLifecycle).toBe(true);
        expect(params.sessionKey).toBe(sessionKey);
        const start = { stream: "lifecycle" as const, data: { phase: "start", startedAt: 1 } };
        await params.onAgentEvent?.(start);
        emitAgentEvent({ runId, ...start });
        const payloads = [
          {
            text: "Both A and B are still running.",
            sourceReplyFinal: false,
            idempotencyKey: `${runId}:progress`,
            transcriptOwner: true,
          },
          {
            text: answer,
            sourceReplyFinal: true,
            idempotencyKey: `${runId}:final`,
            transcriptOwner: true,
          },
        ] satisfies MessagingToolSourceReplyPayload[];
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
        const assistant = { stream: "assistant" as const, data: { text: answer, delta: answer } };
        await params.onAgentEvent?.(assistant);
        emitAgentEvent({ runId, ...assistant });
        // The real native caller owns the terminal after the attempt's finishing event.
        const finishing = {
          stream: "lifecycle" as const,
          data: { phase: "finishing", startedAt: 1, endedAt: 2 },
        };
        await params.onAgentEvent?.(finishing);
        emitAgentEvent({ runId, ...finishing });
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

  test("agent events include sessionKey and agent.wait covers lifecycle flows", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gw-"));
    testState.sessionStorePath = path.join(dir, "sessions.json");
    await writeSessionStore({
      entries: {
        main: {
          sessionId: "sess-main",
          updatedAt: Date.now(),
          verboseLevel: "off",
        },
      },
    });

    const webchatWs = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { origin: `http://127.0.0.1:${port}` },
    });
    trackConnectChallengeNonce(webchatWs);
    await new Promise<void>((resolve) => {
      webchatWs.once("open", resolve);
    });
    await connectOk(webchatWs, {
      client: {
        id: GATEWAY_CLIENT_NAMES.WEBCHAT,
        version: "1.0.0",
        platform: "test",
        mode: GATEWAY_CLIENT_MODES.WEBCHAT,
      },
    });

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
        expect(payload.sessionKey).toBe("main");
        expect(payload.stream).toBe("assistant");
      }

      {
        const waitP = rpcReq(webchatWs, "agent.wait", {
          runId: "run-wait-1",
          timeoutMs: 200,
        });

        queueMicrotask(() => {
          emitAgentEvent({
            runId: "run-wait-1",
            stream: "lifecycle",
            data: { phase: "end", startedAt: 200, endedAt: 210 },
          });
        });

        const res = await waitP;
        expectAgentWaitStartedAt(res, 200);
      }

      {
        emitAgentEvent({
          runId: "run-wait-early",
          stream: "lifecycle",
          data: { phase: "end", startedAt: 50, endedAt: 55 },
        });

        const res = await rpcReq(webchatWs, "agent.wait", {
          runId: "run-wait-early",
          timeoutMs: 200,
        });
        expect(res.ok).toBe(true);
        expect(res.payload?.status).toBe("ok");
        expect(res.payload?.startedAt).toBe(50);
      }

      {
        const res = await rpcReq(webchatWs, "agent.wait", {
          runId: "run-wait-3",
          timeoutMs: 30,
        });
        expectAgentWaitTimeout(res);
      }

      {
        const waitP = rpcReq(webchatWs, "agent.wait", {
          runId: "run-wait-err",
          timeoutMs: 50,
        });

        queueMicrotask(() => {
          emitAgentEvent({
            runId: "run-wait-err",
            stream: "lifecycle",
            data: { phase: "error", error: "boom" },
          });
        });

        const res = await waitP;
        expectAgentWaitTimeout(res, "boom");
      }

      {
        const waitP = rpcReq(webchatWs, "agent.wait", {
          runId: "run-wait-start",
          timeoutMs: 200,
        });

        emitAgentEvent({
          runId: "run-wait-start",
          stream: "lifecycle",
          data: { phase: "start", startedAt: 123 },
        });

        queueMicrotask(() => {
          emitAgentEvent({
            runId: "run-wait-start",
            stream: "lifecycle",
            data: { phase: "end", endedAt: 456 },
          });
        });

        const res = await waitP;
        expectAgentWaitStartedAt(res, 123);
        expect(res.payload?.endedAt).toBe(456);
      }
    } finally {
      await settleGatewayFixture();
      webchatWs.close();
      await removeTempDir(dir);
      testState.sessionStorePath = undefined;
    }
  });
});
