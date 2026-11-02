import { beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { completeComposerPrediction } from "./composer-prediction-completion.js";

const { completion, route } = vi.hoisted(() => ({ completion: vi.fn(), route: vi.fn() }));
// mock-isolation: Model-selection tests must not initialize inference runtimes or credential owners.
vi.mock("../agents/isolated-completion.js", () => ({ runIsolatedCompletion: completion }));
// mock-isolation: Fixture routes must not discover real CLI backends or process-wide model auth.
vi.mock("../agents/isolated-completion-route.js", () => ({
  resolveIsolatedCompletionProvider: (selection: {
    provider: string;
    agentHarnessRuntimeOverride?: string;
  }) => ({ provider: selection.provider, runtimeOverride: selection.agentHarnessRuntimeOverride }),
  resolveIsolatedCompletionRoute: route,
}));

const defaults = { model: "example/default", utilityModel: "example/small" };
const modelWithFallbacks = (primary: string, ...fallbacks: string[]) => ({ primary, fallbacks });
const runtime = (selectedHarnessId: string) => ({ selection: { selectedHarnessId } });
function input(
  choice: "utility" | "default" | "conversation",
  models: NonNullable<OpenClawConfig["agents"]>["defaults"] = defaults,
) {
  return {
    cfg: { agents: { defaults: models } },
    agentId: "main",
    sessionKey: "agent:main:prediction",
    choice,
    entry: {
      sessionId: "s",
      updatedAt: 1,
      providerOverride: "example",
      modelOverride: "conversation",
      authProfileOverride: "profile:chosen",
    },
    conversation: '[{"role":"user","text":"Keep the current constraints."}]',
    assertCurrent: vi.fn(),
  };
}
beforeEach(() => {
  completion.mockReset().mockResolvedValue({ text: "What should I check next?" });
  route.mockReset().mockResolvedValue(runtime("openclaw"));
});

it.each([
  ["utility", "small"],
  ["default", "default"],
  ["conversation", "conversation"],
] as const)("selects the %s model", async (choice, model) => {
  const params = input(choice);
  expect(await completeComposerPrediction(params)).toBe("What should I check next?");
  expect(completion).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      provider: "example",
      model,
      purpose: "composer-prediction",
      thinkLevel: "off",
      answerTokenBudget: 160,
      timeoutMs: 8_000,
      prompt: params.conversation,
      agentHarnessRuntimeOverride: "openclaw",
      systemPrompt: expect.stringContaining("Never suggest granting approval"),
      authProfileId: choice === "conversation" ? "profile:chosen" : undefined,
    }),
  );
});

it.each([
  [{ ...defaults, utilityModel: "" }, "openclaw", "No utility model"],
  [defaults, "agentsapi", "tool-free"],
] as const)("rejects %s via %s: %s", async (configuration, harness, error) => {
  route.mockResolvedValueOnce(runtime(harness));
  await expect(completeComposerPrediction(input("utility", configuration))).rejects.toThrow(error);
  expect(completion).not.toHaveBeenCalled();
});

it("checks the zero-tool contract again for utility fallback runtimes", async () => {
  const params = input("utility", {
    model: modelWithFallbacks("example/default", "example/main-backup"),
    utilityModel: modelWithFallbacks("example/small", "example/service-tools", "example/backup"),
  });
  completion.mockRejectedValueOnce(new Error("503 service unavailable"));
  for (const harness of ["openclaw", "agentsapi", "openclaw"]) {
    route.mockResolvedValueOnce(runtime(harness));
  }

  expect(await completeComposerPrediction(params)).toBe("What should I check next?");
  expect(completion.mock.calls.map(([call]) => [call.model, call.purpose])).toEqual([
    ["small", "composer-prediction"],
    ["backup", "composer-prediction"],
  ]);
});

it.each(["NO_SUGGESTION", "", "x".repeat(501)])("does not retry unusable output", async (text) => {
  completion.mockResolvedValueOnce({ text });
  expect(await completeComposerPrediction(input("utility"))).toBeNull();
  expect(completion).toHaveBeenCalledOnce();
});
