import { vi } from "vitest";
import { runGuidedOnboarding, type GuidedOnboardingDeps } from "./onboard-guided.js";

export type GuidedOrchestrationFixture = GuidedOnboardingDeps & {
  createPrompter?: typeof import("../wizard/clack-prompter.js").createClackPrompter;
  listManualOptions?: typeof import("../system-agent/setup-inference.js").listManualSetupInferenceOptions;
  applySetup?: typeof import("../system-agent/setup-apply.js").applySystemAgentSetup;
  runMemorySetupFlow?: typeof import("../flows/memory-setup.js").runMemorySetupFlow;
  runAppRecommendations?: typeof import("../wizard/setup.app-recommendations.js").setupAppRecommendations;
  runBrowserHandoff?: typeof import("./onboard-browser-handoff.js").runBrowserHatchHandoff;
  launchHatchTui?: typeof import("../tui/tui-launch.js").launchTuiCli;
  runForegroundGateway?: typeof import("./onboard-quickstart-host.js").runQuickstartForegroundGateway;
  observeHandoff?: (
    handoff: Parameters<
      typeof import("./onboard-interactive-runner.js").runGuidedOnboardingHandoff
    >[0],
  ) => void;
};

export async function runGuidedOnboardingWithFixtures(
  opts: Parameters<typeof runGuidedOnboarding>[0],
  runtime: Parameters<typeof runGuidedOnboarding>[1],
  fixtures: GuidedOrchestrationFixture = {},
) {
  const {
    createPrompter,
    listManualOptions,
    applySetup,
    runMemorySetupFlow,
    runAppRecommendations,
    runBrowserHandoff,
    launchHatchTui,
    runForegroundGateway,
    observeHandoff,
    ...servingDeps
  } = fixtures;
  const restore: Array<() => void> = [];
  try {
    if (observeHandoff) {
      const owner = await import("./onboard-interactive-runner.js");
      const runHandoff = owner.runGuidedOnboardingHandoff;
      const spy = vi.spyOn(owner, "runGuidedOnboardingHandoff").mockImplementation((...args) => {
        observeHandoff(args[0]);
        return runHandoff(...args);
      });
      restore.push(() => spy.mockRestore());
    }
    if (createPrompter) {
      const owner = await import("../wizard/clack-prompter.js");
      const spy = vi.spyOn(owner, "createClackPrompter").mockImplementation(createPrompter);
      restore.push(() => spy.mockRestore());
    }
    if (listManualOptions) {
      const owner = await import("../system-agent/setup-inference.js");
      const spy = vi
        .spyOn(owner, "listManualSetupInferenceOptions")
        .mockImplementation(listManualOptions);
      restore.push(() => spy.mockRestore());
    }
    if (applySetup) {
      const owner = await import("../system-agent/setup-apply.js");
      const spy = vi.spyOn(owner, "applySystemAgentSetup").mockImplementation(applySetup);
      restore.push(() => spy.mockRestore());
    }
    if (runMemorySetupFlow) {
      const owner = await import("../flows/memory-setup.js");
      const spy = vi.spyOn(owner, "runMemorySetupFlow").mockImplementation(runMemorySetupFlow);
      restore.push(() => spy.mockRestore());
    }
    if (runAppRecommendations) {
      const owner = await import("../wizard/setup.app-recommendations.js");
      const spy = vi
        .spyOn(owner, "setupAppRecommendations")
        .mockImplementation(runAppRecommendations);
      restore.push(() => spy.mockRestore());
    }
    if (runBrowserHandoff) {
      const owner = await import("./onboard-browser-handoff.js");
      const spy = vi.spyOn(owner, "runBrowserHatchHandoff").mockImplementation(runBrowserHandoff);
      restore.push(() => spy.mockRestore());
    }
    if (launchHatchTui) {
      const owner = await import("../tui/tui-launch.js");
      const spy = vi.spyOn(owner, "launchTuiCli").mockImplementation(launchHatchTui);
      restore.push(() => spy.mockRestore());
    }
    if (runForegroundGateway) {
      const owner = await import("./onboard-quickstart-host.js");
      const spy = vi
        .spyOn(owner, "runQuickstartForegroundGateway")
        .mockImplementation(runForegroundGateway);
      restore.push(() => spy.mockRestore());
    }
    return await runGuidedOnboarding(opts, runtime, servingDeps);
  } finally {
    for (const reset of restore.toReversed()) {
      reset();
    }
  }
}
