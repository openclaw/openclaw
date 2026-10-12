import fs from "node:fs/promises";
import path from "node:path";
import type { AcpRuntimeEvent } from "@openclaw/acp-core/runtime/types";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { afterAll, afterEach, describe, expect, test, vi } from "vitest";
import type { WebSocket } from "ws";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { AcpRuntimeError } from "../acp/runtime/errors.js";
import type { dispatchInboundMessage } from "../auto-reply/dispatch.js";
import { createDispatchReplyOperationCoordinator } from "../auto-reply/reply/dispatch-from-config.lifecycle.js";
import { createAcpSessionMeta } from "../auto-reply/reply/test-fixtures/acp-runtime.js";
import type { ReplyPayload } from "../auto-reply/types.js";
import {
  loadSessionEntryReadOnly,
  loadTranscriptEventsSync,
} from "../config/sessions/session-accessor.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import { tryDispatchAcpReplyHook } from "../plugin-sdk/acpx.js";
import { getSessionWorkAdmissionRelease } from "../sessions/session-lifecycle-admission.js";
import { readAssistantDisplayContent } from "../shared/assistant-display-content.js";
import { extractFirstTextBlock } from "../shared/chat-message-content.js";
import type { Deferred } from "../shared/deferred.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import {
  dispatchInboundMessageMock,
  installGatewayTestHooks,
  rpcReq,
  testState,
  writeSessionStore,
} from "./test-helpers.js";
import { installConnectedControlUiServerSuite } from "./test-with-server.js";

const runtime = vi.hoisted(() => ({
  runTurn: vi.fn(),
  rejectTranscript: false,
}));

vi.mock("../auto-reply/reply/dispatch-acp-transcript.runtime.js", async (importOriginal) => {
  const { persistAcpDispatchTranscript } =
    await importOriginal<typeof import("../auto-reply/reply/dispatch-acp-transcript.runtime.js")>();
  return {
    persistAcpDispatchTranscript: (params: Parameters<typeof persistAcpDispatchTranscript>[0]) =>
      runtime.rejectTranscript
        ? Promise.reject(new Error("transcript write rejected"))
        : persistAcpDispatchTranscript(params),
  };
});

vi.mock("../auto-reply/reply/dispatch-acp-manager.runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../auto-reply/reply/dispatch-acp-manager.runtime.js")>()),
  getAcpSessionManager: () => ({
    resolveSessionAsync: async ({ sessionKey }: { sessionKey: string }) => ({
      kind: "ready",
      sessionKey,
      agentId: "main",
      meta: createAcpSessionMeta({ agent: "main" }),
      entry: loadSessionEntryReadOnly({
        agentId: "main",
        sessionKey,
        storePath: testState.sessionStorePath,
      }),
    }),
    runTurn: runtime.runTurn,
    getObservabilitySnapshot: () => ({
      turns: { queueDepth: 0 },
      runtimeCache: { activeSessions: 1 },
    }),
  }),
  listSessionBindingsBySessionAsync: async () => [],
}));

installGatewayTestHooks({ scope: "suite" });
let ws: WebSocket;
installConnectedControlUiServerSuite((started) => {
  ws = started.ws;
});
const tempDirs = useSessionStoreTempDirs(afterAll, "openclaw-acp-completion-");

function readTranscriptMessages(scope: Parameters<typeof loadTranscriptEventsSync>[0]) {
  return loadTranscriptEventsSync(scope).flatMap((event) => {
    const entry = asOptionalRecord(event);
    const message = asOptionalRecord(entry?.message);
    return entry?.type === "message" && message ? [message] : [];
  });
}

function acpSessionEntry(sessionId: string) {
  return { sessionId, updatedAt: Date.now(), acp: createAcpSessionMeta({ agent: "main" }) };
}

describe("Gateway ACP completion ownership", () => {
  afterEach(() => {
    dispatchInboundMessageMock.mockReset();
    runtime.runTurn.mockReset();
    runtime.rejectTranscript = false;
    testState.sessionStorePath = undefined;
    vi.restoreAllMocks();
  });

  const cases: Array<{
    name: string;
    text?: string;
    transform?: (payload: ReplyPayload) => ReplyPayload | null;
    live?: boolean;
    lifecycle?: boolean;
    bound?: boolean;
    media?: boolean;
    cancel?: boolean;
    rpcAbort?: boolean;
    rebound?: boolean;
    fail?: boolean;
    timeout?: boolean;
    persistFail?: boolean;
    suppressed?: boolean;
    widget?: boolean;
  }> = [
    {
      name: "post-hook text",
      text: "rendered reply",
      transform: () => ({ text: "rendered reply" }),
    },
    {
      name: "successful runtime with post-hook warning",
      transform: (payload) => ({ ...payload, isError: true }),
    },
    { name: "live block replies", live: true },
    { name: "widget tool progress", widget: true },
    { name: "post-hook widget suppression", widget: true, suppressed: true, transform: () => null },
    {
      name: "bound target media",
      bound: true,
      media: true,
    },
    { name: "suppressed runtime errors", fail: true, transform: () => null },
    { name: "suppressed runtime timeout", timeout: true, transform: () => null },
    { name: "persistence errors", persistFail: true },
    { name: "native cancellation through lifecycle", cancel: true, live: true, lifecycle: true },
    {
      name: "persistence failure after explicit abort",
      cancel: true,
      rpcAbort: true,
      persistFail: true,
    },
    { name: "replaced transcript target", rebound: true },
  ];
  test.for(cases)("completes $name once", async (scenario, { signal }) => {
    const storePath = path.join(tempDirs.make(), "sessions.json");
    testState.sessionStorePath = storePath;
    const mediaFile = path.join(path.dirname(storePath), "photo.png");
    if (scenario.media) {
      await fs.writeFile(
        mediaFile,
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/woAAn8B9FD5fHAAAAAASUVORK5CYII=",
          "base64",
        ),
      );
    }
    const suffix = scenario.name.replaceAll(" ", "-");
    const sessionKey = `agent:main:acp-completion-${suffix}`;
    const targetSessionKey = scenario.bound ? `agent:main:bound-${suffix}` : sessionKey;
    const sessionId = `acp-completion-session-${suffix}`;
    expect((await rpcReq(ws, "sessions.subscribe", {})).ok).toBe(true);
    let turnStarted = createDeferred();
    let releaseTurn = createDeferred();
    let activeRunId = "";
    type CapturedAdmission = { runId: string; release: Promise<void> | undefined };
    const dispatchAdmissions = new Map<string, Deferred<CapturedAdmission>>();
    const admittedReleases = new Set<Promise<void>>();
    await writeSessionStore({
      entries: {
        [sessionKey]: acpSessionEntry(scenario.bound ? `source-${sessionId}` : sessionId),
        ...(scenario.bound ? { [targetSessionKey]: acpSessionEntry(sessionId) } : {}),
      },
    });
    runtime.runTurn.mockImplementation(
      async ({ onEvent }: { onEvent: (event: AcpRuntimeEvent) => Promise<void> }) => {
        if (scenario.fail) {
          throw new Error("native turn failed");
        }
        if (scenario.timeout) {
          throw new AcpRuntimeError("ACP_TURN_FAILED", "ACP turn timed out", {
            detailCode: "TURN_TIMEOUT",
          });
        }
        if (scenario.widget) {
          emitAgentEvent({
            runId: activeRunId,
            sessionKey,
            stream: "tool",
            data: {
              phase: "result",
              name: "show_widget",
              result: {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({
                      kind: "canvas",
                      presentation: {
                        target: "assistant_message",
                        title: "Status",
                        sandbox: "scripts",
                      },
                      view: {
                        id: activeRunId,
                        url: `/__openclaw__/canvas/documents/${activeRunId}/index.html`,
                      },
                    }),
                  },
                ],
              },
            },
          });
        }
        await onEvent({ type: "text_delta", text: "same accepted reply" });
        turnStarted.resolve();
        if (scenario.rpcAbort) {
          await releaseTurn.promise;
        }
        if (scenario.rebound) {
          await writeSessionStore({
            entries: {
              [targetSessionKey]: acpSessionEntry(
                `${sessionId}-replaced-${runtime.runTurn.mock.calls.length}`,
              ),
            },
          });
        }
        await onEvent({ type: "done", status: scenario.cancel ? "cancelled" : "completed" });
      },
    );
    runtime.rejectTranscript = scenario.persistFail === true;
    const actualDispatch = await vi.importActual<typeof import("../auto-reply/dispatch.js")>(
      "../auto-reply/dispatch.js",
    );
    dispatchInboundMessageMock.mockImplementation(async (input: unknown) => {
      // SAFETY: The Gateway mock adapter forwards the real dispatchInboundMessage parameters.
      const {
        ctx,
        cfg,
        dispatcher,
        replyOptions: inboundReplyOptions,
      } = input as Parameters<typeof dispatchInboundMessage>[0];
      // Gateway admission outlives ACP dispatch and owns source transcript finalization.
      const release = getSessionWorkAdmissionRelease({
        scope: storePath,
        identities: [ctx.SessionKey],
      });
      if (release) {
        admittedReleases.add(release);
      }
      const runId = inboundReplyOptions?.runId;
      if (runId) {
        dispatchAdmissions.get(runId)?.resolve({ runId, release });
      }
      return actualDispatch.dispatchInboundMessage({
        ctx,
        cfg,
        dispatcher,
        replyOptions: inboundReplyOptions,
        dispatchReplyFromConfig: async ({ ctx: finalized, replyOptions }) => {
          const hookDispatcher = scenario.lifecycle
            ? createDispatchReplyOperationCoordinator({
                agentId: "main",
                cfg,
                ctx: finalized,
                dispatcher,
                operationSessionStoreEntry: { storePath },
                replyOptions,
                resolveOperationExpectedSessionId: () => sessionId,
              }).dispatchHookDispatcher
            : dispatcher;
          if (scenario.media) {
            dispatcher.appendBeforeDeliver?.((payload) => ({
              ...payload,
              mediaUrl: mediaFile,
              trustedLocalMedia: true,
            }));
          } else if (scenario.transform) {
            dispatcher.appendBeforeDeliver?.(scenario.transform);
          }
          const result = await tryDispatchAcpReplyHook(
            {
              ctx: finalized,
              runId: replyOptions?.runId,
              sessionKey: targetSessionKey,
              inboundAudio: false,
              shouldRouteToOriginating: false,
              shouldSendToolSummaries: false,
              shouldSendFullToolDetails: false,
              sendPolicy: "allow",
            },
            {
              ...replyOptions,
              cfg: {
                ...cfg,
                acp: {
                  enabled: true,
                  dispatch: { enabled: true },
                  ...(scenario.live ? { stream: { deliveryMode: "live" } } : {}),
                },
              },
              dispatcher: hookDispatcher,
              recordProcessed: () => {},
              markIdle: () => {},
            },
          );
          return result ?? { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
        },
      });
    });
    const frames: Array<{
      event?: string;
      payload?: {
        runId?: string;
        state?: string;
        seq?: number;
        message?: unknown;
        reason?: string;
        stream?: string;
        data?: { phase?: string; reason?: string };
        errorKind?: string;
      };
    }> = [];
    let lifecycleStarted = createDeferred();
    let lifecycleDelivered = createDeferred();
    const capture = (data: Buffer) => {
      const frame: (typeof frames)[number] = JSON.parse(data.toString());
      frames.push(frame);
      if (
        frame.event === "agent" &&
        frame.payload?.runId === activeRunId &&
        frame.payload.stream === "lifecycle"
      ) {
        if (frame.payload.data?.phase === "start") {
          lifecycleStarted.resolve();
        } else if (frame.payload.data?.phase === "end" || frame.payload.data?.phase === "error") {
          lifecycleDelivered.resolve();
        }
      }
    };
    ws.on("message", capture);
    try {
      // Preserve the observed order: one cold turn, then the same session and
      // reply through the now-loaded lifecycle subscriber.
      for (const [index, temperature] of ["cold", "warm"].entries()) {
        const runId = `acp-completion-${suffix}-${temperature}`;
        activeRunId = runId;
        const admissionCapture = createDeferred<CapturedAdmission>();
        dispatchAdmissions.set(runId, admissionCapture);
        turnStarted = createDeferred();
        releaseTurn = createDeferred();
        lifecycleStarted = createDeferred();
        lifecycleDelivered = createDeferred();
        const expectedState = scenario.rpcAbort
          ? "aborted"
          : scenario.fail || scenario.persistFail || scenario.timeout || scenario.rebound
            ? "error"
            : scenario.cancel
              ? "aborted"
              : "final";
        const expectedStatus = scenario.rpcAbort
          ? "timeout"
          : scenario.fail || scenario.persistFail || scenario.rebound
            ? "error"
            : scenario.cancel || scenario.timeout
              ? "timeout"
              : "ok";
        const sendParameters = {
          sessionKey,
          message: `request ${temperature}`,
          idempotencyKey: runId,
        };
        const accepted = await rpcReq(ws, "chat.send", sendParameters);
        expect(accepted.ok).toBe(true);
        if (scenario.rpcAbort) {
          await turnStarted.promise;
          // Stop suppresses a start still awaiting publication; this case aborts after start.
          await withinTest(lifecycleStarted.promise, signal);
          const aborted = await rpcReq(ws, "chat.abort", { sessionKey, runId });
          expect(aborted.payload).toMatchObject({ aborted: true, runIds: [runId] });
          releaseTurn.resolve();
        }
        const admitted = await admissionCapture.promise;
        expect(admitted.runId).toBe(runId);
        expect(admitted.release).toBeDefined();
        // Notifications coalesce; the captured owner releases only after post-dispatch cleanup.
        await admitted.release;
        let replayPayload: unknown;
        await vi.waitFor(
          async () => {
            const replay = await rpcReq(ws, "chat.send", sendParameters);
            expect(replay.payload).toMatchObject({
              runId,
              status: expect.stringMatching(/^(ok|error|timeout)$/),
            });
            replayPayload = replay.payload;
          },
          { timeout: 10_000 },
        );
        expect.soft(replayPayload, JSON.stringify(replayPayload)).toMatchObject({
          runId,
          status: expectedStatus,
        });
        if (scenario.cancel) {
          expect
            .soft(replayPayload)
            .toMatchObject({ summary: "aborted", endedAt: expect.any(Number) });
        }
        expect(runtime.runTurn).toHaveBeenCalledTimes(index + 1);
        const waited = await rpcReq(ws, "agent.wait", { runId, timeoutMs: 5_000 });
        expect.soft(waited.payload).toMatchObject({
          status: scenario.cancel ? "error" : expectedStatus,
        });
        // Run settlement does not join the asynchronous lifecycle subscriber.
        await withinTest(lifecycleDelivered.promise, signal);
        const finals = frames.filter(
          (frame) =>
            frame.event === "chat" &&
            frame.payload?.runId === runId &&
            ["final", "error", "aborted"].includes(frame.payload.state ?? ""),
        );
        expect.soft(finals, temperature).toHaveLength(1);
        expect.soft(finals[0]?.payload?.state).toBe(expectedState);
        const terminalIndex = frames.findIndex((frame) => frame === finals[0]);
        const priorSequence = Math.max(
          0,
          ...frames
            .slice(0, terminalIndex)
            .filter((frame) => frame.payload?.runId === runId)
            .map((frame) => frame.payload?.seq ?? 0),
        );
        expect.soft(finals[0]?.payload?.seq).toBeGreaterThan(priorSequence);
        if (scenario.timeout) {
          expect.soft(finals[0]?.payload?.errorKind).toBe("timeout");
        }
        if (expectedState !== "error" && !scenario.rpcAbort) {
          expect
            .soft(extractFirstTextBlock(finals[0]?.payload?.message), temperature)
            .toBe(scenario.suppressed ? undefined : (scenario.text ?? "same accepted reply"));
        }
        if (scenario.widget) {
          const content = asOptionalRecord(finals[0]?.payload?.message)?.content;
          if (scenario.suppressed) {
            expect.soft(content).toBeUndefined();
          } else {
            expect.soft(content).toEqual([
              { type: "text", text: "same accepted reply" },
              {
                type: "canvas",
                preview: {
                  kind: "canvas",
                  surface: "assistant_message",
                  render: "url",
                  title: "Status",
                  sandbox: "scripts",
                  viewId: runId,
                  url: `/__openclaw__/canvas/documents/${runId}/index.html`,
                },
                rawText: null,
              },
            ]);
          }
        }
        const lifecycle = frames.filter(
          (frame) =>
            frame.event === "agent" &&
            frame.payload?.runId === runId &&
            frame.payload.stream === "lifecycle",
        );
        expect
          .soft(lifecycle.map((frame) => frame.payload?.data?.phase))
          .toEqual(["start", expectedState === "error" ? "error" : "end"]);
        if (scenario.rpcAbort) {
          expect.soft(lifecycle.at(-1)?.payload?.data).toMatchObject({
            phase: "end",
            status: "cancelled",
            aborted: true,
            stopReason: "rpc",
          });
          // This terminal-only reply was never shown; there is no visible partial to save.
          expect
            .soft(
              frames.filter(
                (frame) =>
                  frame.payload?.runId === runId &&
                  (frame.payload.stream === "assistant" || frame.payload.state === "delta"),
              ),
            )
            .toEqual([]);
          expect.soft(finals[0]?.payload?.message).toBeUndefined();
        }
        expect
          .soft(
            frames.filter(
              (frame) =>
                frame.payload?.runId === runId && frame.payload?.data?.reason === "seq gap",
            ),
          )
          .toEqual([]);
        const messages = readTranscriptMessages({
          agentId: "main",
          sessionId: scenario.rebound ? `${sessionId}-replaced-${index + 1}` : sessionId,
          sessionKey: targetSessionKey,
          storePath,
        }).filter((message) => message.role === "user" || message.role === "assistant");
        if (scenario.widget) {
          const persisted = messages.findLast((message) => message.role === "assistant");
          expect
            .soft(asOptionalRecord(persisted)?.content)
            .toEqual([{ type: "text", text: "same accepted reply" }]);
        }
        expect
          .soft(
            messages.map((message) => message.role),
            temperature,
          )
          .toEqual(
            scenario.rebound
              ? []
              : Array.from({ length: index + 1 }, () =>
                  scenario.persistFail ? ["user"] : ["user", "assistant"],
                ).flat(),
          );
        if (scenario.cancel && !scenario.rpcAbort) {
          const assistant = messages.findLast((message) => message.role === "assistant");
          expect.soft(assistant, temperature).toMatchObject({
            idempotencyKey: runId,
            model: "acp-runtime",
            stopReason: "aborted",
          });
          expect.soft(extractFirstTextBlock(assistant), temperature).toBe("same accepted reply");
          expect.soft(finals[0]?.payload?.message, temperature).toMatchObject({
            stopReason: "aborted",
          });
        }
        if (scenario.media) {
          const assistant = messages.findLast((message) => message.role === "assistant");
          expect
            .soft(
              readAssistantDisplayContent(assistant).some((block: unknown) => {
                const content = asOptionalRecord(block);
                return content !== undefined && content.type !== "text";
              }),
            )
            .toBe(true);
        }
        if (scenario.bound) {
          // The bound target owns ACP history; the dashboard retains each delivered reply too.
          const sourceMessages = readTranscriptMessages({
            agentId: "main",
            sessionId: `source-${sessionId}`,
            sessionKey,
            storePath,
          });
          expect.soft(sourceMessages).toMatchObject(
            ["cold", "warm"].slice(0, index + 1).flatMap((turn) => [
              {
                role: "user",
                content: `request ${turn}`,
                idempotencyKey: `acp-completion-${suffix}-${turn}:user`,
              },
              {
                role: "assistant",
                content: [{ type: "text", text: "same accepted reply" }],
                idempotencyKey: `acp-completion-${suffix}-${turn}`,
              },
            ]),
          );
          for (const [transcript, ownerKey] of [
            [sourceMessages, sessionKey],
            [messages, targetSessionKey],
          ] as const) {
            // Media is copied into each transcript owner's namespace, not shared by URL.
            const mediaPrefix = `/api/chat/media/outgoing/${encodeURIComponent(ownerKey)}/`;
            expect
              .soft(
                readAssistantDisplayContent(
                  transcript.findLast((message) => message.role === "assistant"),
                ),
              )
              .toMatchObject([
                { type: "text", text: "same accepted reply" },
                {
                  type: "image",
                  mimeType: "image/png",
                  sizeBytes: 68,
                  width: 1,
                  height: 1,
                  url: expect.stringContaining(mediaPrefix),
                  openUrl: expect.stringContaining(mediaPrefix),
                },
              ]);
          }
        }
      }
    } finally {
      releaseTurn.resolve();
      await Promise.all(admittedReleases);
      ws.off("message", capture);
    }
  });
});
