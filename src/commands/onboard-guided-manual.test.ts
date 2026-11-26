import { describe, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import type { WizardSelectParams } from "../wizard/prompts.js";
import { runManualStage } from "./onboard-guided-manual.js";

vi.mock("../agents/auth-profiles.runtime.js", () => ({
  ensureAuthProfileStore: () => ({ version: 1, profiles: {} }),
}));
vi.mock("../plugins/provider-setup-availability.js", () => ({
  detectAvailableSetupProviderIds: async () => new Set(),
}));
vi.mock("../flows/provider-flow.js", () => ({
  resolveProviderSetupFlowContributions: () => [
    {
      providerId: "fixture",
      source: "install-catalog",
      option: {
        value: "fixture-api-key",
        label: "Fixture API key",
        group: { id: "fixture", label: "Fixture" },
      },
    },
  ],
}));

describe("guided provider catalog", () => {
  it.each(["newly saved", "previously saved"])(
    "lets the user select a different model with a %s sign-in after verification fails",
    async (source) => {
      const savedKind = "saved-auth:fixture%3Asetup" as const;
      const modelRef = "fixture/previously-selected";
      const alternateModelRef = "fixture/team/alternate@20261124";
      const savedCandidate = {
        kind: savedKind,
        modelRef,
        label: "Saved fixture sign-in",
        detail: modelRef,
        recommended: false,
        credentials: true,
      };
      const alreadySaved = source === "previously saved";
      const detection = {
        candidates: alreadySaved ? [savedCandidate] : [],
        unavailableCandidates: [],
        manualProviders: [],
        authOptions: [],
        recommendedInstalls: [],
        workspace: "/tmp/fixture-workspace",
        setupComplete: false,
      };
      let profileSaved = alreadySaved;
      const activate = vi.fn<Parameters<typeof runManualStage>[0]["activate"]>();
      activate
        .mockImplementationOnce(async () => {
          profileSaved = true;
          return {
            ok: false,
            status: "timeout",
            error: "Fixture verification failed after saving sign-in",
          };
        })
        .mockResolvedValueOnce({
          ok: true,
          modelRef: alternateModelRef,
          lines: ["Connected"],
          latencyMs: 1,
        });
      const refreshSavedCandidates = vi.fn(async () => (profileSaved ? [savedCandidate] : []));
      const choices = [alreadySaved ? "detected-ai" : "fixture", "detected-ai"];
      const prompter = createWizardPrompter();
      vi.mocked(prompter.text).mockImplementation(async ({ initialValue, validate, sensitive }) => {
        expect(activate).toHaveBeenCalledTimes(1);
        expect(initialValue).toBe("previously-selected");
        expect(sensitive).not.toBe(true);
        expect(validate?.("  ")).toBeTruthy();
        expect(validate?.("@other:profile")).toBeTruthy();
        expect(validate?.("alternate@other:profile")).toBeTruthy();
        expect(validate?.("team/alternate@20261124")).toBeUndefined();
        return " team/alternate@20261124 ";
      });
      vi.mocked(prompter.select).mockImplementation(
        async <T>({ options }: WizardSelectParams<T>) => {
          const expected = choices.shift();
          const choice = options.find((option) => option.value === expected);
          if (!choice) {
            throw new Error("Picker did not offer " + expected);
          }
          return choice.value;
        },
      );
      const params = {
        detection,
        refreshSavedCandidates,
        config: {},
        workspace: detection.workspace,
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() as never },
        prompter,
        activate,
      };
      await expect(runManualStage(params)).resolves.toContain("Connected");
      expect(refreshSavedCandidates).toHaveBeenCalledTimes(alreadySaved ? 0 : 1);
      expect(activate).toHaveBeenCalledTimes(2);
      expect(activate).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining(
          alreadySaved
            ? { kind: savedKind, modelRef }
            : { kind: "provider-auth", authChoice: "fixture-api-key" },
        ),
      );
      expect(activate).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ kind: savedKind, modelRef: alternateModelRef }),
      );
      expect(activate.mock.calls[1]?.[0].authChoice).toBeUndefined();
      expect(prompter.text).toHaveBeenCalledOnce();
    },
  );
  it("offers an install-catalog provider before its manifest is installed", async () => {
    const activate = vi.fn(async () => ({
      ok: true as const,
      lines: ["Connected"],
      latencyMs: 1,
      modelRef: "fixture/default",
    }));
    const prompter = createWizardPrompter({}, { selectValues: ["fixture"] });
    vi.mocked(prompter.select).mockImplementationOnce(
      async <T>({ options }: WizardSelectParams<T>): Promise<T> => {
        const provider = options.find((option) => option.value === "fixture");
        expect(provider).toBeDefined();
        if (!provider) {
          throw new Error("The official install-catalog provider is missing.");
        }
        return provider.value;
      },
    );
    await expect(
      runManualStage({
        detection: {
          candidates: [],
          unavailableCandidates: [],
          manualProviders: [],
          authOptions: [],
          recommendedInstalls: [],
          workspace: "/tmp/fixture-workspace",
          setupComplete: false,
        },
        config: {},
        workspace: "/tmp/fixture-workspace",
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() as never },
        prompter,
        activate,
      }),
    ).resolves.toContain("Connected");
    expect(activate).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "provider-auth", authChoice: "fixture-api-key" }),
    );
  });
});
