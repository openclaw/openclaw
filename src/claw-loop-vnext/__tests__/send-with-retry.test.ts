import { describe, expect, it } from "vitest";
import type { LoopTransport, SendMessageResult } from "../transport/types.js";
import { sendWithRetry } from "../transport/send-with-retry.js";

class StubTransport implements LoopTransport {
  readonly kind: "sdk" | "tmux";
  private readonly results: SendMessageResult[];

  constructor(kind: "sdk" | "tmux", results: SendMessageResult[]) {
    this.kind = kind;
    this.results = [...results];
  }

  async sendMessage(): Promise<SendMessageResult> {
    const next = this.results.shift();
    if (!next) {
      return { delivered: false, transport: this.kind, outputText: "", reason: "exhausted" };
    }
    return next;
  }
}

describe("sendWithRetry", () => {
  it("retries primary then falls back", async () => {
    const events: string[] = [];
    const primary = new StubTransport("sdk", [
      { delivered: false, transport: "sdk", outputText: "", reason: "no ack" },
      { delivered: false, transport: "sdk", outputText: "", reason: "no ack" },
    ]);
    const fallback = new StubTransport("tmux", [
      { delivered: true, transport: "tmux", outputText: "PHASE_COMPLETE: P1", ackId: "a" },
    ]);

    const result = await sendWithRetry({
      primary,
      fallback,
      request: {
        goalId: "goal-1",
        workdir: "/tmp",
        message: "x",
        idempotencyKey: "idem",
        ackTimeoutMs: 100,
      },
      maxRetries: 2,
      onEvent: async (event) => {
        events.push(event.type);
      },
    });

    expect(result.delivered).toBe(true);
    expect(result.transport).toBe("tmux");
    expect(events).toContain("transport_fallback");
  });
});
