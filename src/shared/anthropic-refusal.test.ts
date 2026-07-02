// Covers Anthropic refusal normalization and failover signal shaping.
import { describe, expect, it } from "vitest";
import type { AssistantMessageDiagnostic } from "../llm/types.js";
import { applyAnthropicRefusal } from "./anthropic-refusal.js";

describe("applyAnthropicRefusal", () => {
  it("sets stopReason=error, errorCode=provider_refusal, and a readable message", () => {
    const output = { stopReason: "stop" } as {
      stopReason: string;
      errorMessage?: string;
      errorCode?: string;
      diagnostics?: AssistantMessageDiagnostic[];
    };

    applyAnthropicRefusal(
      output,
      { category: "bio", explanation: "Contains unsafe biological content" },
      "anthropic",
    );

    expect(output.stopReason).toBe("error");
    expect(output.errorCode).toBe("provider_refusal");
    expect(output.errorMessage).toMatch(
      /Anthropic refusal \(category: bio\): Contains unsafe biological content/,
    );
    expect(output.diagnostics).toEqual([
      {
        type: "provider_refusal",
        timestamp: expect.any(Number),
        details: {
          provider: "anthropic",
          category: "bio",
          explanation: "Contains unsafe biological content",
        },
      },
    ]);
  });

  it("preserves existing diagnostics", () => {
    const output = {
      stopReason: "stop",
      diagnostics: [{ type: "existing" }],
    } as {
      stopReason: string;
      errorMessage?: string;
      errorCode?: string;
      diagnostics?: AssistantMessageDiagnostic[];
    };

    applyAnthropicRefusal(output, { category: "legal" }, "anthropic");

    expect(output.diagnostics).toHaveLength(2);
    expect(output.diagnostics?.[0]).toEqual({ type: "existing" });
    expect(output.diagnostics?.[1]).toMatchObject({ type: "provider_refusal" });
  });

  it("handles null category and explanation gracefully", () => {
    const output = { stopReason: "stop" } as {
      stopReason: string;
      errorMessage?: string;
      errorCode?: string;
      diagnostics?: AssistantMessageDiagnostic[];
    };

    applyAnthropicRefusal(
      output,
      { category: null as unknown as string, explanation: null as unknown as string },
      "anthropic",
    );

    expect(output.stopReason).toBe("error");
    expect(output.errorCode).toBe("provider_refusal");
    expect(output.errorMessage).toMatch(/Anthropic refusal/);
    expect(output.diagnostics?.[0]).toMatchObject({ type: "provider_refusal" });
  });

  it("handles malformed stopDetails input without throwing", () => {
    const output = { stopReason: "stop" } as {
      stopReason: string;
      errorMessage?: string;
      errorCode?: string;
      diagnostics?: AssistantMessageDiagnostic[];
    };

    applyAnthropicRefusal(
      output,
      "not-an-object" as unknown as Record<string, unknown>,
      "anthropic",
    );

    expect(output.stopReason).toBe("error");
    expect(output.errorCode).toBe("provider_refusal");
    expect(output.errorMessage).toMatch(/Anthropic refusal/);
  });

  it("handles null stopDetails by producing a minimal refusal message", () => {
    const output = { stopReason: "sensitive" } as {
      stopReason: string;
      errorMessage?: string;
      errorCode?: string;
      diagnostics?: AssistantMessageDiagnostic[];
    };

    applyAnthropicRefusal(output, null as unknown as Record<string, unknown>, "anthropic");

    expect(output.stopReason).toBe("error");
    expect(output.errorCode).toBe("provider_refusal");
    expect(output.errorMessage).toMatch(/Anthropic refusal/);
    expect(output.diagnostics?.[0]).toMatchObject({ type: "provider_refusal" });
  });
});
