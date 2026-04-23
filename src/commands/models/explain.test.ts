import { describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../../runtime.js";
import { modelsExplainCommand } from "./explain.js";

vi.mock("../../config/sessions.js", () => ({
  loadSessionStore: vi.fn(() => ({
    "agent:main:main": {
      sessionId: "sess-main",
      updatedAt: 100,
      modelProvider: "openai-codex",
      model: "gpt-5.4",
      modelOverride: "gpt-5.4",
    },
  })),
}));

vi.mock("../../gateway/session-utils.js", async () => {
  const actual = await vi.importActual<typeof import("../../gateway/session-utils.js")>(
    "../../gateway/session-utils.js",
  );
  return {
    ...actual,
    resolveGatewaySessionStoreTarget: vi.fn(() => ({
      agentId: "main",
      storePath: "/tmp/sessions.json",
      canonicalKey: "agent:main:main",
      storeKeys: ["agent:main:main"],
    })),
  };
});

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
        resolved: expect.objectContaining({
          model: "gpt-5.4",
        }),
        resolution: expect.objectContaining({
          explicitProviderOverrideApplied: null,
          explicitModelOverrideApplied: "gpt-5.4",
        }),
      }),
      2,
    );
  });

  it("can explain provider/model resolution for a persisted session", async () => {
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
        session: "agent:main:main",
        json: true,
      },
      runtime as never,
    );

    expect(writeJson).toHaveBeenCalledWith(
      expect.objectContaining({
        session: {
          key: "agent:main:main",
          storePath: "/tmp/sessions.json",
        },
        input: expect.objectContaining({
          runtimeProvider: "openai-codex",
          runtimeModel: "gpt-5.4",
          modelOverride: "gpt-5.4",
        }),
        resolved: expect.objectContaining({
          model: "gpt-5.4",
        }),
      }),
      2,
    );
  });

  it("renders a more human-readable text explanation", async () => {
    const log = vi.fn();
    const runtime = {
      log,
      error: vi.fn(),
      exit: vi.fn(),
      writeStdout: vi.fn(),
      writeJson: vi.fn(),
    } as unknown as RuntimeEnv & { writeJson: (value: unknown, space?: number) => void };

    await modelsExplainCommand(
      {
        model: "gpt-5.4",
      },
      runtime as never,
    );

    expect(log).toHaveBeenCalledWith(expect.stringContaining("Default resolved"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Model override"));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Final resolved"));
  });
});
