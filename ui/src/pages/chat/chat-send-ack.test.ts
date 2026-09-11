import { describe, expect, it } from "vitest";
import { normalizeChatSendAck } from "./chat-send-ack.ts";

describe("normalizeChatSendAck", () => {
  it("keeps a submitted ack with its local input receipt so no Gateway run is adopted", () => {
    expect(
      normalizeChatSendAck(
        {
          runId: "run-1",
          status: "submitted",
          localInput: { inputId: " in-1 ", state: "accepted" },
        },
        "fallback",
      ),
    ).toEqual({
      runId: "run-1",
      status: "submitted",
      localInput: { inputId: "in-1", state: "accepted" },
    });
  });

  it.each([
    { name: "missing", localInput: undefined },
    { name: "without an input id", localInput: { state: "accepted" } },
    { name: "in an unknown state", localInput: { inputId: "in-1", state: "queued" } },
  ])("treats a submitted ack with a receipt that is $name as a completed hand-off", (scenario) => {
    expect(
      normalizeChatSendAck(
        { runId: "run-1", status: "submitted", localInput: scenario.localInput },
        "fallback",
      ),
    ).toEqual({ runId: "run-1", status: "ok" });
  });

  it("ignores a local input receipt on Gateway-run acks", () => {
    expect(
      normalizeChatSendAck(
        { runId: "run-1", status: "ok", localInput: { inputId: "in-1", state: "accepted" } },
        "fallback",
      ),
    ).toEqual({ runId: "run-1", status: "ok" });
  });
});
