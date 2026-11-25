import { expect, it, vi } from "vitest";
import { withSystemEventOwner } from "../../infra/system-event-ownership.js";
import {
  claimSystemEventTurn,
  enqueueSystemEvent,
  peekSystemEventEntries,
} from "../../infra/system-events.js";
import type { runReplyAgent } from "./agent-runner-run.js";
import type { runPreparedReply } from "./get-reply-run.js";
import { drainFormattedSystemEvents } from "./session-system-events.js";
import { withReplySystemEventContext } from "./system-event-session-key.js";

export function registerSystemEventAdmissionCases({
  runPrepared,
  requireRunReplyAgentCall,
}: {
  runPrepared: (
    overrides?: Partial<Parameters<typeof runPreparedReply>[0]>,
  ) => ReturnType<typeof runPreparedReply>;
  requireRunReplyAgentCall: () => Parameters<typeof runReplyAgent>[0];
}): void {
  async function useRealDrain() {
    const actualSystemEvents = await vi.importActual<typeof import("./session-system-events.js")>(
      "./session-system-events.js",
    );
    vi.mocked(drainFormattedSystemEvents).mockImplementationOnce(
      actualSystemEvents.drainFormattedSystemEvents,
    );
  }
  it("keeps delivery-owned restart occurrences queued through production reply admission", async () => {
    await useRealDrain();
    const sessionKey = "agent:main:restart-admission-proof";
    enqueueSystemEvent("Restart continuation retained for delivery", {
      sessionKey,
      contextKey: "task:restart-sentinel:admission-proof",
    });
    const captured = peekSystemEventEntries(sessionKey);
    const claim = claimSystemEventTurn(sessionKey, captured, vi.fn());
    expect(claim).toBeDefined();
    enqueueSystemEvent("Notification arrived after capture", { sessionKey });
    try {
      await runPrepared({ agentId: "main", sessionKey });
      const text = requireRunReplyAgentCall().followupRun.currentInboundContext?.text;
      expect(text).not.toContain("Restart continuation retained for delivery");
      expect(text).toContain("Notification arrived after capture");
      expect(peekSystemEventEntries(sessionKey)).toEqual(captured);
    } finally {
      claim?.release();
    }
  });

  it("admits only system events visible to the prepared agent", async () => {
    await useRealDrain();
    const event = "Cron: investigate heartbeat wake failures";
    enqueueSystemEvent(event, withSystemEventOwner({ sessionKey: "global" }, "alpha"));
    enqueueSystemEvent(
      "Beta hook finished",
      withSystemEventOwner({ sessionKey: "global" }, "beta"),
    );

    await runPrepared({
      agentId: "alpha",
      sessionKey: "global",
      opts: withReplySystemEventContext(
        {},
        { sessionKey: "global", events: peekSystemEventEntries("agent:alpha:global") },
      ),
    });

    const call = requireRunReplyAgentCall();
    const context = call.followupRun.currentInboundContext;
    expect(call.followupRun.prompt).toBe("[User sent media without caption]");
    expect(context?.text).toContain(event);
    expect(context?.fragments).toContainEqual({
      kind: "conversation-data",
      text: expect.stringContaining(event),
    });
    expect(call.followupRun.transcriptPrompt).not.toContain(event);
    expect(call.followupRun.prompt).not.toContain("Beta hook finished");
    expect(context?.text).not.toContain("Beta hook finished");
    expect(JSON.stringify(context?.fragments)).not.toContain("Beta hook finished");
    expect(peekSystemEventEntries("agent:beta:global").map((entry) => entry.text)).toEqual([
      "Beta hook finished",
    ]);
  });
}
