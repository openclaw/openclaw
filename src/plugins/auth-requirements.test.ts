import { describe, expect, it } from "vitest";
import { collectPluginAuthRequirements } from "./auth-requirements.js";

describe("collectPluginAuthRequirements", () => {
  it("keeps explicit manifest requirements ahead of derived compatibility hints", () => {
    const requirements = collectPluginAuthRequirements({
      id: "assistant-plugin",
      authRequirements: [
        {
          id: "host-structured-llm",
          kind: "host-capability",
          capability: "runtime.llm.completeStructured",
          mockable: true,
        },
      ],
      setup: {
        providers: [
          {
            id: "demo-provider",
            authMethods: ["api-key"],
            envVars: ["DEMO_API_KEY"],
          },
        ],
      },
      providerAuthChoices: [
        {
          provider: "demo-provider",
          method: "api-key",
          choiceId: "demo-provider-api-key",
        },
      ],
      channelEnvVars: {
        "demo-channel": ["DEMO_CHANNEL_TOKEN"],
      },
    });

    expect(requirements).toEqual([
      {
        pluginId: "assistant-plugin",
        source: "manifest",
        requirement: {
          id: "host-structured-llm",
          kind: "host-capability",
          capability: "runtime.llm.completeStructured",
          mockable: true,
        },
      },
      {
        pluginId: "assistant-plugin",
        source: "setup-provider",
        requirement: {
          id: "provider:demo-provider",
          kind: "provider",
          provider: "demo-provider",
          setupRefs: ["setup.providers:demo-provider"],
          authMethods: ["api-key"],
          envVars: ["DEMO_API_KEY"],
        },
      },
      {
        pluginId: "assistant-plugin",
        source: "provider-auth-choice",
        requirement: {
          id: "provider-auth-choice:demo-provider-api-key",
          kind: "provider",
          provider: "demo-provider",
          authMethods: ["api-key"],
          setupRefs: ["providerAuthChoices:demo-provider-api-key"],
        },
      },
      {
        pluginId: "assistant-plugin",
        source: "channel-env-vars",
        requirement: {
          id: "channel:demo-channel",
          kind: "channel-account",
          channel: "demo-channel",
          envVars: ["DEMO_CHANNEL_TOKEN"],
          setupRefs: ["channelEnvVars:demo-channel"],
        },
      },
    ]);
  });

  it("can return only explicit manifest requirements", () => {
    const requirements = collectPluginAuthRequirements(
      {
        id: "demo",
        authRequirements: [
          {
            id: "host-llm",
            kind: "host-capability",
            capability: "runtime.llm.complete",
          },
        ],
        channelEnvVars: {
          discord: ["DISCORD_BOT_TOKEN"],
        },
      },
      { includeDerived: false },
    );

    expect(requirements).toEqual([
      {
        pluginId: "demo",
        source: "manifest",
        requirement: {
          id: "host-llm",
          kind: "host-capability",
          capability: "runtime.llm.complete",
        },
      },
    ]);
  });

  it("derives provider env vars only when setup providers do not cover the provider", () => {
    const requirements = collectPluginAuthRequirements({
      id: "demo",
      setup: {
        providers: [{ id: "covered", envVars: ["COVERED_API_KEY"] }],
      },
      providerAuthEnvVars: {
        covered: ["LEGACY_COVERED_API_KEY"],
        legacy: ["LEGACY_API_KEY"],
      },
    });

    expect(requirements.map((entry) => entry.requirement.id)).toEqual([
      "provider:covered",
      "provider-env:legacy",
    ]);
  });
});
