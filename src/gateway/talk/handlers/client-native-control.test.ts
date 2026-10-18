import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs/promises";
import path from "node:path";
import { setImmediate as nextEventLoopTurn, setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../../../test/helpers/promise.js";
import { ACTIVE_EMBEDDED_RUNS } from "../../../agents/embedded-agent-runner/run-state.js";
import type { RunEmbeddedAgentParams } from "../../../agents/embedded-agent-runner/run/params.js";
import {
  clearActiveEmbeddedRun,
  setActiveEmbeddedRun,
} from "../../../agents/embedded-agent-runner/runs.js";
import { createEmbeddedRunHandle } from "../../../agents/embedded-agent-runner/runs.test-support.js";
import * as workspace from "../../../agents/workspace.js";
import { readSessionTranscriptMessageEvents } from "../../../config/sessions/session-accessor.js";
import { AsyncWorkScope, getAsyncWorkSignal } from "../../../shared/async-work-scope.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { resolveOpenClawAgentSqlitePath } from "../../../state/openclaw-agent-db.paths.js";
import { prepareClientVoiceSessionClose } from "../../../talk/client-voice-session-lifecycle.js";
import { resolveOpenClientVoiceSessionId } from "../../../talk/client-voice-session-read.js";
import * as voiceSessionReads from "../../../talk/client-voice-session-read.js";
import { flushClientVoiceSessionWrites } from "../../../talk/client-voice-session.js";
import { VoiceTranscriptOperationRegistry } from "../../../talk/voice-transcript.js";
import { captureEnv, setTestEnvValue } from "../../../test-utils/env.js";
import * as talkAgentConsult from "../agent-consult.js";
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
import { flushNativeTranscript } from "./client-native-transcript.test-support.js";

const transcriptEvents = (storePath?: string) =>
  readSessionTranscriptMessageEvents({ agentId: AGENT_ID, sessionId: SESSION_ID, storePath });
const nativeRunOwner = {
  ...nativeSessionScope,
  sessionId: SESSION_ID,
  ownerConnId: CONNECTION_ID,
};
const nativeTranscript = (transcript: string) => ({
  type: "turn.done",
  turn: { role: "user", transcript },
});
const appendResult = (id: string, text: unknown, partial = false) => ({
  type: "delegation.context.append",
  delegation_item_id: id,
  channel: "speakable",
  content: [
    partial ? expect.objectContaining({ type: "input_text", text }) : { type: "input_text", text },
  ],
});

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
      expect(upstream.runEmbeddedAgent).toHaveBeenCalledOnce();
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
    expect(ACTIVE_EMBEDDED_RUNS.has(SESSION_ID)).toBe(false);
    expect(
      upstream.sockets.every((socket) => socket.readyState === upstream.NativeSocket.CLOSED),
    ).toBe(true);
  });

  it("waits for session preparation before observing backend registration readiness", async () => {
    const preparing = createDeferredCore();
    const releasePreparation = createDeferredCore();
    const ensureWorkspace = workspace.ensureAgentWorkspace;
    vi.spyOn(workspace, "ensureAgentWorkspace").mockImplementationOnce(async (...args) => {
      const result = await ensureWorkspace(...args);
      preparing.resolve();
      await releasePreparation.promise;
      return result;
    });
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
    expect(ACTIVE_EMBEDDED_RUNS.has(SESSION_ID)).toBe(false);
  });

  it.each([
    ["Status?", "delegation-first"],
    ["cancel", "transcript-first"],
  ] as const)(
    "handles native %s without a duplicate consult with %s provider events",
    async (text, eventOrder) => {
      await withParkedNativeTask(
        async ({ create, offer, result, socket, activeRun, abortOwned, chatAbortControllers }) => {
          const { runId, abortSignal } = activeRun;
          expect(chatAbortControllers.get(runId)).toMatchObject(nativeRunOwner);
          const transcript = nativeTranscript(text);
          const delegation = nativeDelegation("control-request", text);
          const idle = await connectNativeSession({ create, offer });
          expect(idle.result.voiceSessionId).not.toBe(result.voiceSessionId);
          await flushNativeTranscript(idle.result, () => {
            idle.socket.serverEvent(delegation);
            idle.socket.serverEvent(transcript);
          });
          const idleReply =
            text === "cancel"
              ? "There is no active OpenClaw run to cancel."
              : "I'm not working on an active request right now.";
          await vi.waitFor(() => expect(idle.socket.sent.join("\n")).toContain(idleReply));
          expect(abortSignal.aborted).toBe(false);
          expect(abortOwned).not.toHaveBeenCalled();
          expect(upstream.runEmbeddedAgent).toHaveBeenCalledOnce();
          const preControlSocketIndex = socket.sent.length;
          const reply =
            text === "cancel"
              ? "Cancelled the active OpenClaw run."
              : "OpenClaw is working on the current voice request.";
          const waitForControlReply = () =>
            vi.waitFor(() => {
              expect(socket.sent.slice(preControlSocketIndex).join("\n")).toContain(reply);
              expect(abortSignal.aborted).toBe(text === "cancel");
            });
          if (eventOrder === "transcript-first") {
            await flushNativeTranscript(result, () => {
              socket.serverEvent(transcript);
              socket.serverEvent(delegation);
            });
          } else {
            socket.serverEvent(delegation);
            // Native control must finish while final ASR is withheld, not merely after both events.
            await waitForControlReply();
            await flushNativeTranscript(result, () => socket.serverEvent(transcript));
          }
          await waitForControlReply();
          expect({
            originalRunAborted: abortSignal.aborted,
            agentStarts: upstream.runEmbeddedAgent.mock.calls.length,
          }).toEqual({ originalRunAborted: text === "cancel", agentStarts: 1 });
          expect(
            socket.sent
              .slice(preControlSocketIndex)
              .filter((frame) => frame.includes("Internal OpenClaw voice control result.")),
          ).toHaveLength(1);
          expect(transcriptEvents()).toMatchObject(
            [text, text].map((transcriptText) => ({
              event: {
                message: { role: "user", content: [{ type: "text", text: transcriptText }] },
              },
            })),
          );
          if (text === "Status?") {
            expect(abortOwned).not.toHaveBeenCalled();
            expect(chatAbortControllers.has(runId)).toBe(true);
          } else {
            expect(abortOwned).toHaveBeenCalledOnce();
          }
          expect(socket.readyState).toBe(upstream.NativeSocket.OPEN);
        },
      );
    },
  );

  it.for(["partial", "rejection"] as const)(
    "preserves intentional native cancellation after %s backend settlement",
    async (settlement, { signal }) => {
      const releaseBackend = createDeferredCore();
      const cancellationObserved = createDeferredCore();
      let activeRun: RunEmbeddedAgentParams | undefined;
      let backendAborted = false;
      const abortOwned = vi.fn(() => {
        backendAborted = true;
        cancellationObserved.resolve();
      });
      upstream.runEmbeddedAgent
        .mockImplementationOnce(async (params) => {
          const handle = {
            ...createEmbeddedRunHandle({ runId: params.runId, abort: abortOwned }),
            isAborted: () => backendAborted,
          };
          setActiveEmbeddedRun(params.sessionId, handle, params.sessionKey);
          activeRun = params;
          try {
            await releaseBackend.promise;
            if (settlement === "rejection") {
              params.abortSignal?.throwIfAborted();
              throw new Error("Expected the model's actual cancellation signal");
            }
            return {
              payloads: settlement === "partial" ? [{ text: "Canceled partial output." }] : [],
              meta: { durationMs: 0, aborted: true },
            };
          } finally {
            clearActiveEmbeddedRun(params.sessionId, handle, params.sessionKey);
          }
        })
        .mockImplementationOnce(nativeConsult("Fresh consult completed."));
      const settleBackend = () => settleNativeBackend(releaseBackend.resolve);

      await withNativePlugin(async ({ create, offer, broadcast, chatAbortControllers }) => {
        try {
          const { socket, result } = await connectNativeSession({ create, offer });
          const sentFrames = () => socket.sent.map((frame): unknown => JSON.parse(frame));
          socket.serverEvent(
            nativeDelegation("canceled-delegation", "Keep working until I cancel."),
          );
          await vi.waitFor(() => expect(activeRun).toBeDefined());
          if (!activeRun) {
            throw new Error("Native delegation did not reach the model backend");
          }
          const { runId, abortSignal } = activeRun;
          expect(chatAbortControllers.get(runId)).toMatchObject(nativeRunOwner);
          expect(abortSignal?.aborted).toBe(false);

          await flushNativeTranscript(result, () => {
            socket.serverEvent(nativeTranscript("cancel"));
            socket.serverEvent(nativeDelegation("cancel-request", "cancel"));
          });
          await withinTest(cancellationObserved.promise, signal);
          expect(abortOwned).toHaveBeenCalledOnce();
          await vi.waitFor(() =>
            expect(sentFrames()).toContainEqual(
              expect.objectContaining(
                appendResult(
                  "cancel-request",
                  expect.stringContaining("Cancelled the active OpenClaw run."),
                  true,
                ),
              ),
            ),
          );
          expect(abortSignal?.aborted).toBe(true);
          expect(socket.readyState).toBe(upstream.NativeSocket.OPEN);

          await settleBackend();
          expect(sentFrames()).not.toContainEqual(
            expect.objectContaining({
              type: "delegation.context.append",
              delegation_item_id: "canceled-delegation",
            }),
          );
          socket.serverEvent(nativeDelegation("late-cancel", "cancel"));
          await nextEventLoopTurn();
          expect(upstream.runEmbeddedAgent).toHaveBeenCalledOnce();
          socket.serverEvent(nativeDelegation("after-cancel", "Start a fresh small task."));
          await vi.waitFor(() =>
            expect(sentFrames()).toContainEqual(
              appendResult("after-cancel", "Fresh consult completed."),
            ),
          );
          expect(upstream.runEmbeddedAgent).toHaveBeenCalledTimes(2);
          expect(socket.readyState).toBe(upstream.NativeSocket.OPEN);
          expect(talkEventTypes(broadcast)).not.toContain("session.error");
        } finally {
          await settleBackend();
        }
      });
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
      const consult = vi
        .spyOn(talkAgentConsult, "startTalkRealtimeAgentConsult")
        .mockResolvedValue({
          ok: true,
          runId: "synthetic-legacy-run",
          idempotencyKey: "synthetic-legacy-call",
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
        expect(consult).toHaveBeenCalledTimes(2);
        const binding = readLegacyVoiceBinding(CONNECTION_ID, SESSION_KEY);
        expect(binding).toBeTypeOf("string");
        expect(await resolveOpenClientVoiceSessionId(nativeSessionScope)).toBe(binding);
      } finally {
        release.resolve();
        await Promise.allSettled([calls]);
        reader.mockRestore();
        consult.mockRestore();
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
      expect(upstream.runEmbeddedAgent).toHaveBeenCalledOnce();
    });
  });
});
