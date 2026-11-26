import assert from "node:assert/strict";
import { expect, it, vi } from "vitest";
import * as sessionEvents from "../../auto-reply/reply/session-event-handoff.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import * as sessionWriter from "../../config/sessions/session-accessor.sqlite-entry.js";
import {
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
} from "../../process/gateway-work-admission.js";
import { activeSessionOperations } from "../../sessions/session-controller.state.js";
import {
  persistRunningSessionsForRestart,
  resumeMarkedSessions,
} from "../session-restart-resume.js";
import { dispatchInboundMessageMock, installGatewayTestHooks } from "../test-helpers.js";
import { handleChatSendWithStorage } from "./chat-send-input-dispatch.js";
import { useBrowserFollowupFixture } from "./chat-send-pending-inputs.test-support.js";

installGatewayTestHooks();
const createFixture = useBrowserFollowupFixture();

it.for(["fresh", "failed-clear"] as const)(
  "retains accepted restart intent after pre-runtime dispatch settles (%s)",
  async (prior) => {
    await using fixture = await createFixture({ active: false });
    if (prior === "failed-clear") {
      const predecessor = { sourceRunId: "earlier-execution" };
      await sessionWriter.patchSessionEntryCore(fixture.scope, () => ({
        resumeAfterRestart: predecessor,
      }));
      using admission = vi.spyOn(sessionEvents, "enqueueSessionEventForHost").mockReturnValue({
        id: "earlier-recovery",
        accepted: Promise.resolve({ ok: true }),
        settled: Promise.resolve({ status: "completed", executionStarted: true, delivered: false }),
        cancel: () => false,
      });
      using clear = vi
        .spyOn(sessionWriter, "patchSessionEntryCore")
        .mockRejectedValueOnce(new Error("retained marker write failed"));
      const warn = vi.fn();
      const context = {
        ...fixture.context,
        getRuntimeConfig: () => ({
          ...fixture.context.getRuntimeConfig(),
          session: { store: fixture.scope.storePath },
        }),
      };
      context.resolveGatewayContext = () => context;
      setRuntimeConfigSnapshot(context.getRuntimeConfig());
      await resumeMarkedSessions({ context, signal: new AbortController().signal, log: { warn } });
      expect(admission).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining(predecessor),
      );
      expect(clear).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("retained marker write failed"));
      expect(loadSessionEntry(fixture.scope)?.resumeAfterRestart).toEqual(predecessor);
    }
    let admittedEntry: ReturnType<typeof loadSessionEntry>;
    const { dispatchInboundMessage } = await vi.importActual<
      typeof import("../../auto-reply/dispatch.js")
    >("../../auto-reply/dispatch.js");
    dispatchInboundMessageMock.mockImplementation(
      (params: Parameters<typeof dispatchInboundMessage>[0]) =>
        dispatchInboundMessage({
          ...params,
          replyResolver: async (_ctx, options) => {
            const operation = options?.replyOperation;
            assert(operation);
            admittedEntry = loadSessionEntry(fixture.scope);
            markGatewayRestartDraining();
            operation.abortForRestart();
            return {};
          },
        }),
    );
    try {
      const response = await fixture.send();
      expect(response.mock.calls[0]?.[0]).toBe(true);
      await fixture.finishDispatch();
      expect(admittedEntry?.lifecycleRunId).toBe(fixture.params.idempotencyKey);
      expect(admittedEntry?.resumeAfterRestart).toBeUndefined();
      expect(
        [...activeSessionOperations()].some(
          (operation) => operation.key === fixture.scope.sessionKey,
        ),
      ).toBe(false);
      await persistRunningSessionsForRestart({ cfg: {} });
      expect(loadSessionEntry(fixture.scope)?.resumeAfterRestart).toEqual({});
    } finally {
      resetGatewayWorkAdmission();
    }
  },
);

it.for(["held", "setup-error"] as const)(
  "preserves accepted input before runtime start (%s)",
  async (outcome) => {
    await using fixture = await createFixture({ active: false });
    const runId = `prestart-${outcome}`;
    fixture.params.idempotencyKey = runId;
    // Crash recovery before runtime start compares the scope admission recorded.
    vi.stubEnv("OPENCLAW_GATEWAY_RESTART_RESUME_SCOPE", "token-a");
    await sessionWriter.patchSessionEntryCore(fixture.scope, () => ({
      status: "done",
      lifecycleRevision: "prior-lifecycle",
      lastRunId: "prior-run",
      activeWriterRunId: "prior-run",
      startedAt: 10,
      endedAt: 30,
      runtimeMs: 20,
    }));
    const response = await fixture.send(undefined, undefined, fixture.params, (options) =>
      handleChatSendWithStorage(options, undefined, undefined, {
        beforeDispatch: async () => {
          if (outcome === "setup-error") {
            throw new Error("Accepted input setup failed");
          }
        },
      }),
    );
    const entry = loadSessionEntry(fixture.scope);
    if (outcome === "held") {
      await fixture.dispatchedRecorder;
      expect(response.mock.calls[0]?.[0]).toBe(true);
      expect(entry).toMatchObject({
        lifecycleRunId: runId,
        lifecycleRestartScope: "token-a",
        activeWriterRunId: runId,
      });
      expect(entry?.status).toBeUndefined();
      expect(entry?.endedAt).toBeUndefined();
    } else {
      expect(response.mock.calls[0]?.[0]).toBe(false);
      expect(entry).toMatchObject({
        status: "failed",
        lastRunId: runId,
        lastRunError: expect.stringContaining("Accepted input setup failed"),
      });
      expect(entry?.lifecycleRunId).toBeUndefined();
      expect(fixture.readTranscript()).toContainEqual(
        expect.objectContaining({
          type: "custom_message",
          customType: "run-failed-before-reply",
          display: true,
          details: expect.objectContaining({ runId }),
        }),
      );
    }
    expect(fixture.readTranscript()).toContainEqual(
      expect.objectContaining({
        type: "message",
        message: expect.objectContaining({
          role: "user",
          content: fixture.params.message,
          idempotencyKey: `${runId}:user`,
        }),
      }),
    );
    expect(fixture.context.logGateway.warn).not.toHaveBeenCalled();
  },
);
