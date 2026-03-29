import { describe, expect, it } from "vitest";

describe("provider-vllm-setup", () => {
  it("loads provider-setup without recursing through the vllm facade", async () => {
    const providerSetup = await import("../plugin-sdk/provider-setup.js");
    const vllm = await import("../plugin-sdk/vllm.js");

    expect(providerSetup.VLLM_DEFAULT_BASE_URL).toBe("http://127.0.0.1:8000/v1");
    expect(typeof providerSetup.buildVllmProvider).toBe("function");
    expect(vllm.VLLM_DEFAULT_API_KEY_ENV_VAR).toBe("VLLM_API_KEY");
    expect(vllm.VLLM_MODEL_PLACEHOLDER).toBe("meta-llama/Meta-Llama-3-8B-Instruct");
    expect(vllm.VLLM_PROVIDER_LABEL).toBe("vLLM");
  });
});
