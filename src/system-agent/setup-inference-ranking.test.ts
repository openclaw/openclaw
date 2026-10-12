import { describe, expect, it } from "vitest";
import type { SetupInferenceCandidate } from "./setup-inference-core.js";
import { rankSetupInferenceCandidates } from "./setup-inference-ranking.js";

function candidate(
  kind: SetupInferenceCandidate["kind"],
  overrides: Partial<SetupInferenceCandidate> = {},
): SetupInferenceCandidate {
  return {
    kind,
    label: kind,
    detail: "available",
    modelRef: "fixture/model",
    recommended: false,
    ...overrides,
  };
}

describe("first-run inference ranking", () => {
  it("ranks supported primary routes deterministically without promoting utility or unknown routes", () => {
    const candidates = [
      candidate("provider-auto:ollama", { modelRef: "ollama/loaded" }),
      candidate("provider-auto:llama-cpp", { modelRef: "llama-cpp/loaded" }),
      candidate("provider-auto:lmstudio", { modelRef: "lmstudio/loaded" }),
      candidate("provider-auto:unknown", { credentials: true }),
      candidate("codex-cli"),
      candidate("codex-cli", { credentials: false }),
      candidate("provider-auto:apple", { modelTarget: "utility", credentials: true }),
      candidate("existing-model", { modelTarget: "utility" }),
      candidate("anthropic-api-key", { credentials: true }),
      candidate("openai-api-key", { credentials: true }),
      candidate("claude-cli"),
      candidate("gemini-cli", { credentials: true }),
      candidate("codex-cli", { credentials: true }),
      candidate("saved-auth:z", { credentials: true }),
      candidate("saved-auth:a", { credentials: true }),
      candidate("existing-model", { credentials: true }),
    ];
    const expected = [
      "existing-model",
      "saved-auth:a",
      "saved-auth:z",
      "codex-cli",
      "claude-cli",
      "openai-api-key",
      "anthropic-api-key",
      "provider-auto:ollama",
      "provider-auto:lmstudio",
      "provider-auto:llama-cpp",
    ];

    expect(rankSetupInferenceCandidates(candidates).map(({ kind }) => kind)).toEqual(expected);
    expect(rankSetupInferenceCandidates(candidates.toReversed()).map(({ kind }) => kind)).toEqual(
      expected,
    );
  });
});
