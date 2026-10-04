import { expect, it, vi } from "vitest";
import { withSystemEventOwner } from "../../infra/system-event-ownership.js";
import { enqueueSystemEvent, peekSystemEventEntries } from "../../infra/system-events.js";
import type { runReplyAgent } from "./agent-runner.runtime.js";
import type { runPreparedReply } from "./get-reply-run.js";
import type { InternalGetReplyOptions } from "./get-reply.types.js";
import { drainFormattedSystemEvents } from "./session-system-events.js";
import { withReplySystemEventContext } from "./system-event-session-key.js";

export function registerSystemEventAdmissionCases({
  runPrepared,
  requireRunReplyAgentCall,
  internalEventOptions,
}: {
  runPrepared: (
    overrides?: Partial<Parameters<typeof runPreparedReply>[0]>,
  ) => ReturnType<typeof runPreparedReply>;
  requireRunReplyAgentCall: () => Parameters<typeof runReplyAgent>[0];
  internalEventOptions: InternalGetReplyOptions;
}): void {
  it("keeps delivery-owned restart occurrences queued through production reply admission", async () => {
    const actualSystemEvents = await vi.importActual<typeof import("./session-system-events.js")>(
      "./session-system-events.js",
    );
    vi.mocked(drainFormattedSystemEvents).mockImplementationOnce(
      actualSystemEvents.drainFormattedSystemEvents,
    );
    const sessionKey = "agent:main:restart-admission-proof";
    enqueueSystemEvent("Restart continuation retained for delivery", {
      sessionKey,
      contextKey: "task:restart-sentinel:admission-proof",
    });
    const captured = peekSystemEventEntries(sessionKey);
    const deferredEventIds = captured.map((event) => event.id!).filter(Boolean);
    await runPrepared({
      agentId: "main",
      sessionKey,
      opts: withReplySystemEventContext(
        { ...internalEventOptions },
        {
          sessionKey,
          events: captured,
          deferredEventIds,
        },
      ),
    });
    expect(requireRunReplyAgentCall().followupRun.currentInboundContext?.text).toContain(
      "Restart continuation retained for delivery",
    );
    expect(peekSystemEventEntries(sessionKey).map((event) => event.id)).toEqual(deferredEventIds);
  });

  it("admits only system events visible to the prepared agent", async () => {
    const actualSystemEvents = await vi.importActual<typeof import("./session-system-events.js")>(
      "./session-system-events.js",
    );
    vi.mocked(drainFormattedSystemEvents).mockImplementationOnce(
      actualSystemEvents.drainFormattedSystemEvents,
    );
    enqueueSystemEvent(
      "Alpha hook finished",
      withSystemEventOwner({ sessionKey: "global" }, "alpha"),
    );
    enqueueSystemEvent(
      "Beta hook finished",
      withSystemEventOwner({ sessionKey: "global" }, "beta"),
    );
    enqueueSystemEvent("Alpha follow-up", withSystemEventOwner({ sessionKey: "global" }, "alpha"));

    await runPrepared({
      agentId: "alpha",
      sessionKey: "global",
      opts: withReplySystemEventContext(
        { ...internalEventOptions },
        { sessionKey: "global", events: peekSystemEventEntries("agent:alpha:global") },
      ),
    });

    const call = requireRunReplyAgentCall();
    const context = call.followupRun.currentInboundContext;
    expect(call.followupRun.prompt).toBe("[User sent media without caption]");
    for (const event of ["Alpha hook finished", "Alpha follow-up"]) {
      expect(context?.text).toContain(event);
      expect(context?.fragments).toContainEqual({
        kind: "conversation-data",
        text: expect.stringContaining(event),
      });
      expect(call.followupRun.transcriptPrompt).not.toContain(event);
    }
    expect(call.followupRun.prompt).not.toContain("Beta hook finished");
    expect(context?.text).not.toContain("Beta hook finished");
    expect(JSON.stringify(context?.fragments)).not.toContain("Beta hook finished");
    expect(peekSystemEventEntries("agent:beta:global").map((event) => event.text)).toEqual([
      "Beta hook finished",
    ]);
  });
}
