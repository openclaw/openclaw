import { expect, it } from "vitest";
import type { dispatchInboundMessage } from "../../auto-reply/dispatch.js";
import { withFullRuntimeReplyConfig } from "../../auto-reply/reply/get-reply-fast-path.js";
import { loadSessionEntry, patchSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { dispatchInboundMessageMock, installGatewayTestHooks } from "../test-helpers.js";
import { loadRealChatDispatch } from "./chat-send-authority.test-support.js";
import { handleDirectExternalChatSend } from "./chat-send-external-entry.js";
import { useBrowserFollowupFixture } from "./chat-send-pending-inputs.test-support.js";

installGatewayTestHooks();
const createFixture = useBrowserFollowupFixture();

it.for([
  { command: "/status", commitBeforeReply: false },
  { command: "/new", commitBeforeReply: false },
  { command: "/status", commitBeforeReply: true },
])(
  "does not make completed $command recoverable (early commit: $commitBeforeReply)",
  async ({ command, commitBeforeReply }) => {
    const fixture = await createFixture({ active: false });
    await patchSessionEntryCore(fixture.scope, () => ({
      status: "done",
      lifecycleRevision: "prior-lifecycle",
      lastRunId: "prior-agent-run",
      activeWriterRunId: "prior-agent-run",
      startedAt: 10,
      endedAt: 33,
      runtimeMs: 23,
    }));
    const revision = loadSessionEntry(fixture.scope)?.lifecycleRevision;
    const config = withFullRuntimeReplyConfig(fixture.context.getRuntimeConfig());
    const dispatchActual = await loadRealChatDispatch();
    dispatchInboundMessageMock.mockImplementation(async (params: unknown) => {
      const input = params as Parameters<typeof dispatchInboundMessage>[0];
      if (commitBeforeReply) {
        const recorder = input.replyOptions?.userTurnTranscriptRecorder;
        if (!recorder) {
          throw new Error("Expected the admitted input recorder");
        }
        await recorder.persistApproved();
      }
      return dispatchActual({ ...input, cfg: config });
    });
    fixture.params.message = command;
    fixture.params.idempotencyKey = `command-${command.slice(1)}-${commitBeforeReply}`;
    try {
      const response = await fixture.send(
        undefined,
        undefined,
        fixture.params,
        handleDirectExternalChatSend,
      );
      expect(response.mock.calls[0]?.[0]).toBe(true);
      await fixture.finishDispatch();
      const entry = loadSessionEntry(fixture.scope);
      expect(entry).toBeDefined();
      expect(entry?.lifecycleRunId).toBeUndefined();
      if (command === "/status") {
        expect(entry).toMatchObject({
          status: "done",
          lastRunId: "prior-agent-run",
          activeWriterRunId: "prior-agent-run",
          startedAt: 10,
          endedAt: 33,
          runtimeMs: 23,
          lifecycleRevision: revision,
        });
      } else {
        expect(entry?.lifecycleRevision).toEqual(expect.stringMatching(/\S/));
        expect(entry?.lifecycleRevision).not.toBe(revision);
        expect(entry?.lastRunId).toBeUndefined();
        expect(entry?.runtimeMs).toBeUndefined();
      }
      expect(fixture.context.logGateway.warn).not.toHaveBeenCalled();
    } finally {
      await fixture.cleanup();
    }
  },
);
