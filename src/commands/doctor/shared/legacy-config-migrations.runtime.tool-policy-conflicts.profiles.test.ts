import { describe, expect, it } from "vitest";
import { resolveEffectiveToolPolicy } from "../../../agents/agent-tools.policy.js";
import { listCoreToolSections } from "../../../agents/tool-catalog.js";
import {
  applyToolPolicyPipeline,
  buildDefaultToolPolicyPipelineSteps,
} from "../../../agents/tool-policy-pipeline.js";
import { mergeAlsoAllowPolicy, resolveToolProfilePolicy } from "../../../agents/tool-policy.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { AgentToolsConfig } from "../../../config/types.tools.js";
import { validateConfigObjectWithPlugins } from "../../../config/validation.js";
import { applyLegacyDoctorMigrations } from "./legacy-config-compat.js";

type PolicyCase = {
  name: string;
  global?: OpenClawConfig["tools"];
  agent?: AgentToolsConfig;
  modelProvider?: string;
  modelId?: string;
};

const tools = [
  ...listCoreToolSections({ swarmEnabled: true, githubPublicationAvailable: true }).flatMap(
    (section) => section.tools.map((tool) => ({ name: tool.id })),
  ),
  { name: "custom_probe" },
  { name: "session_custom" },
];

function configFor(entry: PolicyCase): OpenClawConfig {
  return {
    tools: entry.global,
    agents: { ownership: "explicit", entries: { restricted: { tools: entry.agent } } },
  };
}

function effective(config: OpenClawConfig, entry: PolicyCase) {
  const policy = resolveEffectiveToolPolicy({
    config,
    agentId: "restricted",
    modelProvider: entry.modelProvider,
    modelId: entry.modelId,
  });
  return {
    tools: applyToolPolicyPipeline({
      tools,
      toolMeta: (tool) => (tool.name.includes("custom") ? { pluginId: "fixture" } : undefined),
      warn: () => {},
      steps: buildDefaultToolPolicyPipelineSteps({
        ...policy,
        profilePolicy: mergeAlsoAllowPolicy(
          resolveToolProfilePolicy(policy.profile),
          policy.profileAlsoAllow,
        ),
        providerProfilePolicy: mergeAlsoAllowPolicy(
          resolveToolProfilePolicy(policy.providerProfile),
          policy.providerProfileAlsoAllow,
        ),
      }),
    }).map((tool) => tool.name),
    gatewayConfigReadAllowed: policy.gatewayConfigReadAllowed,
  };
}

function repair(config: OpenClawConfig) {
  const result = applyLegacyDoctorMigrations(config, {
    sourceConfigBeforeMigrations: config,
    pluginContracts: false,
  });
  return { ...result, config: (result.next ?? config) as OpenClawConfig };
}

describe("Doctor conflict repair preserves effective profile grants", () => {
  it("does not restore inherited global exec after repairing an agent override", () => {
    const entry: PolicyCase = {
      name: "restricted agent",
      global: { alsoAllow: ["exec"] },
      agent: {
        profile: "minimal",
        allow: ["session_status", "exec"],
        alsoAllow: ["session_status"],
      },
    };
    const raw = configFor(entry);
    const before = effective(raw, entry);
    expect(before.tools).toContain("session_status");
    expect(before.tools).not.toContain("exec");

    const result = repair(raw);

    expect(effective(result.config, entry)).toStrictEqual(before);
    expect(
      validateConfigObjectWithPlugins(result.config, { pluginValidation: "core-only" }).ok,
    ).toBe(true);
    expect(result.config.agents?.entries?.restricted?.tools?.alsoAllow).toEqual([]);
    expect(repair(result.config).changes).toEqual([]);
  });

  it("retains intentional profile extras and reports exact manual choices", () => {
    const entry: PolicyCase = {
      name: "explicit exec",
      global: { alsoAllow: ["read"] },
      agent: { profile: "minimal", allow: ["session_status", "exec"], alsoAllow: ["exec"] },
    };
    const raw = configFor(entry);
    const before = effective(raw, entry);
    expect(before.tools).toContain("exec");
    expect(before.tools).not.toContain("gateway");

    const result = repair(raw);

    expect(effective(result.config, entry)).toStrictEqual(before);
    expect(result.config).toEqual(raw);
    expect(result.changes).toEqual([]);
    expect(result.warnings).toEqual([
      expect.stringContaining('agents.entries.restricted.tools.alsoAllow=["exec"]'),
    ]);
    expect(result.warnings?.[0]).toContain(
      'agents.entries.restricted.tools.allow=["session_status","exec"]',
    );
    expect(result.warnings?.[0]).toContain("remove agents.entries.restricted.tools.allow");
    expect(result.warnings?.[0]).toContain("agents.entries.restricted.tools.alsoAllow=[]");
  });

  const cases: PolicyCase[] = [
    {
      name: "no profile",
      global: { alsoAllow: ["read"] },
      agent: { allow: ["exec"], alsoAllow: ["message"] },
    },
    {
      name: "inherited minimal profile",
      global: { profile: "minimal", alsoAllow: ["exec"] },
      agent: { allow: ["session_status", "exec"], alsoAllow: ["session_status"] },
    },
    {
      name: "agent full profile",
      global: { profile: "minimal", alsoAllow: ["read"] },
      agent: { profile: "full", allow: ["exec"], alsoAllow: ["message"] },
    },
    {
      name: "global extras consumed by an agent profile",
      global: { profile: "full", allow: ["session_status", "exec"], alsoAllow: ["exec"] },
      agent: { profile: "minimal" },
    },
    {
      name: "gateway config-read authority",
      global: { alsoAllow: ["exec"] },
      agent: { profile: "minimal", allow: ["session_status", "gateway"], alsoAllow: ["gateway"] },
    },
    {
      name: "wildcard extras",
      agent: { profile: "minimal", allow: ["session_status"], alsoAllow: ["custom_*"] },
    },
    {
      name: "plugin group extras",
      agent: { profile: "minimal", allow: ["session_status"], alsoAllow: ["group:plugins"] },
    },
    {
      name: "aliases and core groups",
      agent: { profile: "coding", allow: ["bash", "read"], alsoAllow: ["group:runtime"] },
    },
    {
      name: "inherited provider extras",
      global: { byProvider: { openai: { profile: "minimal", alsoAllow: ["exec"] } } },
      agent: {
        byProvider: {
          openai: { allow: ["session_status", "exec"], alsoAllow: ["session_status"] },
        },
      },
      modelProvider: "openai",
    },
    {
      name: "global provider extras consumed by a model override",
      global: {
        byProvider: {
          openai: { profile: "full", allow: ["session_status", "exec"], alsoAllow: ["exec"] },
        },
      },
      agent: { byProvider: { "openai/model": { profile: "minimal" } } },
      modelProvider: "openai",
      modelId: "model",
    },
    {
      name: "agent provider inherits model-specific profile",
      global: {
        byProvider: { openai: { profile: "full" }, "openai/model": { profile: "minimal" } },
      },
      agent: { byProvider: { openai: { allow: ["session_status", "exec"], alsoAllow: ["exec"] } } },
      modelProvider: "openai",
      modelId: "model",
    },
  ];

  it.each(cases)("preserves all runtime grants for $name", (entry) => {
    const raw = configFor(entry);
    expect(effective(repair(raw).config, entry)).toStrictEqual(effective(raw, entry));
  });
});
