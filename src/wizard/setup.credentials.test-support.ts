import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi, type Mock } from "vitest";
import { createWizardPrompter } from "../../test/helpers/wizard-prompter.js";
import { readAuthProfileStoreForTest } from "../agents/auth-profiles/oauth-test-utils.js";
import { splitTrailingAuthProfile } from "../agents/model-ref-profile.js";
import { resolveAgentModelPrimaryValue } from "../config/model-input.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeEnv } from "../runtime.js";
import type { SetupModelAuthCandidate } from "./setup.model-auth.js";

export function agentConfig(agents: NonNullable<OpenClawConfig["agents"]> = {}): OpenClawConfig {
  return {
    agents: {
      defaults: { workspace: "/tmp/global-workspace" },
      entries: { ops: { agentDir: "/tmp/ops-agent", workspace: "/tmp/ops-workspace" } },
      ...agents,
    },
  };
}

export function authCandidate(
  config: OpenClawConfig,
  authProfiles: SetupModelAuthCandidate["authProfiles"] = [],
) {
  return { config, authProfiles, persistAuthProfiles: vi.fn(async () => {}) };
}

export function createEmptyWizardPrompter() {
  return createWizardPrompter({
    intro: vi.fn(),
    outro: vi.fn(),
    note: vi.fn(),
    select: vi.fn(),
    multiselect: vi.fn(),
    text: vi.fn(),
    confirm: vi.fn(),
  });
}

export function modelConfigWithApiKey(apiKey: string, agentDir: string): OpenClawConfig {
  return {
    agents: {
      defaults: { model: { primary: "openai/gpt-5.5" } },
      entries: { main: { agentDir } },
    },
    auth: {
      profiles: { "openai:default": { provider: "openai", mode: "api_key" } },
      order: { openai: ["openai:default"] },
    },
    models: {
      providers: {
        openai: {
          apiKey,
          baseUrl: "https://api.openai.com/v1",
          models: [],
        },
      },
    },
  };
}

export function openAiAuthProfile(apiKey: string) {
  return {
    profileId: "openai:default",
    credential: { type: "api_key" as const, provider: "openai", key: apiKey },
  };
}

export function expectSavedSetupCredential(
  config: OpenClawConfig,
  agentDir: string,
  key: string,
): string {
  const primary = expectDefined(
    resolveAgentModelPrimaryValue(config.agents?.defaults?.model),
    "selected model",
  );
  const profileId = expectDefined(
    splitTrailingAuthProfile(primary).profile,
    "selected credential profile",
  );
  expect(profileId).toMatch(/^openai:setup-/);
  const { setup, ...credential } = expectDefined(
    readAuthProfileStoreForTest(agentDir).profiles[profileId],
    "saved credential profile",
  );
  expect(credential).toEqual(openAiAuthProfile(key).credential);
  if (setup) {
    expect(setup).toMatchObject({
      modelRef: "openai/gpt-5.5",
      replacement: expect.any(Boolean),
      configJson: expect.any(String),
    });
  }
  return profileId;
}

export function registerSetupCompletionTests({
  finalizeSetupWizard,
  runSearchSetupFlow,
  runWizard,
  createRuntime,
  readInitialConfig,
}: {
  finalizeSetupWizard: Mock<typeof import("./setup.finalize.js").finalizeSetupWizard>;
  runSearchSetupFlow: Mock<typeof import("../flows/search-setup.js").runSearchSetupFlow>;
  runWizard: (
    options?: Parameters<typeof import("./setup.js").runSetupWizard>[0],
    runtime?: RuntimeEnv,
  ) => Promise<void>;
  createRuntime: (options?: { throwsOnExit?: boolean }) => RuntimeEnv;
  readInitialConfig: (config: OpenClawConfig) => void;
}): void {
  it("exits successfully after the auto-launched TUI returns", async () => {
    finalizeSetupWizard.mockResolvedValueOnce({ launchedTui: true });
    await expect(runWizard({}, createRuntime({ throwsOnExit: true }))).rejects.toThrow("exit:0");
  });

  it("continues onboarding when search-provider installation fails", async () => {
    const config: OpenClawConfig = { agents: { defaults: { workspace: "/tmp/workspace" } } };
    runSearchSetupFlow.mockResolvedValueOnce({
      outcome: "install-failed",
      config,
      providerId: "brave",
      reason: "failed",
    });
    readInitialConfig(config);

    await expect(runWizard({ skipSearch: undefined })).resolves.toBeUndefined();

    expect(runSearchSetupFlow).toHaveBeenCalledOnce();
    expect(finalizeSetupWizard).toHaveBeenCalledOnce();
  });
}
