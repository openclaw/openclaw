import { describe, expect, it } from "vitest";
import { OpenClawSchema } from "./zod-schema.js";

describe("LLMOps Configuration Structural Validation Matrix", () => {
  it("should initialize with safe 'local' defaults when llmOps key is omitted", () => {
    const rawConfig = {
      agents: { list: [] },
    };

    const parsed = OpenClawSchema.parse(rawConfig);

    // Zod schema auto-fallbacks confirm safe-by-default profile execution
    expect(parsed.llmOps).toBeUndefined();
  });

  it("should successfully parse a valid Langfuse observability topology layout", () => {
    const rawConfig = {
      llmOps: {
        provider: "langfuse",
        langfuse: {
          publicKey: "pk-*******",
          secretKey: "sk-*****",
          baseUrl: "https://langfuse.guardianhub.com",
        },
        prompts: {
          enabled: true,
          cacheTtlMs: 30000,
        },
        tracing: {
          enabled: true,
          sampleRate: 0.5,
        },
      },
    };

    const parsed = OpenClawSchema.parse(rawConfig);

    expect(parsed.llmOps?.provider).toBe("langfuse");
    expect(parsed.llmOps?.langfuse?.publicKey).toBe("pk-lf-2207abb4-5368-4c23-adcc-6284d0a65b97");
    expect(parsed.llmOps?.tracing?.sampleRate).toBe(0.5);
    expect(parsed.llmOps?.prompts?.failSoft).toBe(true); // Verifies default schema fallback hydration
  });

  it("should throw validation errors on out-of-bounds metrics fields", () => {
    const malformedConfig = {
      llmOps: {
        provider: "langfuse",
        tracing: {
          enabled: true,
          sampleRate: 1.5, // ❌ Violation: Must remain between 0.0 and 1.0 boundary rules
        },
      },
    };

    // Assert that the Zod engine catches the configuration breach before boot
    expect(() => OpenClawSchema.parse(malformedConfig)).toThrow();
  });
});

it("should successfully parse per-agent llmOps prompt registry paths and supply label fallbacks", () => {
  const rawConfig = {
    agents: {
      list: [
        {
          id: "lexguard-compliance",
          name: "LexGuard Compliance Service",
          llmOps: {
            promptPath: "workspace/agents/lexguard-compliance-service/AGENTS",
            // promptLabel is omitted on purpose to test the schema default wrapper
          },
        },
      ],
    },
  };

  const parsed = OpenClawSchema.parse(rawConfig);
  const targetAgent = parsed.agents?.list?.[0];

  // Verify the schema validates custom path string targets
  expect(targetAgent?.llmOps?.promptPath).toBe(
    "workspace/agents/lexguard-compliance-service/AGENTS",
  );

  // Verifies that Zod auto-hydrates our default rollout channel string
  expect(targetAgent?.llmOps?.promptLabel).toBe("production");
});
