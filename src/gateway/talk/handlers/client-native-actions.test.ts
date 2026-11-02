import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { extractText } from "../../../../ui/src/lib/chat/message-extract.ts";
import {
  getEmbeddedRunAttachment,
  getActiveNativeAttempt,
  ACTIVE_EMBEDDED_RUNS_BY_RUN_ID,
} from "../../../agents/embedded-agent-runner/run-state.js";
import type { EmbeddedAgentRunResult } from "../../../agents/embedded-agent.js";
import { guardSessionManager } from "../../../agents/session-tool-result-guard-wrapper.js";
import {
  createAssistant,
  createAssistantResultStream,
  createTestSession,
  holdAssistantResponse,
  registerAgentSessionLoopTestLifecycle,
  streamMocks,
  testModel,
} from "../../../agents/sessions/agent-session-loop-correctness.test-support.js";
import { SessionManager } from "../../../agents/sessions/session-manager.js";
import {
  loadExactSessionEntry,
  loadTranscriptEventsSync,
  readSessionTranscriptMessageEvents,
} from "../../../config/sessions/session-accessor.js";
import { readTranscriptEventRows } from "../../../config/sessions/session-accessor.sqlite-read.js";
import { waitForSessionTranscriptIndexReconcile } from "../../../config/sessions/session-transcript-reconcile.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
} from "../../../state/openclaw-agent-db.js";
import {
  registerClientVoiceConsultRun,
  resolveClientVoiceRunBinding,
} from "../../../talk/client-voice-session.js";
import { observeMainThreadSql } from "../../../test-utils/main-thread-sql-spies.test-support.js";
import { readSessionPreviewItemsFromTranscriptAsync } from "../../session-transcript-preview.js";
import { closeTalkClientGatewayControlSession } from "../client-gateway-control.js";
import {
  AGENT_ID,
  CONNECTION_ID,
  SESSION_ID,
  SESSION_KEY,
  connectNativeSession,
  installNativePluginTestHooks,
  nativeDelegation,
  nativeResult,
  requireString,
  settleNativeBackend,
  talkEventTypes,
  upstream,
  withParkedNativeTask,
  withNativePlugin,
} from "./client-native-control.test-support.js";
import { prepareMissingRegistrationFixture } from "./client-native-readiness.test-support.js";
import { nativeCallSession } from "./client-native-request.test-support.js";
import { withRegisteredNativeEmbeddedRun } from "./client-native-run.test-support.js";
import { flushNativeTranscript } from "./client-native-transcript.test-support.js";

function rawTranscriptRows() {
  return readTranscriptEventRows(openOpenClawAgentDatabase({ agentId: AGENT_ID }), SESSION_ID);
}

function transcriptScope() {
  return {
    agentId: AGENT_ID,
    sessionId: SESSION_ID,
    sessionKey: SESSION_KEY,
    storePath: resolveOpenClawAgentSqlitePath({ agentId: AGENT_ID }),
  };
}

function nativeTranscript(text: string, role: "user" | "assistant" = "user") {
  return { type: "turn.done", turn: { role, transcript: text } };
}

function nativeBackgroundItems(session: {
  instructions: string;
  initial_items?: unknown;
}): unknown {
  expect(session).not.toHaveProperty("initial_items");
  const records = session.instructions.match(
    /<shared_session_history>\n(.*)\n<\/shared_session_history>$/s,
  )?.[1];
  expect(records).toBeDefined();
  return JSON.parse(records!);
}

function spokenMessages(frames: string[]): string[] {
  return frames.flatMap((frame) => {
    const event: unknown = JSON.parse(frame);
    if (!isRecord(event) || event.channel !== "speakable" || !Array.isArray(event.content)) {
      return [];
    }
    return event.content.flatMap((content: unknown) =>
      isRecord(content) && content.type === "input_text" && typeof content.text === "string"
        ? [content.text]
        : [],
    );
  });
}

function expectResult(
  frames: string[],
  id = "original-task",
  text = "Original task completed normally.",
) {
  expect(frames.map((frame): unknown => JSON.parse(frame))).toContainEqual({
    type: "delegation.context.append",
    delegation_item_id: id,
    channel: "speakable",
    content: [{ type: "input_text", text }],
  });
}

type ParkedTask = Parameters<Parameters<typeof withParkedNativeTask>[0]>[0];

function closeVoice(voiceSessionId: string) {
  return closeTalkClientGatewayControlSession({
    voiceSessionId,
    sessionKey: SESSION_KEY,
    connId: CONNECTION_ID,
  });
}

function registerVoiceRun(voiceSessionId: string, runId: string) {
  return registerClientVoiceConsultRun({
    agentId: AGENT_ID,
    sessionKey: SESSION_KEY,
    voiceSessionId,
    runId,
  });
}

function expectLiveTask({ activeRun, abortOwned }: ParkedTask) {
  expect(activeRun.abortSignal.aborted).toBe(false);
  expect(abortOwned).not.toHaveBeenCalled();
  expect(upstream.runEmbeddedAgent).toHaveBeenCalledOnce();
}

function expectHealthySocket({ socket, broadcast }: ParkedTask) {
  expect(socket.readyState).toBe(upstream.NativeSocket.OPEN);
  expect(talkEventTypes(broadcast)).not.toContain("session.error");
}

describe("native Talk action ownership through public plugin registration", () => {
  installNativePluginTestHooks();
  registerAgentSessionLoopTestLifecycle();
  beforeAll(async () => {
    // Registration deadlines cover readiness, not loading the real stream implementation.
    await import("../../../agents/embedded-agent-runner/run/attempt-stream-prepare.js");
  });

  it("keeps native generated input in current-turn custody but out of display and future calls", async () => {
    const spoken = "Keep the literal labels Context: and Spoken style: in my note.";
    const delegated =
      "Check the note requested by the speaker. Context: preserve both labels. Spoken style: one sentence.";
    const answerText = "Both labels are preserved.";
    const { response: providerStream, release: finish } = holdAssistantResponse(answerText);
    const providerStarted = createDeferredCore();
    streamMocks.streamSimple.mockImplementation(() => {
      providerStarted.resolve();
      return providerStream;
    });
    await withNativePlugin(async (fixture) => {
      const scope = transcriptScope();
      let modelRun: Promise<void> | undefined;
      let activeVoiceSessionId: string | undefined;
      const failures = new Set<unknown>();
      const settle = (work: Promise<unknown> | undefined) =>
        Promise.resolve(work).catch((error: unknown) => {
          failures.add(error);
        });
      upstream.runEmbeddedAgent.mockImplementationOnce(
        async (params) =>
          await withRegisteredNativeEmbeddedRun(params, async () => {
            const { agentId, sessionId, sessionKey, storePath } = params.sessionTarget ?? {};
            if (
              !agentId ||
              !sessionId ||
              !sessionKey ||
              !storePath ||
              !params.preparedRunAdmission
            ) {
              throw new Error("Missing native target/admission");
            }
            await params.preparedRunAdmission.admit("embedded", "native-history-backend");
            const recorder = params.userTurnTranscriptRecorder;
            const manager = guardSessionManager(
              SessionManager.open({ agentId, sessionId, sessionKey, storePath }),
              {
                agentId: AGENT_ID,
                sessionKey: SESSION_KEY,
                runId: params.runId,
                preparedUserTurnMessage: await recorder?.resolveMessage(),
                preparedUserTurnTranscriptRecorder: recorder,
              },
            );
            const { session } = await createTestSession({ sessionManager: manager });
            modelRun = session.prompt(params.prompt);
            await modelRun;
            await recorder?.waitForRuntimePersistence();
            return {
              ...nativeResult(answerText),
              meta: {
                durationMs: 0,
                terminalReply: { disposition: "visible", text: answerText },
              },
            } satisfies EmbeddedAgentRunResult;
          }).catch((error: unknown) => {
            providerStarted.reject(error);
            throw error;
          }),
      );
      try {
        const { socket, result } = await connectNativeSession(fixture);
        activeVoiceSessionId = requireString(result, "voiceSessionId");
        await flushNativeTranscript(result, () => socket.serverEvent(nativeTranscript(spoken)));
        socket.serverEvent(nativeDelegation("custody-request", delegated));
        await providerStarted.promise;
        const run = upstream.runEmbeddedAgent.mock.calls[0]![0];
        const modelMessages = streamMocks.streamSimple.mock.calls[0]![1].messages;
        expect(
          modelMessages.filter((message: unknown) => JSON.stringify(message).includes(delegated)),
        ).toHaveLength(1);
        expect(modelMessages.map(extractText)).toContain(run.prompt);
        const generated = loadTranscriptEventsSync(scope).flatMap((event) =>
          isRecord(event) &&
          isRecord(event.message) &&
          JSON.stringify(event.message).includes(delegated)
            ? [event.message]
            : [],
        );
        expect(generated).toHaveLength(1);
        expect.soft(generated[0]).toMatchObject({
          role: "user",
          display: false,
          excludeFromContext: true,
        });
        expect(extractText(generated[0])).toBe(run.prompt);
        const spokenFrames = fixture.broadcast.mock.calls.flatMap(([event, payload]) =>
          event === "talk.event" && payload.talkEvent?.type === "transcript.done"
            ? [payload.talkEvent.payload.text]
            : [],
        );
        expect(spokenFrames).toEqual([spoken]);
        expect(JSON.stringify(fixture.broadcast.mock.calls)).not.toContain(delegated);
        finish();
        await modelRun;
        await vi.waitFor(() => expect(spokenMessages(socket.sent)).toContain(answerText));
        // Speech stays a distinct raw record; the UI discloses it without claiming replacement.
        const readback = answerText;
        const dialogue = "OpenClaw is waiting on the model.";
        for (const text of [readback, dialogue]) {
          await flushNativeTranscript(result, () =>
            socket.serverEvent(nativeTranscript(text, "assistant")),
          );
        }
        const retained = [
          { role: "user", text: spoken },
          { role: "assistant", text: readback },
          { role: "assistant", text: readback },
          { role: "assistant", text: dialogue },
        ];
        const assistantRecords = readSessionTranscriptMessageEvents(scope).flatMap(({ event }) =>
          isRecord(event) && isRecord(event.message) && event.message.role === "assistant"
            ? [event.message]
            : [],
        );
        expect(assistantRecords[0]).not.toHaveProperty("__openclaw.voiceTranscript");
        expect(assistantRecords.slice(1)).toEqual(
          [readback, dialogue].map((text) =>
            expect.objectContaining({
              api: "realtime",
              content: [{ type: "text", text }],
              __openclaw: expect.objectContaining({ voiceTranscript: "provider-owned" }),
            }),
          ),
        );
        await fixture.invoke("talk.client.close", { voiceSessionId: result.voiceSessionId });
        const rawCompleted = rawTranscriptRows();
        expect(await closeOpenClawAgentDatabaseByPathAsync(scope.storePath)).toBe(true);
        const reconnected = await connectNativeSession(fixture);
        activeVoiceSessionId = requireString(reconnected.result, "voiceSessionId");
        const session = await nativeCallSession();
        expect.soft(session.instructions).not.toContain(delegated);
        expect(nativeBackgroundItems(session)).toEqual(retained);
        expect(session.delegation?.ack_filler).toBe(false);
        expect(rawTranscriptRows()).toEqual(rawCompleted);
      } catch (error) {
        failures.add(error);
      } finally {
        finish();
        await settle(modelRun);
        await settle(activeVoiceSessionId ? closeVoice(activeVoiceSessionId) : undefined);
      }
      if (failures.size === 1) {
        throw failures.values().next().value;
      }
      if (failures.size > 1) {
        throw new AggregateError(failures, "Native Talk fixture failed");
      }
    });
  });

  it("selects eligible native history before projection and the item cap", async () => {
    await withNativePlugin(async (fixture) => {
      const scope = transcriptScope();
      const manager = SessionManager.open(scope);
      const append = (
        content: string,
        flags: { display?: false; excludeFromContext?: true } = {},
      ) => manager.appendMessage({ role: "user", content, timestamp: 1, ...flags });
      append("ordinary");
      append("context only", { display: false });
      append("display only", { excludeFromContext: true });
      for (let index = 0; index < 70; index++) {
        append(`excluded sentinel ${index}`, { display: false, excludeFromContext: true });
      }
      const raw = rawTranscriptRows();
      const display = await readSessionPreviewItemsFromTranscriptAsync(scope, 16, 800);
      expect.soft(display.map((item) => item.text)).toEqual(["ordinary", "display only"]);
      await waitForSessionTranscriptIndexReconcile({
        agentId: scope.agentId,
        path: scope.storePath,
      });
      const sessionEntry = loadExactSessionEntry(scope)?.entry;
      expect(sessionEntry?.sessionId).toBe(SESSION_ID);
      await closeOpenClawAgentDatabaseByPathAsync(scope.storePath);
      const sql = observeMainThreadSql();
      try {
        const context = await readSessionPreviewItemsFromTranscriptAsync(
          { ...scope, sessionEntry },
          16,
          800,
          "model-context",
        );
        expect(context.map((item) => item.text)).toEqual(["ordinary", "context only"]);
        sql.expectIdle();
      } finally {
        sql.restore();
      }
      await connectNativeSession(fixture);
      expect(nativeBackgroundItems(await nativeCallSession())).toEqual([
        { role: "user", text: "ordinary" },
        { role: "user", text: "context only" },
      ]);
      expect(rawTranscriptRows()).toEqual(raw);
      // Reset retention is intentional model context, even for a hidden/excluded user row.
      const kept = append("reset-kept", { display: false, excludeFromContext: true });
      manager.appendResetBoundary("new", kept);
      append("post-reset excluded", { display: false, excludeFromContext: true });
      const resetRaw = rawTranscriptRows();
      expect(
        (await readSessionPreviewItemsFromTranscriptAsync(scope, 16, 800, "model-context")).map(
          (item) => item.text,
        ),
      ).toEqual(["reset-kept"]);
      expect(await readSessionPreviewItemsFromTranscriptAsync(scope, 16, 800)).toEqual([]);
      await connectNativeSession(fixture);
      expect(nativeBackgroundItems(await nativeCallSession())).toEqual([
        { role: "user", text: "reset-kept" },
      ]);
      expect(rawTranscriptRows()).toEqual(resetRaw);
      for (let index = 0; index < 20; index++) {
        append(`${index}:` + "x".repeat(30));
      }
      const bounded = await readSessionPreviewItemsFromTranscriptAsync(
        scope,
        3,
        20,
        "model-context",
      );
      expect(bounded).toEqual(
        [17, 18, 19].map((index) => ({ role: "user", text: `${index}:` + "x".repeat(14) + "..." })),
      );
    });
  });

  it(
    "releases the provider when registration readiness never publishes",
    { timeout: 10_000 },
    async () => {
      const fixture = await prepareMissingRegistrationFixture();
      try {
        const { session, providerStream, answer, finish, publish, assertions, start } = fixture;
        await expect(start()).rejects.toThrow(
          /registration readiness not observed within 1000 ms; last phase: \S/,
        );
        expect(assertions).not.toHaveBeenCalled();
        expect(finish).toHaveBeenCalledOnce();
        expect(publish).toHaveBeenCalledOnce();
        expect(await providerStream.result()).toBe(answer);
        expect(session.isStreaming).toBe(false);
        expect(Boolean(getActiveNativeAttempt(SESSION_ID))).toBe(false);
        const runId = upstream.runEmbeddedAgent.mock.calls[0]![0].runId;
        expect(ACTIVE_EMBEDDED_RUNS_BY_RUN_ID.has(runId)).toBe(false);
      } finally {
        await fixture.close();
      }
    },
  );

  it.each([
    ["closed", "closed"],
    ["returned A-to-B-to-A", "reassigned"],
    ["identical registration replay", "open"],
  ] as const)(
    "checks the controlling call at real final insertion while the backend stays live (%s)",
    async (scenario, transition) => {
      const { session } = await createTestSession();
      const { response: providerStream, release: finish } = holdAssistantResponse("Task finished.");
      const answer = createAssistant(testModel, "Task finished.");
      streamMocks.streamSimple
        .mockImplementationOnce(() => providerStream)
        .mockImplementation(() => createAssistantResultStream(answer));
      await withParkedNativeTask(
        async ({ create, result, socket, activeRun, rpcSourceTesting, abortOwned }) => {
          let closing: Promise<boolean> | undefined;
          try {
            await vi.waitFor(() => expect(streamMocks.streamSimple).toHaveBeenCalledOnce());
            const voiceSessionId = requireString(result, "voiceSessionId");
            const replacementVoiceSessionId =
              transition === "reassigned"
                ? requireString(await create(true), "voiceSessionId")
                : undefined;
            const handle = getActiveNativeAttempt(activeRun.sessionId);
            const registration = handle && getEmbeddedRunAttachment(handle);
            const chatRegistration = rpcSourceTesting.get(activeRun.runId);
            if (!handle || !registration?.toolAuthority || !chatRegistration) {
              throw new Error("Expected the real admitted backend and control registration");
            }
            expect(resolveClientVoiceRunBinding(activeRun.runId)?.voiceSessionId).toBe(
              voiceSessionId,
            );
            expect(session.isStreaming).toBe(true);
            const inserted = vi.spyOn(session.agent, "admitSteeringMessage");
            const realSteer = session.steer.bind(session);
            const delivered = createDeferredCore();
            let insertionsBeforeTransition: number | undefined;
            const steering = vi.spyOn(session, "steer").mockImplementation(async (...args) => {
              // Enter the real transcript-preparation await before closing only the call.
              // Awaiting close here would deadlock on this control's own FIFO drain.
              const pending = realSteer(...args);
              void pending.catch(() => {});
              insertionsBeforeTransition = inserted.mock.calls.length;
              if (transition === "closed") {
                closing = closeVoice(voiceSessionId);
              } else if (replacementVoiceSessionId) {
                await registerVoiceRun(replacementVoiceSessionId, activeRun.runId);
              }
              if (
                scenario === "returned A-to-B-to-A" ||
                scenario === "identical registration replay"
              ) {
                await registerVoiceRun(voiceSessionId, activeRun.runId);
              }
              void pending.then(
                () => delivered.resolve(),
                () => delivered.resolve(),
              );
              return pending;
            });
            const text = "use the release branch instead";
            socket.serverEvent(nativeDelegation("final-insertion-control", text));
            await delivered.promise;
            if (transition === "closed") {
              expect(await closing).toBe(true);
              expect(socket.readyState).toBe(upstream.NativeSocket.CLOSED);
            } else if (replacementVoiceSessionId) {
              expect(resolveClientVoiceRunBinding(activeRun.runId)?.voiceSessionId).toBe(
                scenario === "returned A-to-B-to-A" ? voiceSessionId : replacementVoiceSessionId,
              );
            } else {
              await vi.waitFor(() =>
                expect(spokenMessages(socket.sent)).toContainEqual(
                  expect.stringContaining("Got it. I steered the active run."),
                ),
              );
            }
            expect(steering).toHaveBeenCalledOnce();
            expect(insertionsBeforeTransition).toBe(0);
            expect(getActiveNativeAttempt(activeRun.sessionId)).toBe(handle);
            expect(ACTIVE_EMBEDDED_RUNS_BY_RUN_ID.get(activeRun.runId)).toBe(registration);
            expect(getEmbeddedRunAttachment(handle)).toBe(registration);
            expect(rpcSourceTesting.get(activeRun.runId)).toBe(chatRegistration);
            expect(() => registration.toolAuthority?.assertActive()).not.toThrow();
            expect(activeRun.abortSignal.aborted).toBe(false);
            expect(session.agent.signal?.aborted).toBe(false);
            expect(session.isStreaming).toBe(true);
            expect(abortOwned).not.toHaveBeenCalled();
            expect(upstream.runEmbeddedAgent).toHaveBeenCalledOnce();
            expect.soft(inserted).toHaveBeenCalledTimes(transition === "open" ? 1 : 0);
            expect.soft(session.getSteeringMessages()).toEqual(transition === "open" ? [text] : []);
            expect(session.agent.hasQueuedMessages()).toBe(transition === "open");
          } finally {
            await closing;
          }
        },
        "Keep working until I cancel.",
        session,
        finish,
      );
    },
  );

  it.each([
    ["idle", "cancel"],
    ["queued replacement", "steer"],
  ] as const)(
    "does not retarget %s during control readiness or FIFO wait (%s)",
    async (transition, mode) => {
      await withParkedNativeTask(async (task) => {
        const { socket, activeRun, rpcSourceTesting, queueMessage } = task;
        const entry = rpcSourceTesting.get(activeRun.runId);
        if (!entry) {
          throw new Error("Missing original registration");
        }
        if (transition === "idle") {
          rpcSourceTesting.delete(activeRun.runId);
        }
        const before = socket.sent.length;
        const queued = transition === "queued replacement";
        if (queued) {
          socket.serverEvent(nativeDelegation("prefix-control", "cancel"));
        }
        socket.serverEvent(
          nativeDelegation(
            "captured-control",
            mode === "cancel" ? "cancel" : "use the release branch instead",
          ),
        );
        // Same call and even the same correlation ID cannot adopt a new registration.
        rpcSourceTesting.set(activeRun.runId, { ...entry });
        await vi.waitFor(() =>
          expect(spokenMessages(socket.sent.slice(before))).toEqual([
            ...(queued
              ? [expect.stringContaining("There is no active OpenClaw run to cancel.")]
              : []),
            expect.stringContaining(`There is no active OpenClaw run to ${mode}.`),
          ]),
        );
        expect(queueMessage).not.toHaveBeenCalled();
        expectLiveTask(task);
      });
    },
  );

  it("consumes a startup control with a visible refusal before any backend publishes", async () => {
    const release = createDeferredCore();
    const started = createDeferredCore();
    let signal: AbortSignal | undefined;
    upstream.runEmbeddedAgent.mockImplementationOnce(async (params) => {
      signal = params.abortSignal;
      started.resolve();
      await release.promise;
      return await withRegisteredNativeEmbeddedRun(params, () =>
        nativeResult("Original task completed normally."),
      );
    });
    await withNativePlugin(async (fixture) => {
      const { socket } = await connectNativeSession(fixture);
      try {
        socket.serverEvent(nativeDelegation("original-task", "Keep working."));
        await started.promise;
        expect(Boolean(getActiveNativeAttempt(SESSION_ID))).toBe(false);
        const before = socket.sent.length;
        socket.serverEvent(nativeDelegation("startup-control", "use the release branch instead"));
        await vi.waitFor(() =>
          expect(spokenMessages(socket.sent.slice(before))).toEqual([
            expect.stringContaining("There is no active OpenClaw run to steer."),
          ]),
        );
        expect(signal?.aborted).toBe(false);
        expect(upstream.runEmbeddedAgent).toHaveBeenCalledOnce();
        release.resolve();
        await vi.waitFor(() => expectResult(socket.sent));
        expect(socket.readyState).toBe(upstream.NativeSocket.OPEN);
      } finally {
        await settleNativeBackend(release.resolve);
      }
    });
  });

  it("keeps generated steering hidden while retaining each complete agent input", async () => {
    await withParkedNativeTask(async ({ socket, result, queueMessage, settleBackend }) => {
      const requests = ["Reply exactly `FIRST_STEER`", "Reply exactly `SECOND_STEER`"];
      for (const [index, request] of requests.entries()) {
        await flushNativeTranscript(result, () => socket.serverEvent(nativeTranscript(request)));
        socket.serverEvent(nativeDelegation(`steered-${index}`, request));
        await vi.waitFor(() => expect(queueMessage).toHaveBeenCalledTimes(index + 1));
      }
      const messages = await Promise.all(
        queueMessage.mock.calls.map(async ([text, options], index) => {
          const message = await options?.userTurnTranscriptRecorder?.resolveMessage();
          expect(message).toMatchObject({ role: "user", display: false });
          expect(message).not.toHaveProperty("excludeFromContext");
          expect(extractText(message)).toBe(text);
          expect(text).toContain(`<input>${requests[index]}</input>`);
          expect(text).toContain(`<transcript_delta>user: ${requests[index]}</transcript_delta>`);
          expect(options?.isInboundUserMessage).toBe(true);
          return message;
        }),
      );
      expect(messages[0]?.idempotencyKey).toEqual(expect.any(String));
      expect(messages[1]?.idempotencyKey).toEqual(expect.any(String));
      expect(messages[0]?.idempotencyKey).not.toBe(messages[1]?.idempotencyKey);
      await settleBackend();
      expect(upstream.runEmbeddedAgent).toHaveBeenCalledOnce();
    });
  });

  it("keeps followup on retained work after same-call transport replacement", async () => {
    const text = "after that check tests";
    const acknowledgment = "Queued that follow-up for the active OpenClaw run.";
    await withParkedNativeTask(async (task) => {
      const { create, offer, result, socket, activeRun, queueMessage, abortOwned, settleBackend } =
        task;
      const replacement = await connectNativeSession(
        { create, offer },
        true,
        requireString(result, "voiceSessionId"),
      );
      expect(replacement.result.voiceSessionId).toBe(result.voiceSessionId);
      await vi.waitFor(() => expect(socket.readyState).toBe(upstream.NativeSocket.CLOSED));
      replacement.socket.serverEvent(nativeDelegation("replacement-control", text));
      await vi.waitFor(() =>
        expect({
          deliveries: queueMessage.mock.calls.length,
          taskStarts: upstream.runEmbeddedAgent.mock.calls.length,
          originalRunAborted: activeRun.abortSignal.aborted,
        }).toEqual({ deliveries: 1, taskStarts: 1, originalRunAborted: false }),
      );
      await flushNativeTranscript(replacement.result, () =>
        replacement.socket.serverEvent(nativeTranscript(text)),
      );
      expect(spokenMessages(replacement.socket.sent)).toEqual([
        expect.stringContaining(acknowledgment),
      ]);
      expect(abortOwned).not.toHaveBeenCalled();
      await settleBackend();
      expect(activeRun.abortSignal.aborted).toBe(false);
      expect(queueMessage).toHaveBeenCalledOnce();
      expect(upstream.runEmbeddedAgent).toHaveBeenCalledOnce();
    });
  });

  // A same-turn test misses the state transition between a persisted transcript and its delegation.
  it("makes one current-state decision for steering delegated after original settlement", async () => {
    const text = "use the release branch instead";
    await withParkedNativeTask(async (task) => {
      const { socket, result, activeRun, queueMessage, abortOwned, settleBackend } = task;
      const beforeTranscript = socket.sent.length;
      await flushNativeTranscript(result, () => socket.serverEvent(nativeTranscript(text)));
      expect.soft(queueMessage, "final ASR must not steer the old task").not.toHaveBeenCalled();
      expect.soft(spokenMessages(socket.sent.slice(beforeTranscript))).toEqual([]);
      await settleBackend();
      await vi.waitFor(() => expectResult(socket.sent));
      expect(activeRun.abortSignal.aborted).toBe(false);

      socket.serverEvent(nativeDelegation("after-settlement", text));
      await vi.waitFor(() => expect(upstream.runEmbeddedAgent).toHaveBeenCalledTimes(2));
      await vi.waitFor(() =>
        expectResult(socket.sent, "after-settlement", "Subsequent task completed."),
      );
      expect(upstream.runEmbeddedAgent.mock.calls[1]?.[0].prompt).toContain(text);
      expect(queueMessage).not.toHaveBeenCalled();
      expect(abortOwned).not.toHaveBeenCalled();
      expect(socket.readyState).toBe(upstream.NativeSocket.OPEN);
    });
  });

  // The real queue yields on readiness: one synchronous burst fills it without a blocker seam.
  it("speaks a bounded refusal at control capacity and accepts a fresh cancel after draining", async () => {
    await withParkedNativeTask(async (task) => {
      const { socket, result, activeRun, queueMessage, abortOwned, rpcSourceTesting } = task;
      const beforeBurst = socket.sent.length;
      await flushNativeTranscript(
        result,
        () => {
          for (let index = 0; index < 9; index += 1) {
            socket.serverEvent(nativeTranscript("Status?"));
            socket.serverEvent(nativeDelegation(`status-${index}`, "Status?"));
          }
          socket.serverEvent(nativeTranscript("cancel"));
          socket.serverEvent(nativeDelegation("overflow-cancel", "cancel"));
        },
        10,
      );
      const statusReply = "OpenClaw is working on the current voice request.";
      await vi.waitFor(() =>
        expect(
          spokenMessages(socket.sent.slice(beforeBurst)).filter((message) =>
            message.includes(statusReply),
          ),
        ).toHaveLength(9),
      );
      const refusals = spokenMessages(socket.sent.slice(beforeBurst)).filter(
        (message) => !message.includes(statusReply),
      );
      // Keep going after a missing refusal so recovery independently catches a permanently sealed queue.
      expect
        .soft(refusals)
        .toEqual([
          expect.stringMatching(
            /(?:queue|control).*(?:full|busy|capacity)|(?:full|busy|capacity).*(?:queue|control)/i,
          ),
        ]);
      for (const refusal of refusals) {
        expect(Buffer.byteLength(refusal, "utf8")).toBeLessThanOrEqual(500);
      }
      expect(socket.sent.slice(beforeBurst).join("\n")).not.toContain(
        "Cancelled the active OpenClaw run.",
      );
      expect(queueMessage).not.toHaveBeenCalled();
      expectLiveTask(task);
      expect(rpcSourceTesting.has(activeRun.runId)).toBe(true);
      expectHealthySocket(task);

      const beforeRecovery = socket.sent.length;
      await flushNativeTranscript(result, () => {
        socket.serverEvent(nativeTranscript("cancel"));
        socket.serverEvent(nativeDelegation("fresh-cancel", "cancel"));
      });
      await vi.waitFor(() => expect(abortOwned).toHaveBeenCalledOnce());
      await vi.waitFor(() =>
        expect(spokenMessages(socket.sent.slice(beforeRecovery))).toEqual([
          expect.stringContaining("Cancelled the active OpenClaw run."),
        ]),
      );
      expect(activeRun.abortSignal.aborted).toBe(true);
      expect(queueMessage).not.toHaveBeenCalled();
      expect(upstream.runEmbeddedAgent).toHaveBeenCalledOnce();
      expectHealthySocket(task);
    });
  });
});
