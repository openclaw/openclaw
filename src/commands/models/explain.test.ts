import { describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../../runtime.js";
import { modelsExplainCommand } from "./explain.js";

vi.mock("./load-config.js", () => ({
  loadModelsConfigWithSource: vi.fn(async () => ({
    sourceConfig: {
      agents: {
        list: [{ id: "main", default: true }],
        defaults: {
          model: "openai/gpt-4.1",
          models: {
            "openai-codex/gpt-5.4": {},
          },
        },
      },
    },
    resolvedConfig: {
      agents: {
        list: [{ id: "main", default: true }],
        defaults: {
          model: "openai/gpt-4.1",
          models: {
            "openai-codex/gpt-5.4": {},
          },
        },
      },
    },
    diagnostics: [],
  })),
}));

describe("modelsExplainCommand", () => {
  it("writes JSON explanation including inferred family routing", async () => {
    const writeJson = vi.fn();
    const runtime = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
      writeStdout: vi.fn(),
      writeJson,
    } as unknown as RuntimeEnv & { writeJson: (value: unknown, space?: number) => void };

    await modelsExplainCommand(
      {
        model: "gpt-5.4",
        json: true,
      },
      runtime as never,
    );

    expect(writeJson).toHaveBeenCalledWith(
      expect.objectContaining({
        resolved: {
          provider: "openai-codex",
          model: "gpt-5.4",
        },
        inferredFamilyRoutingApplied: true,
      }),
      2,
    );
  });
});
