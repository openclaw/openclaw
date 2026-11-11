import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";

// Unit workers do not load the plugin metadata that registers CLI backends, so the credential
// evaluator is replaced with the shapes the real one returns for a CLI runtime (native runtime
// credentials) and for the embedded runtime (an API-key profile).
vi.mock("../../../agents/model-auth-availability.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../agents/model-auth-availability.js")>()),
  createModelAuthAvailabilityResolver: (params: { cfg: OpenClawConfig }) => ({
    evaluateRuntimeModelAuth: (
      provider: string,
      ref: { modelId?: string; pinnedProfileId?: string },
    ) => {
      if (ref.pinnedProfileId) {
        const mode = ref.pinnedProfileId === "bedrock:sdk" ? "aws-sdk" : "token";
        return {
          availability: true,
          routeResolution: null,
          selectedAuthMode: mode,
          selectedProfileId: ref.pinnedProfileId,
        };
      }
      const runtime =
        params.cfg.agents?.defaults?.models?.[`${provider}/${ref.modelId}`]?.agentRuntime?.id;
      return runtime === "claude-cli"
        ? {
            availability: false,
            routeResolution: null,
            runtimeAuth: { id: "claude-cli", source: "native" },
          }
        : {
            availability: true,
            routeResolution: null,
            selectedAuthMode: "api_key",
            selectedProfileId: "anthropic:default",
          };
    },
  }),
}));
vi.mock("../../../agents/auth-profiles/store-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../agents/auth-profiles/store-runtime.js")>()),
  loadAuthProfileStoreForSecretsRuntime: () => ({ version: 1, profiles: {} }),
}));

const { collectModelBillingRouteMigrationWarnings } =
  await import("./model-billing-route-migration.js");

const withRuntime = (runtime: string): OpenClawConfig => ({
  agents: {
    defaults: {
      model: "anthropic/claude-opus-4-6",
      models: { "anthropic/claude-opus-4-6": { agentRuntime: { id: runtime } } },
    },
    entries: { main: {} },
  },
});

describe("collectModelBillingRouteMigrationWarnings with CLI runtimes", () => {
  it("names a move from a CLI runtime's own credentials to a metered API key", () => {
    expect(
      collectModelBillingRouteMigrationWarnings({
        before: withRuntime("claude-cli"),
        after: withRuntime("openclaw"),
      }),
    ).toContain(
      "Billing route changed for agents.entries.main.model.primary (agent main): anthropic/claude-opus-4-6 via claude-cli own credentials -> anthropic/claude-opus-4-6 via metered API-key profile anthropic:default. Review its model and authentication settings.",
    );
  });

  it("names the reverse move and stays quiet when the runtime is unchanged", () => {
    expect(
      collectModelBillingRouteMigrationWarnings({
        before: withRuntime("openclaw"),
        after: withRuntime("claude-cli"),
      }),
    ).toContain(
      "Billing route changed for agents.entries.main.model.primary (agent main): anthropic/claude-opus-4-6 via metered API-key profile anthropic:default -> anthropic/claude-opus-4-6 via claude-cli own credentials. Review its model and authentication settings.",
    );
    expect(
      collectModelBillingRouteMigrationWarnings({
        before: withRuntime("claude-cli"),
        after: withRuntime("claude-cli"),
      }),
    ).toEqual([]);
  });
});

it("classifies AWS SDK credentials as metered", () => {
  const withProfile = (profile: string): OpenClawConfig => ({
    agents: { defaults: { model: `anthropic/claude-opus-4-6@${profile}` }, entries: { main: {} } },
  });
  expect(
    collectModelBillingRouteMigrationWarnings({
      before: withProfile("anthropic:sub"),
      after: withProfile("bedrock:sdk"),
    }),
  ).toContain(
    "Billing route changed for agents.entries.main.model.primary (agent main): anthropic/claude-opus-4-6 via subscription/OAuth profile anthropic:sub -> anthropic/claude-opus-4-6 via metered API-key profile bedrock:sdk. Review its model and authentication settings.",
  );
});
