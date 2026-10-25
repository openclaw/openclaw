// Configure credential-scope tests persist provider auth through the real auth store.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ensureAuthProfileStore } from "../agents/auth-profiles.js";
import { testing as cliBackendsTesting } from "../agents/cli-backends.test-support.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ProviderAuthMethod, ProviderPlugin } from "../plugins/types.js";
import type { RuntimeEnv } from "../runtime.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { createTestWizardPrompter } from "../test-utils/plugin-setup-wizard.js";
import { resolveOnboardingAgentTarget } from "./onboard-agent-target.js";

const mocks = vi.hoisted(() => ({
  authChoice: vi.fn(),
  providerChoice: vi.fn<() => unknown>(() => null),
}));

// mock-isolation: Supply the operator's auth choice without an interactive terminal.
vi.mock("./auth-choice-prompt.js", () => ({ promptAuthChoiceGrouped: mocks.authChoice }));

// mock-isolation: Resolve the fixture provider instead of discovering installed plugins.
vi.mock("../plugins/provider-wizard.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/provider-wizard.js")>()),
  resolveProviderPluginChoiceCore: mocks.providerChoice,
}));

// mock-isolation: Use the fixture provider without loading installed provider runtimes.
vi.mock("../plugins/providers.runtime.js", () => ({ resolvePluginProvidersCore: () => [] }));

// mock-isolation: Provider preference is a fixture input, independent of installed plugins.
vi.mock("../plugins/provider-auth-choice-preference.js", () => ({
  resolvePreferredProviderForAuthChoice: async () => undefined,
}));

// mock-isolation: The operator keeps the current models; pickers are not under test here.
vi.mock("../flows/model-picker.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../flows/model-picker.js")>()),
  promptDefaultModel: async () => ({}),
  promptModelAllowlist: async () => ({}),
}));

// mock-isolation: Keep model catalogs deterministic and independent of the local installation.
vi.mock("./models/list.manifest-catalog.js", () => ({
  loadStaticManifestCatalogRowsForList: () => [],
}));

import { promptAuthConfig } from "./configure.gateway-auth.js";

const profileId = "configure-provider:default";
const method: ProviderAuthMethod = {
  id: "api-key",
  label: "Configure provider",
  kind: "api_key",
  run: async () => ({
    profiles: [
      {
        profileId,
        credential: { type: "api_key", provider: "configure-provider", key: "sk-configure-test" },
      },
    ],
  }),
};
const provider: ProviderPlugin = {
  id: "configure-provider",
  label: "Configure provider",
  auth: [method],
};
const runtime: RuntimeEnv = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
const fleet: OpenClawConfig = {
  agents: {
    ownership: "explicit",
    defaults: { systemAgent: { agentId: "ops" } },
    entries: { main: {}, ops: {}, beta: {} },
  },
};

beforeEach(() => {
  mocks.authChoice.mockResolvedValue("provider-plugin:configure-provider:api-key");
  mocks.providerChoice.mockReturnValue({ provider, method });
  // The fixture provider exposes no CLI backends; policy checks need no plugin discovery.
  cliBackendsTesting.setDepsForTest({
    resolveRuntimeCliBackends: () => [],
    resolvePluginSetupRegistry: () => ({
      providers: [],
      cliBackends: [],
      configMigrations: [],
      autoEnableProbes: [],
      diagnostics: [],
    }),
  });
});

afterEach(() => cliBackendsTesting.resetDepsForTest());

describe("promptAuthConfig credential scope", () => {
  it("shares shared-default credentials with every agent and keeps agent credentials private", async () => {
    // Each scope runs in a fresh state root and reports which agents can use the stored key.
    const agentsSeeingKey = (modelWriteTarget: "agent" | "defaults") =>
      withStateDirEnv("openclaw-configure-credential-scope-", async () => {
        const target = resolveOnboardingAgentTarget(fleet, "ops");
        await promptAuthConfig(fleet, runtime, createTestWizardPrompter(), target, {
          modelWriteTarget,
        });
        return ["ops", "beta"].filter((agentId) =>
          Object.keys(
            ensureAuthProfileStore(resolveOnboardingAgentTarget(fleet, agentId).agentDir).profiles,
          ).includes(profileId),
        );
      });

    expect(await agentsSeeingKey("defaults")).toEqual(["ops", "beta"]);
    expect(await agentsSeeingKey("agent")).toEqual(["ops"]);
  });
});
