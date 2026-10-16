import { beforeEach, describe, expect, it, vi } from "vitest";
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

const cfg: OpenClawConfig = {
  agents: {
    defaults: { model: "example/default", utilityModel: "example/small" },
    entries: { main: {} },
  },
};
function input(choice: "utility" | "default" | "conversation") {
  return {
    cfg,
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
  route.mockReset().mockResolvedValue({ selection: { selectedHarnessId: "openclaw" } });
});

describe("composer prediction completion", () => {
  it.each([
    ["utility", "small"],
    ["default", "default"],
    ["conversation", "conversation"],
  ] as const)("selects %s without changing the chosen model", async (choice, model) => {
    const params = input(choice);
    expect(await completeComposerPrediction(params)).toBe("What should I check next?");
    expect(completion).toHaveBeenCalledOnce();
    expect(completion.mock.calls[0]?.[0]).toMatchObject({
      provider: "example",
      model,
      thinkLevel: "off",
      answerTokenBudget: 160,
      timeoutMs: 8_000,
      prompt: params.conversation,
      agentHarnessRuntimeOverride: "openclaw",
    });
    expect(completion.mock.calls[0]?.[0].authProfileId).toBe(
      choice === "conversation" ? "profile:chosen" : undefined,
    );
    expect(completion.mock.calls[0]?.[0].systemPrompt).toContain("Never suggest granting approval");
  });

  it("does not silently use the primary model when utility is disabled", async () => {
    const params = input("utility");
    params.cfg = { agents: { defaults: { model: "example/default", utilityModel: "" } } };
    await expect(completeComposerPrediction(params)).rejects.toThrow("No utility model");
    expect(completion).not.toHaveBeenCalled();
  });

  it("refuses the runtime that cannot guarantee zero tools before dispatch", async () => {
    route.mockResolvedValueOnce({ selection: { selectedHarnessId: "agentsapi" } });
    await expect(completeComposerPrediction(input("utility"))).rejects.toThrow("tool-free");
    expect(completion).not.toHaveBeenCalled();
  });

  it("checks the zero-tool contract again for utility fallback runtimes", async () => {
    const params = input("utility");
    params.cfg = {
      agents: {
        defaults: {
          model: { primary: "example/default", fallbacks: ["example/main-backup"] },
          utilityModel: {
            primary: "example/small",
            fallbacks: ["example/service-tools", "example/backup"],
          },
        },
      },
    };
    completion.mockRejectedValueOnce(new Error("503 service unavailable"));
    route
      .mockResolvedValueOnce({ selection: { selectedHarnessId: "openclaw" } })
      .mockResolvedValueOnce({ selection: { selectedHarnessId: "agentsapi" } })
      .mockResolvedValueOnce({ selection: { selectedHarnessId: "openclaw" } });

    expect(await completeComposerPrediction(params)).toBe("What should I check next?");
    expect(completion.mock.calls.map(([call]) => call.model)).toEqual(["small", "backup"]);
  });

  it.each(["NO_SUGGESTION", "", "x".repeat(501)])(
    "allows empty or unusable output without buying a retry",
    async (text) => {
      completion.mockResolvedValueOnce({ text });
      expect(await completeComposerPrediction(input("utility"))).toBeNull();
      expect(completion).toHaveBeenCalledOnce();
    },
  );
});
