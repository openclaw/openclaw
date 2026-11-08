import { expect, it } from "vitest";
import { loadSessionEntry, patchSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { installGatewayTestHooks } from "../test-helpers.js";
import { handleChatSendWithStorage } from "./chat-send-input-dispatch.js";
import { useBrowserFollowupFixture } from "./chat-send-pending-inputs.test-support.js";

installGatewayTestHooks();
const createFixture = useBrowserFollowupFixture();

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
