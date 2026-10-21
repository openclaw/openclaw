import fs from "node:fs/promises";
import path from "node:path";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { type RawData, WebSocket } from "ws";
import { createDeferred } from "../../test/helpers/promise.js";
import * as acpSessionMetadata from "../acp/runtime/session-meta-readonly.js";
import type { MessagingToolSourceReplyPayload } from "../agents/embedded-agent-messaging.types.js";
import { buildSourceReplyPayloadState } from "../agents/embedded-agent-runner/run/source-reply-payloads.js";
import * as embeddedAgent from "../agents/embedded-agent.js";
import * as harnessRegistry from "../agents/harness/registry.js";
import { getReplyFromConfig } from "../auto-reply/reply/get-reply.js";
import { loadSessionEntry, updateSessionEntry } from "../config/sessions/session-accessor.js";
import * as entryReads from "../config/sessions/session-entry-read-runtime.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import {
  claimAgentRunContext,
  registerAgentRunContext,
  releaseAgentRunContext,
} from "../infra/agent-run-registry.js";
import { getActiveGatewayRootWorkCount } from "../process/gateway-work-admission.js";
import { getRpcSource } from "../sessions/session-controller.rpc-sources.js";
import { extractFirstTextBlock } from "../shared/chat-message-content.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { persistInternalSourceReply } from "./internal-source-reply-persistence.js";
import { installGatewayServerChatTestSuite } from "./server.chat.gateway-server-chat.test-support.js";
import { collectHistoryTextValues } from "./session-history-fixtures.test-support.js";
import {
  connectOk,
  dispatchInboundMessageMock,
  gatewayReplyMock,
  mockGetReplyFromConfigOnce,
  onceMessage,
  rpcReq,
  testState,
  trackConnectChallengeNonce,
} from "./test-helpers.js";
import { agentCommandMock } from "./test-helpers.runtime-state.js";

let ws: WebSocket;
let port: number;

const connectWork: Promise<unknown>[] = [];
let joinedConnectWork = 0;
let restoreConnectWork: (() => void) | undefined;

const waitForConnectWork = async () => {
  while (joinedConnectWork < connectWork.length) {
    // A producer can register catalog tails before releasing its own root.
    const pending = connectWork.slice(joinedConnectWork);
    joinedConnectWork = connectWork.length;
    await Promise.allSettled(pending);
  }
};

// Install before this suite opens either socket; delegate all admission to its real owner.
beforeAll(async () => {
  const admission = await import("../process/gateway-work-admission.js");
  const beginRoot = admission.tryBeginGatewayRootWorkAdmission;
  const runIndependent = admission.runWithGatewayIndependentRootWorkAdmission;
  const producers = vi
    .spyOn(admission, "tryBeginGatewayRootWorkAdmission")
    .mockImplementation((origin) => {
      const lease = beginRoot(origin);
      // Handler completion can precede release of retained request work.
      return lease && (origin === "ws:connect" || origin === "ws:chat.send")
        ? {
            ...lease,
            run: (run) =>
              lease.run(() => {
                const released = createDeferred<"settled" | "reset">();
                const observeRelease = admission.captureGatewayRootWorkReleaseObserver();
                if (!observeRelease) {
                  throw new Error("connect producer must retain its admitted root");
                }
                observeRelease(released.resolve);
                connectWork.push(released.promise);
                return run();
              }),
          }
        : lease;
    });
  const tails = vi
    .spyOn(admission, "runWithGatewayIndependentRootWorkAdmission")
    .mockImplementation((run, origin, signal) => {
      const pending = runIndependent(run, origin, signal);
      if (origin === "ws:preauth") {
        connectWork.push(pending);
      }
      return pending;
    });
  restoreConnectWork = () => {
    tails.mockRestore();
    producers.mockRestore();
  };
});
beforeEach(waitForConnectWork);
afterAll(async () => {
  try {
    await waitForConnectWork();
  } finally {
    restoreConnectWork?.();
  }
});

const gatewaySuite = installGatewayServerChatTestSuite((started) => {
  ws = started.ws;
  port = started.port;
}, waitForConnectWork);
const {
  abortChatRun,
  expectAgentWaitTimeout,
  expectRecordFields,
  request,
  sendChat,
  mockBlockedChatReply,
  sendChatAndExpectStarted,
  settleGatewayFixture,
  waitForAgentRunDrained,
  waitForEvent,
  withMainSessionStore,
} = gatewaySuite;

const sessionStorePath = () => expectDefined(testState.sessionStorePath, "session store path");
const sessionEntry = (sessionKey = "agent:main:main") =>
  loadSessionEntry({ sessionKey, storePath: sessionStorePath() });

async function withOperator(scopes: string[], run: (socket: WebSocket) => Promise<void>) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  trackConnectChallengeNonce(socket);
  try {
    await new Promise<void>((resolve) => {
      socket.once("open", resolve);
    });
    await connectOk(socket, { scopes });
    await run(socket);
  } finally {
    socket.close();
  }
}

async function useRealReply() {
  const { withFullRuntimeReplyConfig } = await import("../auto-reply/reply/get-reply-fast-path.js");
  mockGetReplyFromConfigOnce((ctx, opts, cfg) =>
    getReplyFromConfig(ctx, opts, cfg ? withFullRuntimeReplyConfig(cfg) : cfg),
  );
}

async function sendUntilTerminal(
  socket: WebSocket,
  runId: string,
  message: string,
  states: string[],
) {
  const terminal = terminalEvent(socket, runId, states);
  const [sent, settled] = await Promise.all([sendChat(runId, message, {}, socket), terminal]);
  expect(sent.ok).toBe(true);
  return { sent, settled };
}

async function history(socket: WebSocket) {
  const response = await rpcReq<{
    sessionId?: string;
    messages?: Array<{ role?: string; content?: unknown }>;
  }>(socket, "chat.history", { sessionKey: "main" });
  expect(response.ok).toBe(true);
  return response.payload;
}

const waitForRun = (socket: WebSocket, runId: string, timeoutMs = 1_000) =>
  rpcReq(socket, "agent.wait", { runId, timeoutMs });
async function startAgent(runId: string, sessionKey = "main") {
  expect(
    await rpcReq(ws, "agent", { sessionKey, message: "hold this run open", idempotencyKey: runId }),
  ).toMatchObject({ ok: true, payload: { status: "accepted" } });
}

test.for([
  { field: "verboseLevel", message: "/verbose full", thinking: undefined, scoped: true },
  { field: "thinkingLevel", message: "hello from phone", thinking: "low", scoped: false },
] as const)(
  "chat.send does not persist $field metadata",
  async ({ field, message, thinking, scoped }) => {
    await withMainSessionStore(async () => {
      const run = async (socket: WebSocket) => {
        const idempotencyKey = `idem-chat-${field}-no-persist`;
        await request(
          "chat.send",
          { sessionKey: "main", message, thinking, idempotencyKey },
          undefined,
          socket,
        );
        await waitForAgentRunDrained(idempotencyKey, socket);
        expect(sessionEntry()?.[field]).toBeUndefined();
        if (!scoped) {
          expect(sessionEntry("main")?.[field]).toBeUndefined();
        }
      };
      if (scoped) {
        await withOperator(["operator.write"], run);
      } else {
        await run(ws);
      }
    });
  },
);

test("chat.send preserves sessions and denies operator.write reset triggers", async () => {
  const message = "/reset soft Create a note";
  await useRealReply();
  const replyRun = await import("../auto-reply/reply/get-reply-run.js");
  using runSpy = vi.spyOn(replyRun, "runPreparedReply").mockResolvedValue(undefined);
  // Keep real command/session dispatch; only intercept the model-run boundary.
  await withMainSessionStore(async () => {
    const resetState = {
      lifecycleRevision: "before-reset",
      cliSessionIds: { "claude-cli": "existing-cli-binding" },
    };
    expect(
      await updateSessionEntry(
        { sessionKey: "agent:main:main", storePath: sessionStorePath() },
        () => resetState,
      ),
    ).not.toBeNull();
    await withOperator(["operator.read", "operator.write"], async (scopedWs) => {
      const runId = `idem-write-scope-reset-${message}`;
      const { sent: sendRes, settled: final } = await sendUntilTerminal(scopedWs, runId, message, [
        "final",
      ]);
      expect(sendRes).toMatchObject({ ok: true, payload: { status: "started" } });

      expect(await waitForRun(scopedWs, runId)).toMatchObject({
        ok: true,
        payload: { status: "ok" },
      });

      expect(sessionEntry()).toMatchObject({ sessionId: "sess-main", ...resetState });
      expect(runSpy).not.toHaveBeenCalled();
      const denial = extractFirstTextBlock(final.payload?.message);
      expect(denial).toMatch(/not authorized/i);
      expect(denial).toContain("operator.admin");
      const stored = await history(scopedWs);
      expect(stored?.sessionId).toBe("sess-main");
      expect(collectHistoryTextValues(stored?.messages ?? [])).toContain(denial);
    });
  });
});

test("chat.send /reset on an idle session finishes post-commit cleanup and records the turn", async () => {
  await useRealReply();
  // Observe the harness reset that initSessionState runs after the reset commits.
  using harnessReset = vi.spyOn(harnessRegistry, "resetRegisteredAgentHarnessSessions");
  await withMainSessionStore(async () => {
    const runId = "idem-admin-reset-idle";
    const { settled } = await sendUntilTerminal(ws, runId, "/reset", ["final", "error"]);
    await waitForAgentRunDrained(runId);

    expect(settled.payload?.state).toBe("final");
    expect(extractFirstTextBlock(settled.payload?.message) ?? "").toContain("Session reset");
    expect(harnessReset).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: "sess-main", sessionKey: "agent:main:main" }),
    );
    const stored = await history(ws);
    expect(stored?.messages?.filter((message) => message.role === "user")).toMatchObject([
      { content: "/reset" },
    ]);
  });
});

test.for(["agent", "chat"] as const)(
  "agent.wait ignores stale results while same-runId %s is active",
  async (active) => {
    const runId = `idem-wait-active-${active}`;
    await withMainSessionStore(
      async () => {
        const blocked = createDeferred();
        let release = blocked.resolve;
        if (active === "agent") {
          vi.mocked(agentCommandMock).mockImplementationOnce(async () => {
            await blocked.promise;
            return undefined;
          });
        }
        try {
          if (active === "agent") {
            await sendChatAndExpectStarted(runId);
            await waitForAgentRunDrained(runId);
            await startAgent(runId);
          } else {
            await startAgent(runId, "agent:main:stale-wait-snapshot");
            expect(await waitForRun(ws, runId)).toMatchObject({
              ok: true,
              payload: { status: "ok" },
            });
            await gatewaySuite.requestExecution.waitForCompletion(runId);
            release = mockBlockedChatReply();
            await sendChatAndExpectStarted(runId, "hold chat run open");
          }
          expectAgentWaitTimeout(await waitForRun(ws, runId, 40));
          if (active === "agent") {
            release();
            await waitForAgentRunDrained(runId);
          } else {
            await abortChatRun(runId);
          }
        } finally {
          release();
        }
      },
      { freshStore: active === "agent" },
    );
  },
);

test("retains the session fixture while admitted dispatch settles after callback failure", async () => {
  const runId = "idem-fixture-dispatch-throw";
  const dispatchStarted = createDeferred();
  const releaseDispatch = createDeferred();
  const callbackFinished = createDeferred();
  const callbackError = new Error("fixture callback failed");
  let fixtureDir = "";
  let storePath = "";
  dispatchInboundMessageMock.mockImplementationOnce(async () => {
    dispatchStarted.resolve();
    await releaseDispatch.promise;
    return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
  });
  const fixture = withMainSessionStore(
    async (dir) => {
      fixtureDir = dir;
      storePath = path.join(dir, "sessions.json");
      try {
        await sendChatAndExpectStarted(runId, "hold fixture dispatch open");
        await dispatchStarted.promise;
        throw callbackError;
      } finally {
        callbackFinished.resolve();
      }
    },
    { freshStore: true },
  );
  const completion = Promise.allSettled([fixture]);
  try {
    await callbackFinished.promise;
    // Let the fixture's finally run while the admitted dispatch is still held.
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(getActiveGatewayRootWorkCount()).toBeGreaterThan(0);
    expect(testState.sessionStorePath).toBe(storePath);
    expect((await fs.stat(fixtureDir)).isDirectory()).toBe(true);
  } finally {
    releaseDispatch.resolve();
    await completion;
    await settleGatewayFixture();
  }
  expect(await completion).toEqual([{ status: "rejected", reason: callbackError }]);
  expect(testState.sessionStorePath).toBeUndefined();
  await expect(fs.stat(fixtureDir)).rejects.toMatchObject({ code: "ENOENT" });
});

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

function terminalEvent(browser: WebSocket, runId: string, states = ["aborted", "error", "final"]) {
  const terminal = onceMessage(
    browser,
    (frame) =>
      frame.type === "event" &&
      frame.event === "chat" &&
      frame.payload?.runId === runId &&
      typeof frame.payload?.state === "string" &&
      states.includes(frame.payload.state),
  );
  void terminal.catch(() => undefined);
  return terminal;
}

const emitLifecycle = (runId: string, data: Record<string, unknown>) =>
  emitAgentEvent({ runId, stream: "lifecycle", data });

describe("gateway server chat lifecycle", () => {
  // Lazy reply modules must retain this same spy across cases instead of a disposed one.
  const runEmbeddedAgent = vi.spyOn(embeddedAgent, "runEmbeddedAgent");
  beforeEach(() => {
    runEmbeddedAgent.mockReset();
  });
  afterAll(() => {
    runEmbeddedAgent.mockRestore();
  });

  test("sessions.abort terminalizes a restart-safe chat before agent adoption", async () => {
    await withMainSessionStore(async (dir) => {
      const browser = await openBrowser();
      await request("sessions.subscribe", {}, { subscribed: true }, browser);

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

      const stoppedTerminal = terminalEvent(browser, stoppedRunId);
      try {
        await sendChatAndExpectStarted(
          stoppedRunId,
          "hold this restart-safe turn before adoption",
          browser,
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
        await request(
          "agent.wait",
          { runId: stoppedRunId, timeoutMs: 0 },
          { runId: stoppedRunId, status: "error" },
          browser,
        );
        const stoppedEntry = loadSessionEntry({
          agentId: "main",
          sessionKey: "main",
          storePath: path.join(dir, "sessions.json"),
          readConsistency: "latest",
        });

        const successorTerminal = terminalEvent(browser, successorRunId);
        await sendChatAndExpectStarted(
          successorRunId,
          "run after the stopped pre-adoption turn",
          browser,
        );
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
        await request(
          "chat.send",
          params,
          {
            runId,
            status: "timeout",
            summary: "aborted",
          },
          browser,
        );
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
        await request("sessions.subscribe", {});
        await sendChatAndExpectStarted(runId, "hold chat run open");
        // The ACK precedes dispatch; emit lifecycle only after the runtime owns this run.
        await runtimeStarted.promise;

        const terminalSessionChange = waitForEvent("sessions.changed", { phase: "end", runId });
        emitLifecycle(runId, { phase: "start", startedAt: 1 });
        emitLifecycle(runId, { phase: "end", startedAt: 1, endedAt: 2 });

        expect((await terminalSessionChange).payload?.activeRunIds).toBeNull();
        const waitWhileChatActive = await rpcReq(ws, "agent.wait", {
          runId,
          timeoutMs: 40,
        });
        expectAgentWaitTimeout(waitWhileChatActive);

        // Coalescing may replace the reason label; assert current ownership instead.
        const settledSessionChange = waitForEvent("sessions.changed", {
          sessionKey: "agent:main:main",
          hasActiveRun: false,
          activeRunIds: [],
          lastRunId: runId,
        });
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

      await request("sessions.subscribe", {});
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

  test("agent events include sessionKey for Webchat clients", async () => {
    await withMainSessionStore(async () => {
      await updateSessionEntry({ sessionKey: "main", storePath: sessionStorePath() }, () => ({
        verboseLevel: "off",
      }));
      const webchatWs = await openBrowser(GATEWAY_CLIENT_NAMES.WEBCHAT);
      try {
        registerAgentRunContext("run-tool-1", { sessionKey: "main", verboseLevel: "on" });
        const agentEvtP = onceMessage(
          webchatWs,
          (o) => o.type === "event" && o.event === "agent" && o.payload?.runId === "run-tool-1",
          8000,
        );
        emitAgentEvent({ runId: "run-tool-1", stream: "assistant", data: { text: "hello" } });
        expect((await agentEvtP).payload).toMatchObject({
          sessionKey: "main",
          stream: "assistant",
        });
      } finally {
        await settleGatewayFixture();
        webchatWs.close();
      }
    });
  });
});
