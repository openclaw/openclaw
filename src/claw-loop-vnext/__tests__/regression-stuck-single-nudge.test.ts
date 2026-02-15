import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { LoopTransport, SendMessageRequest, SendMessageResult } from "../transport/types.js";
import { nudgeIfStuck } from "../orchestrator.js";
import { RuntimeStore } from "../runtime-store.js";

class NudgeTransport implements LoopTransport {
  readonly kind = "sdk" as const;
  readonly sent: SendMessageRequest[] = [];

  async sendMessage(request: SendMessageRequest): Promise<SendMessageResult> {
    this.sent.push(request);
    return {
      delivered: true,
      transport: "sdk",
      ackId: "ack-nudge",
      outputText: "Working...",
    };
  }
}

describe("regression: stuck detection single nudge", () => {
  it("sends one nudge then respects cooldown", async () => {
    const goalsDir = await mkdtemp(path.join(os.tmpdir(), "claw-loop-vnext-stuck-"));
    const goalFile = path.join(goalsDir, "goal-stuck.json");
    await writeFile(
      goalFile,
      JSON.stringify({
        title: "goal",
        workdir: "/tmp",
        status: "in_progress",
        phases: [{ id: "P1", name: "Plan", status: "pending" }],
      }),
      "utf8",
    );

    const store = new RuntimeStore(path.join(goalsDir, ".runtime", "goal-stuck.state.json"));
    await store.save({
      goalId: "goal-stuck",
      lastDeliveryByIdempotencyKey: {},
      seenSignalKeys: {},
      lastActivityAt: new Date(Date.now() - 10 * 60_000).toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const transport = new NudgeTransport();
    const first = await nudgeIfStuck({ goalsDir, primaryTransport: transport }, goalFile, {
      stuckAfterMs: 1_000,
      cooldownMs: 60_000,
    });
    const second = await nudgeIfStuck({ goalsDir, primaryTransport: transport }, goalFile, {
      stuckAfterMs: 1_000,
      cooldownMs: 60_000,
    });

    expect(first.nudged).toBe(true);
    expect(first.reason).toBe("sent");
    expect(second.nudged).toBe(false);
    expect(second.reason).toBe("within_cooldown");
    expect(transport.sent).toHaveLength(1);
  });
});
