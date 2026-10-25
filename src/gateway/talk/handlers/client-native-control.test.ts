import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../../../test/helpers/promise.js";
import { getActiveNativeAttempt } from "../../../agents/embedded-agent-runner/run-state.js";
import * as workspace from "../../../agents/workspace.js";
import { readSessionTranscriptMessageEvents } from "../../../config/sessions/session-accessor.js";
import { racePromiseWithAbortSignal } from "../../../infra/abort-signal.js";
import { AsyncWorkScope, getAsyncWorkSignal } from "../../../shared/async-work-scope.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { resolveOpenClawAgentSqlitePath } from "../../../state/openclaw-agent-db.paths.js";
import { prepareClientVoiceSessionClose } from "../../../talk/client-voice-session-lifecycle.js";
import { resolveOpenClientVoiceSessionId } from "../../../talk/client-voice-session-read.js";
import * as voiceSessionReads from "../../../talk/client-voice-session-read.js";
import { readOwnedVoiceSessionFacts } from "../../../talk/client-voice-session-store.js";
import { flushClientVoiceSessionWrites } from "../../../talk/client-voice-session.js";
import { VoiceTranscriptOperationRegistry } from "../../../talk/voice-transcript.js";
import { captureEnv, setTestEnvValue } from "../../../test-utils/env.js";
import * as chatSendHandler from "../../server-methods/chat-send-handler.js";
import { buildMockOpenAiResponsesProvider } from "../../test-openai-responses-model.js";
import { closeTalkClientGatewayControlSession } from "../client-gateway-control.js";
import {
  forgetLegacyVoiceBinding,
  readLegacyVoiceBinding,
} from "./client-legacy-voice-bindings.js";
import {
  AGENT_ID,
  CONNECTION_ID,
  SESSION_ID,
  SESSION_KEY,
  connectNativeSession,
  installNativePluginTestHooks,
  nativeConsult,
  nativeDelegation,
  nativeResult,
  nativeSessionScope,
  requireString,
  settleNativeBackend,
  talkEventTypes,
  upstream,
  withNativePlugin,
  withParkedNativeTask,
} from "./client-native-control.test-support.js";
import { withRegisteredNativeEmbeddedRun } from "./client-native-run.test-support.js";

const transcriptEvents = (storePath?: string) =>
  readSessionTranscriptMessageEvents({ agentId: AGENT_ID, sessionId: SESSION_ID, storePath });
const nativeTranscript = (transcript: string) => ({
  type: "turn.done",
  turn: { role: "user", transcript },
});
const nativeCompletion = (id: string) =>
  expect.objectContaining({
    type: "delegation.context.append",
    delegation_item_id: id,
    content: [expect.objectContaining({ text: "Real runner consultation completed." })],
  });

function holdWorkspacePreparation() {
  const preparing = createDeferredCore();
  const releasePreparation = createDeferredCore();
  const ensureWorkspace = workspace.ensureAgentWorkspace;
  vi.spyOn(workspace, "ensureAgentWorkspace").mockImplementationOnce(async (...args) => {
    const result = await ensureWorkspace(...args);
    preparing.resolve();
    await releasePreparation.promise;
    return result;
  });
  return { preparing, releasePreparation };
}

describe("native Talk through the public OpenAI plugin registration", () => {
  installNativePluginTestHooks();

  it("consults after the voice offer work scope closes while the session stays open", async () => {
    const observedSignal = createDeferredCore<AbortSignal | undefined>();
    upstream.runEmbeddedAgent.mockImplementation(async (params) => {
      observedSignal.resolve(getAsyncWorkSignal());
      return await withRegisteredNativeEmbeddedRun(params, () =>
        nativeResult("Consult completed after voice setup."),
      );
    });
    await withNativePlugin(async (fixture) => {
      const offerWork = new AsyncWorkScope();
      const { socket, callback } = await offerWork.track(async () => ({
        ...(await connectNativeSession(fixture)),
        callback: AsyncLocalStorage.snapshot(),
      }));
      // Real socket callbacks inherit the offer's async context, then arrive
      // after HTTP setup has settled without closing the voice session.
      await offerWork.drain();
      expect(offerWork.signal.aborted).toBe(true);
      callback(() => socket.serverEvent(nativeDelegation("after-offer", "Report status.")));
      const signal = await observedSignal.promise;
      expect(signal).toMatchObject({ aborted: false });
      expect(signal).not.toBe(offerWork.signal);
      await vi.waitFor(() =>
        expect(socket.sent.join("\n")).toContain("Consult completed after voice setup."),
      );
    });
  });

  it.for(["source environment drift", "settlement refusal"] as const)(
    "closes the provider and joins accepted transcripts across %s",
    async (transition, { signal }) => {
      await withNativePlugin(async (fixture) => {
        const { result, socket } = await connectNativeSession(fixture);
        const voiceSessionId = requireString(result, "voiceSessionId");
        const target = { voiceSessionId, sessionKey: SESSION_KEY, connId: CONNECTION_ID };
        const originalStorePath = resolveOpenClawAgentSqlitePath({ agentId: AGENT_ID });
        const entered = createDeferredCore();
        const release = createDeferredCore();
        const providerClosed = createDeferredCore();
        socket.once("close", providerClosed.resolve);
        // oxlint-disable-next-line typescript/unbound-method -- Invoked with the original registry receiver.
        const run = VoiceTranscriptOperationRegistry.prototype.run;
        const paused = vi
          .spyOn(VoiceTranscriptOperationRegistry.prototype, "run")
          .mockImplementationOnce(function (
            this: VoiceTranscriptOperationRegistry,
            key,
            operation,
            options,
          ) {
            return run.call(
              this,
              key,
              async () => {
                entered.resolve();
                await release.promise;
                return operation();
              },
              options,
            );
          });
        const env = captureEnv(["OPENCLAW_STATE_DIR"]);
        let persistence: ReturnType<typeof prepareClientVoiceSessionClose> | undefined;
        let closing: Promise<boolean> | undefined;
        try {
          socket.serverEvent(nativeTranscript("accepted before close"));
          await withinTest(entered.promise, signal);
          if (transition === "source environment drift") {
            const invalidState = path.join(process.env.OPENCLAW_STATE_DIR!, "invalid-close-source");
            await fs.mkdir(
              resolveOpenClawAgentSqlitePath({
                agentId: AGENT_ID,
                env: { ...process.env, OPENCLAW_STATE_DIR: invalidState },
              }),
              { recursive: true },
            );
            setTestEnvValue("OPENCLAW_STATE_DIR", invalidState);
          } else {
            persistence = prepareClientVoiceSessionClose();
            persistence.beginClose();
          }
          closing = closeTalkClientGatewayControlSession(target);
          void closing.catch(() => {});
          const providerClose = awaitGateBeforeSettlement(
            providerClosed.promise,
            closing,
            "provider close was skipped",
          );
          await withinTest(providerClose, signal);
          const settled = vi.fn();
          void closing.then(settled, settled);
          await Promise.resolve();
          expect(settled).not.toHaveBeenCalled();
          release.resolve();
          if (transition === "source environment drift") {
            await expect(closing).resolves.toBe(true);
          } else {
            await expect(closing).rejects.toThrow("admission is closed");
          }
          expect(await closeTalkClientGatewayControlSession(target)).toBe(false);
          env.restore();
          expect(transcriptEvents(originalStorePath).map(({ event }) => event)).toMatchObject([
            {
              message: {
                role: "user",
                content: [{ type: "text", text: "accepted before close" }],
              },
            },
          ]);
        } finally {
          env.restore();
          release.resolve();
          await flushClientVoiceSessionWrites({ agentId: AGENT_ID, voiceSessionId });
          await closing?.catch(() => {});
          await persistence?.drain();
          paused.mockRestore();
        }
      });
    },
  );

  it("reports setup rejection before a backend registration exists", async () => {
    const preparation = vi
      .spyOn(workspace, "ensureAgentWorkspace")
      .mockRejectedValueOnce(new Error("Synthetic workspace preparation failure"));
    const assertions = vi.fn<Parameters<typeof withParkedNativeTask>[0]>();
    await expect(withParkedNativeTask(assertions)).rejects.toThrow(
      "Native delegation completed before backend registration",
    );
    expect(preparation).toHaveBeenCalledOnce();
    expect(upstream.runEmbeddedAgent).not.toHaveBeenCalled();
    expect(assertions).not.toHaveBeenCalled();
    expect(Boolean(getActiveNativeAttempt(SESSION_ID))).toBe(false);
    expect(
      upstream.sockets.every((socket) => socket.readyState === upstream.NativeSocket.CLOSED),
    ).toBe(true);
  });

  it("waits for session preparation before observing backend registration readiness", async () => {
    const { preparing, releasePreparation } = holdWorkspacePreparation();
    const assertions = vi.fn<Parameters<typeof withParkedNativeTask>[0]>(
      async ({ settleBackend }) => {
        expect(upstream.runEmbeddedAgent).toHaveBeenCalledOnce();
        await settleBackend();
      },
    );
    const parked = withParkedNativeTask(assertions);
    const outcome = parked.catch((error: unknown) => error);
    try {
      await awaitGateBeforeSettlement(
        preparing.promise,
        parked,
        "Native task completed before workspace preparation",
      );
      // Hold a real setup boundary past the separate registration deadline.
      await delay(1100);
    } finally {
      releasePreparation.resolve();
    }
    expect(await outcome).toBeUndefined();
    expect(assertions).toHaveBeenCalledOnce();
    expect(Boolean(getActiveNativeAttempt(SESSION_ID))).toBe(false);
  });

  it.each([
    ["Status?", "transcript-first", "complete"],
    ["Status?", "delegation-first", "complete"],
    ["cancel", "transcript-first", "rejection"],
    ["cancel", "delegation-first", "rejection"],
    ["cancel", "transcript-first", "empty"],
    ["cancel", "delegation-first", "partial"],
  ] as const)(
    "controls a real native consultation without client control (%s, %s, %s)",
    async (control, eventOrder, settlement) => {
      const model = buildMockOpenAiResponsesProvider("https://native-model.example.invalid/v1");
      const requested = createDeferredCore();
      const runnerFinished = createDeferredCore();
      const waitFor = (ready: PromiseLike<unknown>) =>
        awaitGateBeforeSettlement(
          ready,
          runnerFinished.promise,
          "Native consultation settled before readiness",
        );
      const finishModel = createDeferredCore();
      const nativeFetch = upstream.fetch.getMockImplementation()!;
      let modelRequests = 0;
      upstream.fetch.mockImplementation(async (input, init) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url !== model.config.baseUrl + "/responses") {
          return await nativeFetch(input, init);
        }
        modelRequests++;
        if (modelRequests === 1 && (settlement === "complete" || settlement === "rejection")) {
          requested.resolve();
          await racePromiseWithAbortSignal(finishModel.promise, init?.signal ?? undefined);
        }
        const item = {
          type: "message",
          id: "voice-message",
          role: "assistant",
          status: "completed",
          content: [
            { type: "output_text", text: "Real runner consultation completed.", annotations: [] },
          ],
        };
        const events = [
          {
            type: "response.output_item.added",
            item: { ...item, status: "in_progress", content: [] },
          },
          { type: "response.output_item.done", item },
          {
            type: "response.completed",
            response: {
              status: "completed",
              usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 },
            },
          },
        ];
        const encode = (event: unknown) =>
          new TextEncoder().encode("data: " + JSON.stringify(event) + "\n\n");
        if (modelRequests === 1 && (settlement === "empty" || settlement === "partial")) {
          let closed = false;
          const body = new ReadableStream<Uint8Array>({
            start(stream) {
              const send = (event: unknown) => stream.enqueue(encode(event));
              send(events[0]);
              if (settlement === "partial") {
                const part = { item_id: item.id, output_index: 0, content_index: 0 };
                send({
                  type: "response.content_part.added",
                  ...part,
                  part: { type: "output_text", text: "", annotations: [] },
                });
                send({
                  type: "response.output_text.delta",
                  ...part,
                  delta: "Cancelled partial output.",
                });
              }
              requested.resolve();
              void racePromiseWithAbortSignal(finishModel.promise, init?.signal ?? undefined).then(
                () => {
                  if (!closed) {
                    events.slice(1).forEach(send);
                    stream.close();
                  }
                },
                (error: unknown) => {
                  if (!closed) {
                    stream.error(error);
                  }
                },
              );
            },
            cancel() {
              closed = true;
            },
          });
          return new Response(body, { headers: { "content-type": "text/event-stream" } });
        }
        return new Response(
          events.map((event) => "data: " + JSON.stringify(event) + "\n\n").join("") +
            "data: [DONE]\n\n",
          { headers: { "content-type": "text/event-stream" } },
        );
      });
      const actualRunner = await vi.importActual<
        typeof import("../../../agents/embedded-agent.js")
      >("../../../agents/embedded-agent.js");
      upstream.runEmbeddedAgent.mockImplementation((params) =>
        actualRunner.runEmbeddedAgent(params).finally(runnerFinished.resolve),
      );
      const { preparing, releasePreparation } = holdWorkspacePreparation();
      await withNativePlugin(
        async ({ create, offer, invoke, broadcast }) => {
          try {
            const { result, socket } = await connectNativeSession({ create, offer });
            const voiceSessionId = requireString(result, "voiceSessionId");
            expect(
              talkEventTypes(broadcast).filter((type) => type === "session.ready"),
            ).toHaveLength(1);
            expect(
              readOwnedVoiceSessionFacts({ ...nativeSessionScope, voiceSessionId }),
            ).toMatchObject({ origin: "client", status: "open", transcriptCapable: true });
            expect(talkEventTypes(broadcast)).not.toContain("turn.ended");
            socket.serverEvent(
              nativeDelegation("real-runner-request", "Complete a small voice consultation."),
            );
            await waitFor(preparing.promise);
            expect(modelRequests).toBe(0);
            releasePreparation.resolve();
            await waitFor(requested.promise);
            const activeRun = upstream.runEmbeddedAgent.mock.calls[0]![0];
            expect(activeRun.abortSignal?.aborted).toBe(false);
            const controlReply =
              control === "cancel"
                ? "Cancelled the active OpenClaw run."
                : "OpenClaw is waiting on the model.";
            const idleReply =
              control === "cancel"
                ? "There is no active OpenClaw run to cancel."
                : "I'm not working on an active request right now.";
            const sendControl = async (target: typeof socket, id: string, reply: string) => {
              target.serverEvent(nativeDelegation(id, control));
              await target.waitForSent((frame) => frame.includes(reply));
            };
            const idle = await connectNativeSession({ create, offer });
            await sendControl(idle.socket, "other-call-control", idleReply);
            const transcript = nativeTranscript(control);
            if (eventOrder === "transcript-first") {
              socket.serverEvent(transcript);
            }
            await sendControl(socket, "real-runner-control", controlReply);
            expect(activeRun.abortSignal?.aborted).toBe(control === "cancel");
            if (eventOrder === "delegation-first") {
              socket.serverEvent(transcript);
            }
            await settleNativeBackend(finishModel.resolve);
            const frames = socket.sent.map((frame): unknown => JSON.parse(frame));
            if (control === "cancel") {
              expect(frames).not.toContainEqual(
                expect.objectContaining({
                  type: "delegation.context.append",
                  delegation_item_id: "real-runner-request",
                }),
              );
            } else {
              expect(frames).toContainEqual(nativeCompletion("real-runner-request"));
            }
            expect(modelRequests).toBe(1);
            if (control === "cancel") {
              await sendControl(socket, "late-cancel", idleReply);
              socket.serverEvent(nativeDelegation("after-cancel", "Start a fresh small task."));
              await socket.waitForSent(
                (frame) =>
                  frame.includes('"delegation_item_id":"after-cancel"') &&
                  frame.includes("Real runner consultation completed."),
              );
              expect(socket.sent.map((frame): unknown => JSON.parse(frame))).toContainEqual(
                nativeCompletion("after-cancel"),
              );
              expect(modelRequests).toBe(2);
            }
            expect(socket.readyState).toBe(upstream.NativeSocket.OPEN);
            expect(talkEventTypes(broadcast)).not.toContain("session.error");
            await invoke("talk.client.close", { voiceSessionId });
            expect(socket.readyState).toBe(upstream.NativeSocket.CLOSED);
          } finally {
            releasePreparation.resolve();
            finishModel.resolve();
          }
        },
        {
          configure: (config) => {
            config.agents!.defaults = {
              model: { primary: model.modelRef },
              models: { [model.modelRef]: { params: { transport: "sse", openaiWsWarmup: false } } },
            };
            config.models = { mode: "replace", providers: { [model.providerId]: model.config } };
          },
        },
      );
    },
  );

  it("reuses one implicit call when legacy tool lookups overlap on the same connection", async () => {
    await withNativePlugin(async ({ invoke }) => {
      const ready = createDeferredCore();
      const release = createDeferredCore();
      const lookup = voiceSessionReads.resolveOpenClientVoiceSessionId;
      const reader = vi
        .spyOn(voiceSessionReads, "resolveOpenClientVoiceSessionId")
        .mockImplementation(async (request) => {
          const selected = await lookup(request);
          ready.resolve();
          await release.promise;
          return selected;
        });
      // Agent execution is downstream of the persisted binding this case protects.
      const chatSend = vi
        .spyOn(chatSendHandler, "handleTrustedInternalChatSend")
        .mockImplementation(async ({ respond }) => {
          respond(true, { runId: "synthetic-legacy-run", status: "started" });
        });
      const calls = Promise.all(
        ["first", "second"].map((callId) =>
          invoke("talk.client.toolCall", {
            voiceSessionId: undefined,
            callId,
            name: "openclaw_agent_consult",
            args: { question: "Report status" },
          }),
        ),
      );
      try {
        await awaitGateBeforeSettlement(
          ready.promise,
          calls,
          "The first legacy lookup must reach the worker while both requests are pending",
        );
        release.resolve();
        await calls;
        expect(chatSend).toHaveBeenCalledTimes(2);
        const binding = readLegacyVoiceBinding(CONNECTION_ID, SESSION_KEY);
        expect(binding).toBeTypeOf("string");
        expect(await resolveOpenClientVoiceSessionId(nativeSessionScope)).toBe(binding);
      } finally {
        release.resolve();
        await Promise.allSettled([calls]);
        reader.mockRestore();
        chatSend.mockRestore();
        forgetLegacyVoiceBinding(
          CONNECTION_ID,
          SESSION_KEY,
          readLegacyVoiceBinding(CONNECTION_ID, SESSION_KEY),
        );
      }
    });
  });

  it("keeps legacy native data-channel and client transcript ownership unchanged", async () => {
    await withNativePlugin(async ({ create, offer, invoke, broadcast }) => {
      const { result, socket } = await connectNativeSession({ create, offer }, false);
      socket.serverEvent(nativeTranscript("Client-owned speech"));
      await flushClientVoiceSessionWrites({
        agentId: AGENT_ID,
        voiceSessionId: requireString(result, "voiceSessionId"),
      });
      expect(transcriptEvents()).toHaveLength(0);
      expect(talkEventTypes(broadcast)).not.toContain("transcript.done");
      await invoke("talk.client.transcript", {
        entryId: "legacy-final",
        role: "user",
        text: "Client-owned speech",
      });
      expect(transcriptEvents()).toHaveLength(1);
      upstream.runEmbeddedAgent.mockImplementation(nativeConsult("Legacy provider consultation."));
      socket.serverEvent(nativeDelegation("legacy-status", "Status?"));
      await vi.waitFor(() =>
        expect(socket.sent.join("\n")).toContain("Legacy provider consultation."),
      );
    });
  });
});
