import assert from "node:assert/strict";
import { expect, it, vi } from "vitest";
import { loadSessionEntry, patchSessionEntryCore } from "../../config/sessions/session-accessor.js";
import {
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
} from "../../process/gateway-work-admission.js";
import { activeSessionOperations } from "../../sessions/session-controller.state.js";
import { persistRunningSessionsForRestart } from "../session-restart-resume.js";
import { dispatchInboundMessageMock, installGatewayTestHooks } from "../test-helpers.js";
import { handleChatSendWithStorage } from "./chat-send-input-dispatch.js";
import { useBrowserFollowupFixture } from "./chat-send-pending-inputs.test-support.js";

installGatewayTestHooks();
const createFixture = useBrowserFollowupFixture();

it("retains accepted restart intent after pre-runtime dispatch fully settles", async () => {
  await using fixture = await createFixture({ active: false });
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
    expect(
      [...activeSessionOperations()].some(
        (operation) => operation.key === fixture.scope.sessionKey,
      ),
    ).toBe(false);
    await persistRunningSessionsForRestart({ cfg: {} });
    expect(loadSessionEntry(fixture.scope)?.resumeAfterRestart).toEqual({ queuedInputIds: [] });
  } finally {
    resetGatewayWorkAdmission();
  }
});

it.for(["held", "setup-error"] as const)(
  "preserves accepted input before runtime start (%s)",
  async (outcome) => {
    await using fixture = await createFixture({ active: false });
    const runId = `prestart-${outcome}`;
    fixture.params.idempotencyKey = runId;
    await patchSessionEntryCore(fixture.scope, () => ({
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
