import { describe, it, expect } from "vitest";
import { AllowlistProvider } from "../../src/guardrails/builtin.js";
import type { GuardrailRequest } from "../../src/guardrails/types.js";

function makeRequest(toolName: string): GuardrailRequest {
  return { toolName, toolInput: {}, timestamp: new Date().toISOString() };
}

describe("AllowlistProvider", () => {
  it("allows all tools when no lists configured", async () => {
    const provider = new AllowlistProvider();
    const decision = await provider.evaluate(makeRequest("exec"));
    expect(decision.allow).toBe(true);
  });

  it("allows tool in allowedTools", async () => {
    const provider = new AllowlistProvider({ allowedTools: ["exec", "write"] });
    const decision = await provider.evaluate(makeRequest("exec"));
    expect(decision.allow).toBe(true);
  });

  it("denies tool not in allowedTools", async () => {
    const provider = new AllowlistProvider({ allowedTools: ["exec"] });
    const decision = await provider.evaluate(makeRequest("browser"));
    expect(decision.allow).toBe(false);
    expect(decision.reasons?.[0].code).toBe("tool_not_allowed");
  });

  it("denies tool in deniedTools", async () => {
    const provider = new AllowlistProvider({ deniedTools: ["exec"] });
    const decision = await provider.evaluate(makeRequest("exec"));
    expect(decision.allow).toBe(false);
    expect(decision.reasons?.[0].code).toBe("tool_denied");
  });

  it("deniedTools takes precedence over allowedTools", async () => {
    const provider = new AllowlistProvider({ allowedTools: ["exec"], deniedTools: ["exec"] });
    const decision = await provider.evaluate(makeRequest("exec"));
    expect(decision.allow).toBe(false);
    expect(decision.reasons?.[0].code).toBe("tool_denied");
  });

  it("allows tool not in deniedTools when no allowedTools", async () => {
    const provider = new AllowlistProvider({ deniedTools: ["exec"] });
    const decision = await provider.evaluate(makeRequest("write"));
    expect(decision.allow).toBe(true);
  });

  it("coerces string deniedTools to array", async () => {
    const provider = new AllowlistProvider({ deniedTools: "exec" as unknown as string[] });
    const decision = await provider.evaluate(makeRequest("exec"));
    expect(decision.allow).toBe(false);
  });

  it("has correct name", () => {
    const provider = new AllowlistProvider();
    expect(provider.name).toBe("allowlist");
  });
});
