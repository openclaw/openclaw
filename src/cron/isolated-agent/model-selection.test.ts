import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveCronModelSelection } from "./model-selection.js";

// Mock the runtime dependencies
vi.mock("../run-model-selection.runtime.js", () => ({
  DEFAULT_PROVIDER: "openai",
  DEFAULT_MODEL: "gpt-4o-mini",
  loadModelCatalog: vi.fn().mockResolvedValue([]),
  getModelRefStatus: vi.fn(),
  normalizeModelSelection: (v: unknown) =>
    typeof v === "string" ? v.trim() || undefined : undefined,
  resolveAllowedModelRef: vi.fn(),
  resolveConfiguredModelRef: vi.fn(),
  resolveHooksGmailModel: vi.fn().mockReturnValue(null),
}));

import { resolveAllowedModelRef, getModelRefStatus, resolveConfiguredModelRef } from "../run-model-selection.runtime.js";

const baseCfg = {} as any;
const baseCfgWithDefaults = {
  agents: { defaults: { model: "openai/gpt-4o-mini" } },
} as any;

describe("resolveCronModelSelection — payload.model allowlist fallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: configured model resolves fine
    (resolveConfiguredModelRef as any).mockReturnValue({
      provider: "openai",
      model: "gpt-4o-mini",
    });
  });

  it("logs ERROR when explicit payload.model is not in allowlist and includes actual provider/model in message", async () => {
    // Simulate ollama model being rejected by allowlist
    (resolveAllowedModelRef as any).mockReturnValue({
      error: "model not allowed: ollama/llama3.2:3b",
      ref: { provider: "ollama", model: "llama3.2:3b" },
    });

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await resolveCronModelSelection({
      cfg: baseCfg,
      cfgWithAgentDefaults: baseCfgWithDefaults,
      sessionEntry: {},
      payload: { kind: "agentTurn", message: "hello", model: "ollama/llama3.2:3b" },
      isGmailHook: false,
    });

    expect(result.ok).toBe(true);
    // Should fall back to defaults
    expect(result.provider).toBe("openai");
    expect(result.model).toBe("gpt-4o-mini");
    // Should include warning about which model was intended vs actual
    expect(result.warning).toContain("ollama/llama3.2:3b");
    expect(result.warning).toContain("openai");
    expect(result.warning).toContain("gpt-4o-mini");

    consoleSpy.mockRestore();
  });

  it("resolves payload.model correctly when model is in allowlist", async () => {
    (resolveAllowedModelRef as any).mockReturnValue({
      ref: { provider: "ollama", model: "llama3.2:3b" },
      key: "ollama/llama3.2:3b",
    });
    (getModelRefStatus as any).mockReturnValue({ allowed: true, key: "ollama/llama3.2:3b", inCatalog: false, allowAny: false });

    const result = await resolveCronModelSelection({
      cfg: baseCfg,
      cfgWithAgentDefaults: baseCfgWithDefaults,
      sessionEntry: {},
      payload: { kind: "agentTurn", message: "hello", model: "ollama/llama3.2:3b" },
      isGmailHook: false,
    });

    expect(result.ok).toBe(true);
    expect(result.provider).toBe("ollama");
    expect(result.model).toBe("llama3.2:3b");
    expect(result.warning).toBeUndefined();
  });
});
