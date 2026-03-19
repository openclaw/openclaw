import { describe, expect, test } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import { applySessionsPatchToStore } from "./sessions-patch.js";

const MAIN_SESSION_KEY = "agent:main:main";

async function runPatch(params: {
  patch: Parameters<typeof applySessionsPatchToStore>[0]["patch"];
  store?: Record<string, SessionEntry>;
  cfg?: OpenClawConfig;
  storeKey?: string;
  loadGatewayModelCatalog?: Parameters<
    typeof applySessionsPatchToStore
  >[0]["loadGatewayModelCatalog"];
}) {
  return applySessionsPatchToStore({
    cfg: params.cfg ?? ({} as OpenClawConfig),
    store: params.store ?? {},
    storeKey: params.storeKey ?? MAIN_SESSION_KEY,
    patch: params.patch,
    loadGatewayModelCatalog: params.loadGatewayModelCatalog,
  });
}

/**
 * Regression test for Issue #50509:
 * Control UI cannot switch Ollama models when model name contains slashes
 *
 * When user enters a bare model ID like "deepseek-ai/DeepSeek-R1-Distill-Qwen-7B"
 * (without explicit provider prefix), the UI sends it as-is to sessions.patch.
 *
 * The bug: parseModelRef treats the bare ID as a provider/model pair (the first
 * segment becomes provider, rest becomes model), resulting in:
 *   - parsed.provider = "deepseek-ai"
 *   - parsed.model = "DeepSeek-R1-Distill-Qwen-7B"
 *
 * Then getModelRefStatus checks against the allowlist which has:
 *   - key = "ollama/deepseek-ai/DeepSeek-R1-Distill-Qwen-7B"
 *
 * The keys don't match → "model not allowed" error.
 */
describe("sessions.patch Ollama model with slashes (Issue #50509)", () => {
  test("accepts bare model ID containing slash when configured provider supports it", async () => {
    // Config with ollama provider and the model aliased or allowlisted
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "ollama/qwen2.5-coder" },
          models: {
            "ollama/deepseek-ai/DeepSeek-R1-Distill-Qwen-7B": {},
          },
        },
      },
    } as OpenClawConfig;

    // User types "deepseek-ai/DeepSeek-R1-Distill-Qwen-7B" in UI (bare ID, no provider prefix)
    const result = await runPatch({
      cfg,
      patch: { key: MAIN_SESSION_KEY, model: "deepseek-ai/DeepSeek-R1-Distill-Qwen-7B" },
      loadGatewayModelCatalog: async () => [
        {
          provider: "ollama",
          id: "deepseek-ai/DeepSeek-R1-Distill-Qwen-7B",
          name: "DeepSeek-R1-Distill-Qwen-7B",
        },
        { provider: "ollama", id: "qwen2.5-coder", name: "qwen2.5-coder" },
      ],
    });

    console.log("Result:", JSON.stringify(result, null, 2));

    // Currently this FAILS with "model not allowed" - that's the bug
    // After fix, it should succeed
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.entry.modelOverride).toBe("deepseek-ai/DeepSeek-R1-Distill-Qwen-7B");
      expect(result.entry.providerOverride).toBe("ollama");
    }
  });
});
