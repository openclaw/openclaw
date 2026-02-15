import { describe, expect, it } from "vitest";
import type { LoopTransport, SendMessageRequest, SendMessageResult } from "../transport/types.js";
import { sendWithRetry } from "../transport/send-with-retry.js";

class CaptureTransport implements LoopTransport {
  readonly kind: "sdk" | "tmux";
  readonly requests: SendMessageRequest[] = [];
  private readonly results: SendMessageResult[];

  constructor(kind: "sdk" | "tmux", results: SendMessageResult[]) {
    this.kind = kind;
    this.results = [...results];
  }

  async sendMessage(request: SendMessageRequest): Promise<SendMessageResult> {
    this.requests.push(request);
    return (
      this.results.shift() ?? {
        delivered: false,
        transport: this.kind,
        outputText: "",
        reason: "exhausted",
      }
    );
  }
}

describe("regression: unknown delivery / no ACK", () => {
  it("retries with the same idempotency key and reports failure when ACK never arrives", async () => {
    const primary = new CaptureTransport("sdk", [
      { delivered: false, transport: "sdk", outputText: "", reason: "no-ack" },
      { delivered: false, transport: "sdk", outputText: "", reason: "no-ack" },
    ]);

    const result = await sendWithRetry({
      primary,
      request: {
        goalId: "goal-1",
        workdir: "/tmp",
        message: "phase prompt",
        idempotencyKey: "idem-fixed",
        ackTimeoutMs: 50,
      },
      maxRetries: 2,
      onEvent: async () => {},
    });

    expect(result.delivered).toBe(false);
    expect(primary.requests).toHaveLength(2);
    expect(primary.requests[0].idempotencyKey).toBe("idem-fixed");
    expect(primary.requests[1].idempotencyKey).toBe("idem-fixed");
  });
});
