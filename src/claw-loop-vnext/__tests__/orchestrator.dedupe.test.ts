import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { LoopTransport, SendMessageRequest, SendMessageResult } from "../transport/types.js";
import { sendCurrentPhasePrompt } from "../orchestrator.js";

class FixedTransport implements LoopTransport {
  readonly kind = "sdk" as const;
  private readonly outputText: string;

  constructor(outputText: string) {
    this.outputText = outputText;
  }

  async sendMessage(_request: SendMessageRequest): Promise<SendMessageResult> {
    return {
      delivered: true,
      transport: "sdk",
      ackId: "ack-1",
      outputText: this.outputText,
    };
  }
}

describe("orchestrator dedupe", () => {
  it("does not advance same phase twice across repeated outputs", async () => {
    const goalsDir = await mkdtemp(path.join(os.tmpdir(), "claw-loop-vnext-orch-"));
    const goalFile = path.join(goalsDir, "goal-1.json");
    await writeFile(
      goalFile,
      JSON.stringify({
        title: "x",
        workdir: "/tmp",
        status: "pending",
        phases: [
          { id: "P1", name: "Plan", status: "pending" },
          { id: "P2", name: "Implement", status: "pending" },
        ],
      }),
      "utf8",
    );

    const output = ["PHASE_COMPLETE: P1", "PHASE_COMPLETE: P1"].join("\n");

    await sendCurrentPhasePrompt(
      {
        goalsDir,
        primaryTransport: new FixedTransport(output),
      },
      goalFile,
      "run",
    );

    const result2 = await sendCurrentPhasePrompt(
      {
        goalsDir,
        primaryTransport: new FixedTransport(output),
      },
      goalFile,
      "run again",
    );

    const p1 = result2.goal.phases.find((p) => p.id === "P1");
    const p2 = result2.goal.phases.find((p) => p.id === "P2");
    expect(p1?.status).toBe("complete");
    expect(p2?.status).toBe("pending");
  });
});
