import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import type { ModelCatalogEntry } from "../agents/model-catalog.types.js";
import { createThinkingCatalogResolver } from "../auto-reply/thinking.js";
import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveProviderPolicySurface } from "../plugins/provider-public-artifacts.js";
import {
  PREPARED_THINKING_POLICY,
  type PreparedThinkingPolicy,
  type ThinkingCatalogPolicyCarrier,
} from "../plugins/provider-thinking-catalog.js";
import type { ProviderThinkingRegistry } from "../plugins/provider-thinking.types.js";
import { resolveGatewayModelThinkingProfile } from "./session-utils-model.js";
import { buildSessionListRowMetadataContext } from "./session-utils-projection.js";
import { buildGatewaySessionRow } from "./session-utils-row.js";

describe("Gateway stored thinking levels", () => {
  it("keeps stored Ultra for supported harnesses and clamps unavailable native profiles", () => {
    // A synthetic model lets observed native efforts define the capability set.
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: { primary: "openai/native-effort-fixture" },
          models: {
            "openai/native-effort-fixture": { agentRuntime: { id: "codex" } },
          },
        },
      },
    };
    const openaiPolicy = expectDefined(
      resolveProviderPolicySurface("openai")?.resolveThinkingProfile,
      "OpenAI public thinking policy",
    );
    const row = (
      entry: SessionEntry,
      catalog?: { reasoning?: boolean; compat?: { supportedReasoningEfforts: string[] } },
    ) => {
      const modelCatalog: (ModelCatalogEntry & ThinkingCatalogPolicyCarrier)[] | undefined = catalog
        ? [
            {
              provider: "openai",
              id: "native-effort-fixture",
              name: "Native effort fixture",
              [PREPARED_THINKING_POLICY]: openaiPolicy,
              ...catalog,
            },
          ]
        : undefined;
      return buildGatewaySessionRow({
        cfg,
        agentId: "main",
        lightweightListRow: true,
        rowContext: buildSessionListRowMetadataContext({ now: 1 }),
        storePath: "",
        store: {},
        key: "agent:main:main",
        entry,
        modelCatalog,
      });
    };

    const stored: SessionEntry = { sessionId: "stored", updatedAt: 1, thinkingLevel: "ultra" };

    expect(row(stored).thinkingLevel).toBe("ultra");
    expect(row(stored, {}).thinkingLevel).toBe("ultra");
    expect(row(stored, { reasoning: true }).thinkingLevel).toBe("ultra");
    expect(row(stored, { reasoning: false }).thinkingLevel).toBe("off");
    expect(
      row(stored, { reasoning: true, compat: { supportedReasoningEfforts: ["off"] } })
        .thinkingLevel,
    ).toBe("off");
    expect(
      row(stored, { reasoning: true, compat: { supportedReasoningEfforts: ["max"] } })
        .thinkingLevel,
    ).toBe("ultra");
    const nativeUltra = row(stored, {
      reasoning: true,
      compat: { supportedReasoningEfforts: ["max", "ultra"] },
    });
    expect(nativeUltra.thinkingLevel).toBe("ultra");
    expect(nativeUltra.thinkingLevels).toContainEqual({ id: "ultra", label: "ultra" });
  });
});

describe("Gateway all-null thinking map", () => {
  it.each([undefined, "ultra"] as const)(
    "preserves the explicit default %s without native levels",
    (thinkingDefault) => {
      const profile = resolveGatewayModelThinkingProfile({
        cfg: { agents: { defaults: { thinkingDefault } } },
        agentId: "main",
        provider: "metadata-fixture",
        model: "no-effort",
        agentRuntime: "openclaw",
        modelCatalog: [
          {
            provider: "metadata-fixture",
            id: "no-effort",
            name: "No selectable effort",
            api: "openai-completions",
            reasoning: true,
            thinkingLevelMap: {
              off: null,
              minimal: null,
              low: null,
              medium: null,
              high: null,
              xhigh: null,
              max: null,
            },
          },
        ],
      });

      expect(profile.thinkingLevels).toEqual([{ id: "ultra", label: "ultra" }]);
      expect(profile.thinkingDefault).toBe(thinkingDefault);
    },
  );
});

describe("Gateway captured thinking defaults", () => {
  const provider = "captured-thinking-default-fixture";
  const captured: ProviderThinkingRegistry = {
    providers: [
      {
        provider: {
          id: provider,
          resolveThinkingProfile: () => ({
            // Medium stays supported so clamping cannot hide a lost policy source.
            levels: [{ id: "off" }, { id: "low" }, { id: "medium" }],
            defaultLevel: "low",
          }),
        },
      },
    ],
  };

  it("projects the agent-specific model default above shared model and global defaults", () => {
    const ref = `${provider}/reasoner`;
    const profile = resolveGatewayModelThinkingProfile({
      cfg: {
        agents: {
          defaults: {
            thinkingDefault: "medium",
            models: { [ref]: { params: { thinking: "low" } } },
          },
          entries: { main: { models: { [ref]: { params: { thinking: "off" } } } } },
        },
      },
      agentId: "main",
      provider,
      model: "reasoner",
      agentRuntime: "openclaw",
      providerPolicySource: captured,
      modelCatalog: [{ provider, id: "reasoner", name: "Reasoner", reasoning: true }],
    });

    expect(profile.thinkingDefault).toBe("off");
  });

  it.each([
    { name: "captured", source: captured, expected: "low" },
    { name: "active", source: "active" as const, expected: "medium" },
    { name: "ordinary", source: undefined, expected: "medium" },
    { name: "active or bundled", source: "active-or-bundled" as const, expected: "medium" },
  ])("uses the $name source for its default", ({ source, expected }) => {
    const profile = resolveGatewayModelThinkingProfile({
      cfg: {},
      agentId: "main",
      provider,
      model: "reasoner",
      agentRuntime: "openclaw",
      providerPolicySource: source,
      modelCatalog: [
        { provider, id: "reasoner", name: "Reasoner", api: "openai-completions", reasoning: true },
      ],
    });

    expect(profile.thinkingDefault).toBe(expected);
    expect(profile.thinkingLevels.map(({ id }) => id)).toContain(expected);
  });
});

describe.each([
  { agentRuntime: "openclaw", api: "openai-responses" as const },
  { agentRuntime: "codex", api: "openai-chatgpt-responses" as const },
])("Gateway model thinking defaults on $agentRuntime", ({ agentRuntime, api }) => {
  it.each<{ name: string; cfg: OpenClawConfig; expected: string }>([
    { name: "provider default", cfg: {}, expected: "medium" },
    {
      name: "global override",
      cfg: { agents: { defaults: { thinkingDefault: "high" } } },
      expected: "high",
    },
    {
      name: "model override",
      cfg: {
        agents: {
          defaults: {
            thinkingDefault: "high",
            models: { "openai/gpt-6-astra": { params: { thinking: "medium" } } },
          },
        },
      },
      expected: "medium",
    },
    {
      name: "agent override",
      cfg: { agents: { entries: { main: { thinkingDefault: "xhigh" } } } },
      expected: "xhigh",
    },
  ])("projects $name for Control UI", ({ cfg, expected }) => {
    const profile = resolveGatewayModelThinkingProfile({
      cfg,
      agentId: "main",
      provider: "openai",
      model: "gpt-6-astra",
      agentRuntime,
      modelCatalog: [
        { provider: "openai", id: "gpt-6-astra", name: "Astra", reasoning: true, api },
      ],
    });
    expect(profile.thinkingDefault).toBe(expected);
    expect(profile.thinkingLevels.map(({ id }) => id)).toContain(expected);
  });
});

describe.each([false, true])("Gateway thinking catalog indexed=%s", (indexed) => {
  it.each([
    { configured: false, configuredReasoning: undefined, expected: "low" },
    { configured: true, configuredReasoning: undefined, expected: "high" },
    { configured: false, configuredReasoning: false, expected: "off" },
  ])("keeps logical defaults separate from donor levels: %j", (scenario) => {
    const logicalPolicy = vi.fn<PreparedThinkingPolicy>(() => ({
      levels: [{ id: "off" }, { id: "medium" }, { id: "high" }],
      defaultLevel: "medium",
    }));
    const donorPolicy = vi.fn<PreparedThinkingPolicy>(() => ({
      levels: [{ id: "off" }, { id: "low", label: "On" }, { id: "high" }],
      defaultLevel: "high",
    }));
    const catalog: (ModelCatalogEntry & ThinkingCatalogPolicyCarrier)[] = [
      {
        provider: "logical",
        id: "Reasoner",
        name: "Logical",
        reasoning: true,
        [PREPARED_THINKING_POLICY]: logicalPolicy,
      },
      {
        provider: "donor",
        id: "Reasoner",
        name: "Donor",
        reasoning: true,
        [PREPARED_THINKING_POLICY]: donorPolicy,
      },
    ];
    const cfg: OpenClawConfig = scenario.configured
      ? {
          agents: {
            defaults: {
              models: {
                "logical/Reasoner": { params: { thinking: "high" } },
                "donor/Reasoner": { params: { thinking: "off" } },
              },
            },
          },
        }
      : {};
    const profile = resolveGatewayModelThinkingProfile({
      cfg,
      agentId: "main",
      provider: "logical",
      model: "Reasoner",
      thinkingPolicyProvider: "donor",
      agentRuntime: "openclaw",
      modelCatalog: catalog,
      catalogResolver: indexed ? createThinkingCatalogResolver(catalog) : undefined,
      configuredReasoning: scenario.configuredReasoning,
    });
    expect(profile.thinkingLevels).toEqual(
      scenario.configuredReasoning === false
        ? [
            { id: "off", label: "off" },
            { id: "ultra", label: "ultra" },
          ]
        : [
            { id: "off", label: "off" },
            { id: "low", label: "On" },
            { id: "high", label: "high" },
            { id: "ultra", label: "ultra" },
          ],
    );
    expect(profile.thinkingDefault).toBe(scenario.expected);
    expect(logicalPolicy).toHaveBeenCalledTimes(scenario.configured ? 0 : 1);
    expect(donorPolicy).toHaveBeenCalledTimes(1);
  });

  it("retains an authoritative absent policy across all default and clamp reads", () => {
    const otherPolicy = vi.fn<PreparedThinkingPolicy>(() => ({
      levels: [{ id: "high" }],
      defaultLevel: "high",
    }));
    const catalog: (ModelCatalogEntry & ThinkingCatalogPolicyCarrier)[] = [
      {
        provider: "captured-null",
        id: "Reasoner",
        name: "Reasoner",
        reasoning: true,
        [PREPARED_THINKING_POLICY]: null,
      },
    ];
    const profile = resolveGatewayModelThinkingProfile({
      cfg: {},
      agentId: "main",
      provider: "captured-null",
      model: "Reasoner",
      agentRuntime: "openclaw",
      modelCatalog: catalog,
      catalogResolver: indexed ? createThinkingCatalogResolver(catalog) : undefined,
      providerPolicySource: {
        providers: [{ provider: { id: "captured-null", resolveThinkingProfile: otherPolicy } }],
      },
    });
    expect(profile.thinkingLevels.map(({ id }) => id)).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "ultra",
    ]);
    expect(profile.thinkingDefault).toBe("medium");
    expect(otherPolicy).not.toHaveBeenCalled();
  });
});
