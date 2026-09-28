import path from "node:path";
import { vi, type Mock } from "vitest";
import type { UpdateRepairInferenceResult } from "../infra/update-repair-inference.js";

export function createTriageInferenceSelection(stateDir: string): UpdateRepairInferenceResult {
  return {
    ok: true,
    route: {
      runner: "embedded",
      agentId: "main",
      provider: "fixture",
      model: "repair",
      modelLabel: "fixture/repair",
      agentDir: path.join(stateDir, "agents/main/agent"),
      runConfig: {},
      sourceConfig: {},
    },
    modelFallbacks: [],
  };
}

export function resetTriageRepairRuntimeMocks(
  mocks: {
    prepareUpdateRepairInference: Mock;
    runUpdateRepairTurn: Mock;
    runUpdateRepairLoop: Mock;
  },
  stateDir: string,
) {
  mocks.runUpdateRepairLoop.mockResolvedValue({
    status: "repaired",
    attempts: [],
    finalValidation: { ok: true, score: 0, summary: "Doctor lint reports no errors." },
  });
  mocks.prepareUpdateRepairInference
    .mockReset()
    .mockResolvedValue(createTriageInferenceSelection(stateDir));
  mocks.runUpdateRepairTurn.mockReset().mockResolvedValue({
    status: "completed",
    toolCalls: 0,
    envelope: { status: "ok", final: "Repair completed." },
  });
}

export function createTriageRuntime() {
  return { log: vi.fn(), error: vi.fn(), exit: vi.fn(), writeStdout: vi.fn(), writeJson: vi.fn() };
}

export async function withTriageTerminal(interactive: boolean, run: () => Promise<void>) {
  const streams = [process.stdin, process.stdout];
  const descriptors = streams.map((stream) => Object.getOwnPropertyDescriptor(stream, "isTTY"));
  for (const stream of streams) {
    Object.defineProperty(stream, "isTTY", { configurable: true, value: interactive });
  }
  try {
    await run();
  } finally {
    streams.forEach((stream, index) => {
      const descriptor = descriptors[index];
      if (descriptor) {
        Object.defineProperty(stream, "isTTY", descriptor);
      } else {
        Reflect.deleteProperty(stream, "isTTY");
      }
    });
  }
}
