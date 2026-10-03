import { beforeEach, describe, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import { setupGuidedCustodianTestSuite } from "./onboard-guided.custodian.test-support.js";

const runSearchSetupFlow = vi.hoisted(() => vi.fn());
vi.mock("../flows/search-setup.js", () => ({ runSearchSetupFlow }));

describe("guided onboarding optional search", () => {
  const {
    detection,
    localOnboarding,
    makeRuntime,
    promptAuthChoiceGrouped,
    runGuidedOnboarding,
    setupApplyResult,
    setupDeps,
  } = setupGuidedCustodianTestSuite();

  beforeEach(() => {
    runSearchSetupFlow.mockClear();
    promptAuthChoiceGrouped.mockResolvedValue("candidate:claude-cli");
  });

  it.each([
    { label: "browser", opts: {}, selectValues: ["custom", "full", "use"] },
    { label: "TUI", opts: { tui: true }, selectValues: ["full", "use"] },
    { label: "no UI", opts: { skipUi: true }, selectValues: ["full", "use"] },
  ])("offers search after fresh setup with $label", async ({ opts, selectValues }) => {
    const prompter = createWizardPrompter(undefined, { selectValues });
    const deps = setupDeps({
      prompter,
      runBrowserHandoff: vi.fn(async () => ({ handedOff: true as const })),
    });

    await runGuidedOnboarding({ acceptRisk: true, ...opts }, makeRuntime(), deps);

    expect(deps.applySetup).toHaveBeenCalledOnce();
    expect(prompter.note).toHaveBeenCalledWith(
      expect.stringContaining("openclaw configure --section web"),
      "Search",
    );
    expect(prompter.note).toHaveBeenCalledWith(
      expect.stringContaining("`configure search` in Settings > Ask OpenClaw"),
      "Search",
    );
    expect(prompter.select).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: "Search provider" }),
    );
    expect(deps.detect).toHaveBeenCalledOnce();
    expect(runSearchSetupFlow).not.toHaveBeenCalled();
    expect(localOnboarding.persisted.config?.tools?.web?.search).toBeUndefined();
    expect(localOnboarding.persisted.config?.plugins?.installs).toBeUndefined();
    expect(localOnboarding.states.get("/tmp/openclaw.json")?.status).toBe("completed");
  });

  it.each(["configured rerun", "skipped inference", "failed setup"])(
    "does not offer search after %s",
    async (scenario) => {
      if (scenario === "configured rerun") {
        localOnboarding.persisted.config = {
          gateway: { mode: "local" },
          agents: { defaults: { workspace: "/tmp/openclaw-workspace" } },
        };
      }
      if (scenario === "skipped inference") {
        promptAuthChoiceGrouped.mockResolvedValueOnce("skip");
      }
      const prompter = createWizardPrompter(undefined, { selectValues: ["full", "use"] });
      const deps = setupDeps({
        prompter,
        detect: vi.fn(async () =>
          detection({
            ...(scenario === "skipped inference" ? { candidates: [] } : {}),
            setupComplete: scenario === "configured rerun",
          }),
        ),
        applySetup: vi.fn(async () => ({
          ...setupApplyResult(),
          ...(scenario === "failed setup"
            ? { gateway: { status: "failed" as const, error: "test setup failure" } }
            : {}),
        })),
      });

      await runGuidedOnboarding({ acceptRisk: true, skipUi: true }, makeRuntime(), deps);

      expect(prompter.note).not.toHaveBeenCalledWith(expect.any(String), "Search");
      expect(runSearchSetupFlow).not.toHaveBeenCalled();
    },
  );
});
