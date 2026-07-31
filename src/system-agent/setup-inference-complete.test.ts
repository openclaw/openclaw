import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { completeSetupInferenceConfig } from "./setup-inference-verify.js";

const mocks = vi.hoisted(() => ({
  buildTestPlan: vi.fn(),
  cleanupSetupInferenceTempDir: vi.fn(),
  runSetupInferenceTest: vi.fn(),
}));

vi.mock("./setup-inference-plan.js", () => ({
  buildTestPlan: mocks.buildTestPlan,
}));

vi.mock("./setup-inference-persist.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./setup-inference-persist.js")>()),
  cleanupSetupInferenceTempDir: mocks.cleanupSetupInferenceTempDir,
  runSetupInferenceTest: mocks.runSetupInferenceTest,
}));

const runtime = { log: () => {}, error: () => {}, exit: () => {} } as never;

describe("setup inference completion", () => {
  beforeEach(() => {
    mocks.buildTestPlan.mockReset();
    mocks.cleanupSetupInferenceTempDir.mockReset();
    mocks.runSetupInferenceTest.mockReset();
    mocks.buildTestPlan.mockResolvedValue({ modelRef: "openai/gpt-5.5" });
    mocks.runSetupInferenceTest.mockResolvedValue({
      ok: true,
      latencyMs: 1,
      text: "completed",
      auth: {},
    });
  });

  it("completes through the explicitly verified agent in an ownerless fleet", async () => {
    const config = {
      agents: {
        ownership: "explicit",
        entries: {
          ops: { model: "openai/gpt-5.5" },
          research: { model: "google/gemini-3.1-pro-preview" },
        },
      },
    } satisfies OpenClawConfig;

    await expect(
      completeSetupInferenceConfig({
        config,
        prompt: "Complete setup.",
        agentId: "ops",
        runtime,
        deps: { createTempDir: async () => "/tmp/setup-inference-complete" },
      }),
    ).resolves.toMatchObject({
      ok: true,
      modelRef: "openai/gpt-5.5",
      text: "completed",
    });
    expect(mocks.buildTestPlan).toHaveBeenCalledWith(
      expect.objectContaining({ routeAgentId: "ops" }),
    );
  });
});
