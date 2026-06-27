import { describe, expect, it } from "vitest";
import {
  createSnesOutputBenchmarkReport,
  scoreSnesOutputBenchmarkResponse,
  SNES_BENCHMARK_TASKS,
} from "../../scripts/lib/snes-local-model-benchmark.mjs";

function ollamaResponse(raw: string) {
  return {
    error: null,
    status: 0,
    stderr: "",
    stdout: JSON.stringify({ response: "", thinking: raw }),
  };
}

function validRoleOutput(role: string, taskId: string) {
  return JSON.stringify({
    role,
    taskId,
    changedSurface: "/gamePlan/premise",
    content:
      role === "snes-art-audio"
        ? "SNES tile sprite palette music sound SFX package."
        : "SNES JSON patch receipt with safe constraint details.",
    constraintsRespected: ["SNES safe", "finishable"],
    playtestHypothesis: "first 30 seconds test proves the route and asset contract",
    riskBlocker: "none",
    patch: [{ op: "replace", path: "/gamePlan/premise", value: "SNES platformer" }],
    receipt: ["changed premise", "safe patch path"],
  });
}

describe("SNES local model benchmark", () => {
  it("benchmarks requested installed model refs outside the built-in candidate list", () => {
    const customModel = "ollama/custom-coder:latest";
    const report = createSnesOutputBenchmarkReport({
      candidateModelRefs: [customModel],
      installedModelRefs: [customModel],
      judge: "none",
      maxOutputTokens: 300,
      noDownload: true,
      roles: ["snes-art-audio"],
      rounds: 1,
      spawn: () => ollamaResponse(validRoleOutput("snes-art-audio", "snes-asset-specificity")),
      timeoutSeconds: 30,
    });

    expect(report.candidates).toEqual([
      { modelRef: customModel, reason: "User-requested installed local benchmark candidate." },
    ]);
    expect(report.results).toHaveLength(1);
    expect(report.results[0]).toMatchObject({
      available: true,
      modelRef: customModel,
      skipped: false,
      status: "pass",
    });
  });

  it("uses Ollama thinking JSON when response is empty", () => {
    const customModel = "ollama/thinking-json:latest";
    const raw = validRoleOutput("snes-art-audio", "snes-asset-specificity");
    const report = createSnesOutputBenchmarkReport({
      candidateModelRefs: [customModel],
      installedModelRefs: [customModel],
      judge: "none",
      maxOutputTokens: 300,
      noDownload: true,
      roles: ["snes-art-audio"],
      rounds: 1,
      spawn: () => ollamaResponse(raw),
      timeoutSeconds: 30,
    });

    expect(report.results[0]?.raw).toBe(raw);
    expect(report.results[0]?.parsed).toMatchObject({ role: "snes-art-audio" });
    expect(report.results[0]?.caps).not.toContain("invalid-json-cap-49");
  });

  it("fails invalid JSON responses", () => {
    const task = SNES_BENCHMARK_TASKS.find((entry) => entry.role === "snes-art-audio")!;
    const scored = scoreSnesOutputBenchmarkResponse({ raw: "not json", task });

    expect(scored.status).toBe("fail");
    expect(scored.score).toBe(0);
    expect(scored.caps).toContain("invalid-json-cap-49");
  });

  it("fails unsafe patch operations", () => {
    const task = SNES_BENCHMARK_TASKS.find((entry) => entry.role === "snes-hardware-qa")!;
    const scored = scoreSnesOutputBenchmarkResponse({
      raw: JSON.stringify({
        role: "snes-hardware-qa",
        taskId: task.id,
        changedSurface: "/gamePlan/premise",
        content: "ROM SRAM VRAM CGRAM FXPAK export check.",
        constraintsRespected: ["SNES safe", "finishable"],
        playtestHypothesis: "first 30 seconds test proves export blockers",
        riskBlocker: "none",
        patch: [{ op: "r", path: "/gP/r", value: "bad" }],
        receipt: ["changed premise", "safe patch path"],
      }),
      task,
    });

    expect(scored.status).toBe("fail");
    expect(scored.score).toBeLessThanOrEqual(39);
    expect(scored.caps).toContain("unsafe-or-missing-patch-cap-39");
  });
});
