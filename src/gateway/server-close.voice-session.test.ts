import { DatabaseSync } from "node:sqlite";
import "../test-utils/prepare-compiled-subprocesses.js";
import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core";
import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import { expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import * as sessionTurn from "../config/sessions/session-accessor.sqlite-transcript-turn.js";
import {
  areDiagnosticsEnabledForProcess,
  emitTrustedDiagnosticEvent,
  setDiagnosticsEnabledForProcess,
} from "../infra/diagnostic-events.js";
import { tryBeginGatewayIndependentRootWorkAdmission } from "../process/gateway-work-admission.js";
import { getAsyncWorkSignal } from "../shared/async-work-scope.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import * as agentDatabase from "../state/openclaw-agent-write-admission.js";
import { readVoiceSessionRecordInTransaction } from "../talk/client-voice-session-store.js";
import { ensureClientVoiceAgentSessionEntry } from "../talk/client-voice-session-write.js";
import { seedSession } from "../talk/client-voice-session.fixture.test-support.js";
import {
  appendClientVoiceTranscript,
  createOrResumeClientVoiceSession,
  registerClientVoiceConsultRun,
} from "../talk/client-voice-session.js";
import { clientVoiceSessionTesting } from "../talk/client-voice-session.test-support.js";
import type { RealtimeVoiceBridgeCreateRequest } from "../talk/provider-types.js";
import { makeBridge } from "../talk/session-runtime.test-support.js";
import { makeClient } from "./server-broadcast.test-helpers.js";
import { createGatewayMetadataCloseFixture } from "./server-close.metadata.test-support.js";
import { ensureTalkRealtimeRelayVoiceSession } from "./talk/relay/operations.js";
import { createTalkRealtimeRelaySession } from "./talk/relay/session-create.js";
import { relaySessions } from "./talk/relay/state.js";
import * as talkRegistry from "./talk/session-registry.js";
import { prepareTalkSessionTarget } from "./talk/session-target.js";

const { sendDigest } = vi.hoisted(() => ({ sendDigest: vi.fn() }));
vi.mock("../channels/message/runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../channels/message/runtime.js")>();
  return { ...actual, sendDurableMessageBatchCore: sendDigest };
});

// mock-isolation: Keep upstream polling and its agent runtime out of this close-order fixture.
vi.mock("../sessions/session-upstream-monitor.js", () => ({
  startSessionUpstreamMonitor: () => ({ stop: () => Promise.resolve() }),
}));

it("settles accepted voice work with diagnostics disabled even when provider cleanup fails", async ({
  signal,
}) => {
  const fixture = await createGatewayMetadataCloseFixture("gateway-voice-session-close");
  const diagnosticsEnabled = areDiagnosticsEnabledForProcess();
  fixture.config.diagnostics = { enabled: false };
  const entered = createDeferred();
  const release = createDeferred();
  const parentClosed = createDeferred();
  const providerClosing = createDeferred();
  const releaseProvider = createDeferred();
  const digestStarted = createDeferred();
  const releaseDigest = createDeferred();
  const toolStarted = createDeferred();
  const releaseTool = createDeferred();
  sendDigest.mockImplementation(async () => {
    digestStarted.resolve();
    await releaseDigest.promise;
    return { status: "sent" };
  });
  const drainEntered = createDeferred();
  const providerFailure = new Error("synthetic provider cleanup failure");
  let drainSettled = false;
  let finishingFixture = false;
  let finishGatewayClose: (() => Promise<void>) | undefined;
  const prepareTalkClose = talkRegistry.prepareTalkConnectionClose;
  const closeObserver = vi
    .spyOn(talkRegistry, "prepareTalkConnectionClose")
    .mockImplementation((...args) => {
      const owner = prepareTalkClose(...args);
      const drain = owner.drain.bind(owner);
      owner.drain = () => {
        const pending = drain();
        void pending.then(
          () => {
            drainSettled = true;
          },
          () => {
            drainSettled = true;
          },
        );
        drainEntered.resolve();
        return pending.catch((error: unknown) => {
          if (!finishingFixture || !collectNestedErrorCandidates(error).includes(providerFailure)) {
            throw error;
          }
        });
      };
      return owner;
    });
  let closing: Promise<void> | undefined;
  let writing: Promise<void> | undefined;
  let toolRun: Promise<void> | undefined;
  let restoreAppend: (() => void) | undefined;
  try {
    const port = await fixture.reservePort();
    const server = await fixture.start(port);
    const kernel = expectDefined(fixture.kernels.get(port), "Gateway kernel");
    finishGatewayClose = kernel.closeOnStartupFailure;
    const target = { agentId: "main", sessionKey: "agent:main:voice-close" };
    await ensureClientVoiceAgentSessionEntry(target);
    const voiceSessionId = await createOrResumeClientVoiceSession({ ...target, origin: "client" });
    const relayTarget = { agentId: "main", sessionKey: "agent:main:main" };
    await seedSession(relayTarget.sessionKey, { channel: "discord", to: "channel:voice-updates" });
    const { client } = makeClient("relay-close-client", "operator", ["operator.admin"]);
    kernel.clients.add(client);
    let providerCallbacks: RealtimeVoiceBridgeCreateRequest | undefined;
    const providerClose = vi.fn(async () => {
      providerClosing.resolve();
      await releaseProvider.promise;
      throw providerFailure;
    });
    const relay = createTalkRealtimeRelaySession({
      context: kernel.gatewayRequestContext,
      connId: client.connId,
      cfg: kernel.cfgAtStart,
      controlSource: "delegation",
      sessionTarget: await prepareTalkSessionTarget(kernel.cfgAtStart, relayTarget.sessionKey),
      provider: {
        id: "close-test",
        label: "Close Test",
        isConfigured: () => true,
        createBridge: (callbacks) => {
          providerCallbacks = callbacks;
          return makeBridge({ close: providerClose });
        },
      },
      providerConfig: {},
      instructions: "brief",
      tools: [],
    });
    providerCallbacks?.onReady?.();
    const relayOwner = expectDefined(relaySessions.get(relay.relaySessionId), "Relay owner");
    await ensureTalkRealtimeRelayVoiceSession({
      relaySessionId: relay.relaySessionId,
      connId: client.connId,
      sessionKey: relayTarget.sessionKey,
    });
    const root = expectDefined(
      tryBeginGatewayIndependentRootWorkAdmission("voice-consult"),
      "Voice consult root",
    );
    toolRun = root
      .run(async () => {
        const runId = `run-${relay.relaySessionId}`;
        await registerClientVoiceConsultRun({
          ...relayTarget,
          voiceSessionId: relay.relaySessionId,
          runId,
        });
        emitTrustedDiagnosticEvent({
          type: "tool.execution.started",
          runId,
          toolCallId: "delayed-tool",
          toolName: "message",
          mutatingAction: true,
        });
        toolStarted.resolve();
        await releaseTool.promise;
        const failedWrite = vi
          .spyOn(agentDatabase, "runOpenClawAgentWorkerWrite")
          .mockImplementationOnce(() => {
            throw new Error("synthetic tool persistence failure");
          });
        try {
          emitTrustedDiagnosticEvent({
            type: "tool.execution.started",
            runId,
            toolCallId: "parallel-read",
            toolName: "read",
            mutatingAction: false,
          });
        } finally {
          failedWrite.mockRestore();
        }
        emitTrustedDiagnosticEvent({
          type: "tool.execution.completed",
          runId,
          toolCallId: "delayed-tool",
          toolName: "message",
          durationMs: 5,
        });
        emitTrustedDiagnosticEvent({
          type: "run.completed",
          runId,
          durationMs: 5,
          outcome: "completed",
        });
      })
      .finally(root.release);
    await toolStarted.promise;
    expect(areDiagnosticsEnabledForProcess()).toBe(false);
    let acceptedSignal: AbortSignal | undefined;
    const append = sessionTurn.appendExpectedSessionTranscriptTurn;
    const observer = vi
      .spyOn(sessionTurn, "appendExpectedSessionTranscriptTurn")
      .mockImplementationOnce(async (...args) => {
        acceptedSignal = getAsyncWorkSignal();
        entered.resolve();
        await release.promise;
        return append(...args);
      });
    restoreAppend = () => observer.mockRestore();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    kernel.scheduler.schedule({
      id: "accepted-voice-transcript",
      delayMs: 0,
      async run() {
        writing = appendClientVoiceTranscript({
          ...target,
          sessionTarget: { sessionKey: target.sessionKey },
          voiceSessionId,
          entryId: "accepted-before-close",
          role: "user",
          text: "Keep my accepted transcript",
        });
        await writing;
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    vi.useRealTimers();
    await withinTest(
      awaitGateBeforeSettlement(
        entered.promise,
        expectDefined(writing, "Accepted transcript"),
        "Voice transcript settled before its persistence boundary",
      ),
      signal,
    );
    expect(acceptedSignal?.aborted).toBe(false);
    // The first relay append is behind the held writer; the second is still in its outer FIFO.
    providerCallbacks?.onTranscript?.("user", "First accepted relay final", true);
    providerCallbacks?.onTranscript?.("user", "Second accepted relay final", true);
    kernel.scheduler.signal.addEventListener("abort", () => parentClosed.resolve(), { once: true });
    closing = server.close({ reason: "voice settlement close regression" });
    const closeOutcome = closing.then(
      () => undefined,
      (error: unknown) => error,
    );
    await withinTest(
      awaitGateBeforeSettlement(
        parentClosed.promise,
        closing,
        "Gateway closed before scheduler cancellation",
      ),
      signal,
    );
    expect(acceptedSignal?.aborted).toBe(false);
    await withinTest(
      awaitGateBeforeSettlement(providerClosing.promise, closing, "Provider close was not joined"),
      signal,
    );
    await expect(
      createOrResumeClientVoiceSession({ ...target, origin: "client", voiceSessionId: "too-late" }),
    ).rejects.toThrow("Voice session persistence admission is closed");
    // Provider event dispatch need not inherit the asynchronous close caller's context.
    providerCallbacks?.onTranscript?.("assistant", "Final words during provider close", true);
    releaseProvider.resolve();
    await withinTest(expect(relayOwner.closing?.completion).rejects.toBe(providerFailure), signal);
    await withinTest(drainEntered.promise, signal);
    await nextEventLoopTurn();
    expect(
      drainSettled,
      "Talk close must join accepted writes before reporting cleanup failure",
    ).toBe(false);
    release.resolve();
    await withinTest(writing!, signal);
    await withinTest(expectDefined(relayOwner.voiceSessionClose, "Closed voice record"), signal);
    expect(sendDigest).not.toHaveBeenCalled();
    releaseTool.resolve();
    await withinTest(toolRun, signal);
    await withinTest(
      awaitGateBeforeSettlement(
        digestStarted.promise,
        closeOutcome,
        "Gateway close lost the final tool digest",
      ),
      signal,
    );
    await nextEventLoopTurn();
    expect(drainSettled, "provider-close digest delivery must retain shutdown custody").toBe(false);
    releaseDigest.resolve();
    expect(collectNestedErrorCandidates(await withinTest(closeOutcome, signal))).toContain(
      providerFailure,
    );
    expect(providerClose).toHaveBeenCalledOnce();
    expect(sendDigest).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        channel: "discord",
        to: "channel:voice-updates",
        payloads: [{ text: "Voice call changes\n- message: succeeded" }],
      }),
    );
    const database = new DatabaseSync(
      resolveOpenClawAgentSqlitePath({ agentId: target.agentId, env: fixture.state.env }),
      { readOnly: true },
    );
    try {
      expect(readVoiceSessionRecordInTransaction({ db: database }, voiceSessionId)).toMatchObject({
        hasUserTranscript: true,
        transcriptFailureKeys: [],
      });
      expect(
        readVoiceSessionRecordInTransaction({ db: database }, relay.relaySessionId),
      ).toMatchObject({
        status: "closed",
        hasUserTranscript: true,
        transcriptFailureKeys: [],
        digestDeliveredAt: expect.any(Number),
        effects: [expect.objectContaining({ toolCallId: "delayed-tool", status: "succeeded" })],
      });
      expect(
        database
          .prepare(
            "SELECT event_id FROM transcript_event_identities WHERE event_id LIKE ? ORDER BY seq",
          )
          .all(`voice:${relay.relaySessionId}:%`)
          .map((row) => row.event_id),
      ).toEqual([1, 2, 3].map((sequence) => `voice:${relay.relaySessionId}:${sequence}`));
    } finally {
      database.close();
    }
  } finally {
    vi.useRealTimers();
    release.resolve();
    releaseProvider.resolve();
    releaseDigest.resolve();
    releaseTool.resolve();
    await Promise.allSettled([writing, toolRun, closing]);
    restoreAppend?.();
    // The failed close has been observed. Finish this fixture's Gateway teardown
    // without allowing its exact synthetic provider error to strand the listener.
    finishingFixture = true;
    await finishGatewayClose?.();
    closeObserver.mockRestore();
    clientVoiceSessionTesting.reset();
    await fixture.cleanup();
    setDiagnosticsEnabledForProcess(diagnosticsEnabled);
  }
});
