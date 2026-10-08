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
import { createDeferredCore } from "../../../shared/deferred.js";
import { resolveOpenClawAgentSqlitePath } from "../../../state/openclaw-agent-db.paths.js";
import { prepareClientVoiceSessionClose } from "../../../talk/client-voice-session-lifecycle.js";
import * as voiceSessionReads from "../../../talk/client-voice-session-read.js";
import {
  flushClientVoiceSessionWrites,
  isClientVoiceSessionConfirmable,
  resolveOpenClientVoiceSessionId,
} from "../../../talk/client-voice-session.js";
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
  nativeDelegation,
  requireString,
  talkEventTypes,
  upstream,
  withNativePlugin,
  withParkedNativeTask,
  withRegisteredNativeEmbeddedRun,
} from "./client-native-control.test-support.js";

describe("native Talk through the public OpenAI plugin registration", () => {
  installNativePluginTestHooks();

  it.for(["source", "settlement"] as const)(
    "closes the provider and joins accepted transcripts when %s capture fails",
    async (capture, { signal }) => {
      await withNativePlugin(async (fixture) => {
        const { result, socket } = await connectNativeSession(fixture);
        const voiceSessionId = requireString(result, "voiceSessionId");
        const target = { voiceSessionId, sessionKey: SESSION_KEY, connId: CONNECTION_ID };
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
          socket.serverEvent({
            type: "turn.done",
            turn: { role: "user", transcript: "accepted before close" },
          });
          await withinTest(entered.promise, signal);
          if (capture === "source") {
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
          await withinTest(
            awaitGateBeforeSettlement(
              providerClosed.promise,
              closing,
              "provider close was skipped",
            ),
            signal,
          );
          let settled = false;
          void closing.then(
            () => {
              settled = true;
            },
            () => {
              settled = true;
            },
          );
          await Promise.resolve();
          expect(settled).toBe(false);
          release.resolve();
          await expect(closing).rejects.toThrow(
            capture === "source" ? "regular file" : "admission is closed",
          );
          expect(await closeTalkClientGatewayControlSession(target)).toBe(false);
          env.restore();
          const messages = readSessionTranscriptMessageEvents({
            agentId: AGENT_ID,
            sessionId: SESSION_ID,
          });
          expect(messages.map(({ event }) => event)).toEqual([
            expect.objectContaining({
              message: expect.objectContaining({
                role: "user",
                content: [{ type: "text", text: "accepted before close" }],
              }),
            }),
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
    const outcome = parked.then(
      () => ({ error: undefined }),
      (error: unknown) => ({ error }),
    );
    try {
      await Promise.race([
        preparing.promise,
        parked.then(() => {
          throw new Error("Native task completed before workspace preparation");
        }),
      ]);
      // Hold a real setup boundary past the separate registration deadline.
      await delay(1100);
    } finally {
      releasePreparation.resolve();
    }
    expect(await outcome).toEqual({ error: undefined });
    expect(assertions).toHaveBeenCalledOnce();
    expect(ACTIVE_EMBEDDED_RUNS.has(SESSION_ID)).toBe(false);
  });

  it("negotiates Gateway control and persists native sideband speech without client control", async () => {
    await withNativePlugin(async ({ create, offer, invoke, broadcast }) => {
      const { result, socket } = await connectNativeSession({ create, offer });
      expect(talkEventTypes(broadcast).filter((type) => type === "session.ready")).toHaveLength(1);
      expect(
        isClientVoiceSessionConfirmable({
          agentId: AGENT_ID,
          sessionKey: SESSION_KEY,
          voiceSessionId: requireString(result, "voiceSessionId"),
        }),
      ).toBe(true);
      socket.serverEvent({ type: "turn.done", turn: { role: "user", transcript: "Hello voice" } });
      socket.serverEvent({
        type: "turn.done",
        turn: { role: "assistant", transcript: "Hello human" },
      });
      await flushClientVoiceSessionWrites({
        agentId: AGENT_ID,
        voiceSessionId: requireString(result, "voiceSessionId"),
      });
      const messages = readSessionTranscriptMessageEvents({
        agentId: AGENT_ID,
        sessionId: SESSION_ID,
      });
      expect(messages).toMatchObject([
        { event: { message: { role: "user", content: [{ type: "text", text: "Hello voice" }] } } },
        {
          event: {
            message: { role: "assistant", content: [{ type: "text", text: "Hello human" }] },
          },
        },
      ]);
      expect(talkEventTypes(broadcast)).not.toContain("turn.ended");
      await invoke("talk.client.close", {});
      expect(socket.readyState).toBe(upstream.NativeSocket.CLOSED);
    });
  });

  it.each([
    ["Status?", "transcript-first"],
    ["Status?", "delegation-first"],
    ["cancel", "transcript-first"],
    ["cancel", "delegation-first"],
  ] as const)(
    "handles native %s without a duplicate consult with %s provider events",
    async (text, eventOrder) => {
      await withParkedNativeTask(
        async ({ create, offer, result, socket, activeRun, abortOwned, chatAbortControllers }) => {
          const { runId, abortSignal } = activeRun;
          expect(chatAbortControllers.get(runId)).toMatchObject({
            agentId: AGENT_ID,
            sessionKey: SESSION_KEY,
            sessionId: SESSION_ID,
            ownerConnId: CONNECTION_ID,
          });
          const transcript = { type: "turn.done", turn: { role: "user", transcript: text } };
          const delegation = nativeDelegation("control-request", text);
          const idle = await connectNativeSession({ create, offer });
          expect(idle.result.voiceSessionId).not.toBe(result.voiceSessionId);
          idle.socket.serverEvent(delegation);
          idle.socket.serverEvent(transcript);
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
            socket.serverEvent(transcript);
            socket.serverEvent(delegation);
          } else {
            socket.serverEvent(delegation);
            // Native control must finish while final ASR is withheld, not merely after both events.
            await waitForControlReply();
            socket.serverEvent(transcript);
          }
          await waitForControlReply();
          await flushClientVoiceSessionWrites({
            agentId: AGENT_ID,
            voiceSessionId: requireString(result, "voiceSessionId"),
          });
          await nextEventLoopTurn();
          expect({
            originalRunAborted: abortSignal.aborted,
            agentStarts: upstream.runEmbeddedAgent.mock.calls.length,
          }).toEqual({ originalRunAborted: text === "cancel", agentStarts: 1 });
          expect(
            socket.sent
              .slice(preControlSocketIndex)
              .filter((frame) => frame.includes("Internal OpenClaw voice control result.")),
          ).toHaveLength(1);
          expect(
            readSessionTranscriptMessageEvents({ agentId: AGENT_ID, sessionId: SESSION_ID }),
          ).toMatchObject(
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

  it.each([
    ["Status?", "I'm not working on an active request right now."],
    ["cancel", "There is no active OpenClaw run to cancel."],
  ])("answers idle native %s without starting a consult", async (text, reply) => {
    await withNativePlugin(async ({ create, offer }) => {
      const { socket, result } = await connectNativeSession({ create, offer });
      const beforeTranscript = socket.sent.slice();
      socket.serverEvent({ type: "turn.done", turn: { role: "user", transcript: text } });
      await flushClientVoiceSessionWrites({
        agentId: AGENT_ID,
        voiceSessionId: requireString(result, "voiceSessionId"),
      });
      await nextEventLoopTurn();
      expect(socket.sent).toEqual(beforeTranscript);
      expect(upstream.runEmbeddedAgent).not.toHaveBeenCalled();
      socket.serverEvent(nativeDelegation("idle-control", text));
      await vi.waitFor(() => expect(socket.sent.join("\n")).toContain(reply));
      await nextEventLoopTurn();
      expect(upstream.runEmbeddedAgent).not.toHaveBeenCalled();
      expect(socket.readyState).toBe(upstream.NativeSocket.OPEN);
    });
  });

  it.each(["empty", "partial", "rejection"] as const)(
    "preserves intentional native cancellation after %s backend settlement",
    async (settlement) => {
      const releaseBackend = createDeferredCore();
      let activeRun: RunEmbeddedAgentParams | undefined;
      let backendAborted = false;
      const abortOwned = vi.fn(() => {
        backendAborted = true;
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
        .mockImplementationOnce(
          async (params) =>
            await withRegisteredNativeEmbeddedRun(params, () => ({
              payloads: [{ text: "Fresh consult completed." }],
              meta: { durationMs: 0 },
            })),
        );
      const settleBackend = async () => {
        releaseBackend.resolve();
        await Promise.allSettled(
          upstream.runEmbeddedAgent.mock.results
            .filter((result) => result.type === "return")
            .map((result) => result.value),
        );
        // Drain the consult/broker Promise continuations before another delegation
        // could supersede the original signal and hide a canceled-result append.
        await nextEventLoopTurn();
      };

      await withNativePlugin(async ({ create, offer, broadcast, chatAbortControllers }) => {
        try {
          const { socket } = await connectNativeSession({ create, offer });
          const sentFrames = () => socket.sent.map((frame): unknown => JSON.parse(frame));
          socket.serverEvent(
            nativeDelegation("canceled-delegation", "Keep working until I cancel."),
          );
          await vi.waitFor(() => expect(activeRun).toBeDefined());
          if (!activeRun) {
            throw new Error("Native delegation did not reach the model backend");
          }
          const { runId, abortSignal } = activeRun;
          expect(chatAbortControllers.get(runId)).toMatchObject({
            agentId: AGENT_ID,
            sessionKey: SESSION_KEY,
            sessionId: SESSION_ID,
            ownerConnId: CONNECTION_ID,
          });
          expect(abortSignal?.aborted).toBe(false);

          socket.serverEvent({ type: "turn.done", turn: { role: "user", transcript: "cancel" } });
          socket.serverEvent(nativeDelegation("cancel-request", "cancel"));
          await vi.waitFor(() => expect(abortOwned).toHaveBeenCalledOnce());
          await vi.waitFor(() =>
            expect(sentFrames()).toContainEqual(
              expect.objectContaining({
                type: "delegation.context.append",
                delegation_item_id: "cancel-request",
                channel: "speakable",
                content: [
                  expect.objectContaining({
                    type: "input_text",
                    text: expect.stringContaining("Cancelled the active OpenClaw run."),
                  }),
                ],
              }),
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
            expect(sentFrames()).toContainEqual({
              type: "delegation.context.append",
              delegation_item_id: "after-cancel",
              channel: "speakable",
              content: [{ type: "input_text", text: "Fresh consult completed." }],
            }),
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
      const lookup = voiceSessionReads.lookupClientVoiceSessions;
      let lookups = 0;
      const reader = vi
        .spyOn(voiceSessionReads, "lookupClientVoiceSessions")
        .mockImplementation(async (request) => {
          const matches = await lookup(request);
          if (++lookups === 2) {
            ready.resolve();
          }
          await release.promise;
          return matches;
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
          "Both legacy lookups must reach the worker before either creates a call",
        );
        release.resolve();
        await calls;
        const binding = readLegacyVoiceBinding(CONNECTION_ID, SESSION_KEY);
        expect(binding).toBeTypeOf("string");
        expect(
          await resolveOpenClientVoiceSessionId({ agentId: AGENT_ID, sessionKey: SESSION_KEY }),
        ).toBe(binding);
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
      socket.serverEvent({
        type: "turn.done",
        turn: { role: "user", transcript: "Client-owned speech" },
      });
      await flushClientVoiceSessionWrites({
        agentId: AGENT_ID,
        voiceSessionId: requireString(result, "voiceSessionId"),
      });
      expect(
        readSessionTranscriptMessageEvents({ agentId: AGENT_ID, sessionId: SESSION_ID }),
      ).toHaveLength(0);
      expect(talkEventTypes(broadcast)).not.toContain("transcript.done");
      await invoke("talk.client.transcript", {
        entryId: "legacy-final",
        role: "user",
        text: "Client-owned speech",
      });
      expect(
        readSessionTranscriptMessageEvents({ agentId: AGENT_ID, sessionId: SESSION_ID }),
      ).toHaveLength(1);
      upstream.runEmbeddedAgent.mockImplementation(
        async (params) =>
          await withRegisteredNativeEmbeddedRun(params, () => ({
            payloads: [{ text: "Legacy provider consultation." }],
            meta: { durationMs: 0 },
          })),
      );
      socket.serverEvent(nativeDelegation("legacy-status", "Status?"));
      await vi.waitFor(() =>
        expect(socket.sent.join("\n")).toContain("Legacy provider consultation."),
      );
      expect(upstream.runEmbeddedAgent).toHaveBeenCalledOnce();
    });
  });
});
import fs from "node:fs/promises";
import path from "node:path";
