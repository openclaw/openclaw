import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { LoopTransport, SendMessageRequest, SendMessageResult } from "../transport/types.js";
import { sendCurrentPhasePrompt } from "../orchestrator.js";

class MockDriver implements LoopTransport {
  readonly kind: "sdk" | "tmux";
  readonly requests: SendMessageRequest[] = [];
  private readonly results: SendMessageResult[];

  constructor(kind: "sdk" | "tmux", results: SendMessageResult[]) {
    this.kind = kind;
    this.results = [...results];
  }

  async sendMessage(request: SendMessageRequest): Promise<SendMessageResult> {
    this.requests.push(request);
    return this.results.shift() as SendMessageResult;
  }
}

describe("integration: mocked driver bridge", () => {
  it("falls back after ACK loss and advances phase exactly once with duplicate output", async () => {
    const goalsDir = await mkdtemp(path.join(os.tmpdir(), "claw-loop-vnext-int-"));
    const goalFile = path.join(goalsDir, "goal-int.json");
    await writeFile(
      goalFile,
      JSON.stringify({
        title: "goal",
        workdir: "/tmp",
        status: "pending",
        phases: [
          { id: "P1", name: "Plan", status: "pending" },
          { id: "P2", name: "Implement", status: "pending" },
        ],
        orchestration: { maxRetries: 2, ackTimeoutMs: 100 },
      }),
      "utf8",
    );

    const primary = new MockDriver("sdk", [
      { delivered: false, transport: "sdk", outputText: "", reason: "timeout" },
      { delivered: false, transport: "sdk", outputText: "", reason: "timeout" },
    ]);
    const fallback = new MockDriver("tmux", [
      {
        delivered: true,
        transport: "tmux",
        ackId: "ack-tmux",
        outputText: "PHASE_COMPLETE: P1\nPHASE_COMPLETE: P1",
      },
    ]);

    const result = await sendCurrentPhasePrompt(
      {
        goalsDir,
        primaryTransport: primary,
        fallbackTransport: fallback,
      },
      goalFile,
      "execute",
    );

    expect(result.delivered).toBe(true);
    expect(result.transport).toBe("tmux");
    expect(primary.requests).toHaveLength(2);
    expect(fallback.requests).toHaveLength(1);
    expect(primary.requests[0].idempotencyKey).toBe(primary.requests[1].idempotencyKey);
    expect(fallback.requests[0].idempotencyKey).toBe(primary.requests[0].idempotencyKey);

    const p1 = result.goal.phases.find((p) => p.id === "P1");
    const p2 = result.goal.phases.find((p) => p.id === "P2");
    expect(p1?.status).toBe("complete");
    expect(p2?.status).toBe("pending");
  });
});
