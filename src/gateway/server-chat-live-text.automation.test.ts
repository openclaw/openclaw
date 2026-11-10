import { expect, it } from "vitest";
import { claimAgentRunContext, releaseAgentRunContext } from "../infra/agent-run-registry.js";
import { prepareAgentWirePayload } from "./server-chat-live-text.js";
import { createChatRunState } from "./server-chat-state.js";

it.each(["tool", "item"] as const)(
  "projects routine automation %s events as display-hidden",
  (stream) => {
    const runId = "quiet-wire";
    const state = createChatRunState();
    const claim = claimAgentRunContext(
      runId,
      {
        cronRunsByJobId: new Map([["job", { nextCheckEnabled: false, assertCurrent: () => {} }]]),
      },
      { trackOwner: true, ownsContext: true },
    );
    try {
      const event = {
        runId,
        stream,
        seq: 1,
        ts: 0,
        data: {
          phase: "start",
          name: "automations",
          toolCallId: "call",
          hideFromChannelProgress: true,
        },
      };
      const projected = prepareAgentWirePayload(event, runId, state, () => true);
      expect(projected.data).toMatchObject({ display: false });
      for (const mode of ["full", "summary"] as const) {
        state.recordProgressEvent(runId, projected, mode);
        expect(state.runs.get(runId)?.progressSnapshot).toBeUndefined();
      }
      expect(event.data).not.toHaveProperty("display");
      const attention = {
        ...event,
        data: { ...event.data, phase: "result", hideFromChannelProgress: false, isError: true },
      };
      expect(prepareAgentWirePayload(attention, runId, state, () => true).data).not.toHaveProperty(
        "display",
      );
    } finally {
      releaseAgentRunContext(runId, claim);
      state.clear();
    }
    const ordinary = { runId, stream, seq: 1, ts: 0, data: { hideFromChannelProgress: true } };
    expect(prepareAgentWirePayload(ordinary, runId, state, () => true).data).not.toHaveProperty(
      "display",
    );
  },
);
