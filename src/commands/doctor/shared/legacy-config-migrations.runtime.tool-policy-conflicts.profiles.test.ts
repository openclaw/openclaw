import { expect, it } from "vitest";
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

type PolicyCase = [string, OpenClawConfig["tools"], AgentToolsConfig, string?, string?];

const tools = [
  ...listCoreToolSections({ swarmEnabled: true }).flatMap((section) =>
    section.tools.map((tool) => ({ name: tool.id })),
  ),
  { name: "custom_probe" },
  { name: "session_custom" },
];

function grants(allow: string[], alsoAllow: string[], profile?: AgentToolsConfig["profile"]) {
  return { allow, alsoAllow, ...(profile ? { profile } : {}) };
}

function effective(config: OpenClawConfig, modelProvider?: string, modelId?: string) {
  const policy = resolveEffectiveToolPolicy({
    config,
    agentId: "restricted",
    modelProvider,
    modelId,
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

const restricted = { allow: ["session_status", "exec"], alsoAllow: ["session_status"] };
const explicitExec = { allow: ["session_status", "exec"], alsoAllow: ["exec"] };
const minimal = { profile: "minimal" as const };
const fullExec = { profile: "full" as const, ...explicitExec };
const minimalExtras = { profile: "minimal" as const, alsoAllow: ["read"] };
const modelProfiles = {
  byProvider: { openai: { profile: "full" as const }, "openai/model": minimal },
};
const byProvider = (policy: AgentToolsConfig, key = "openai") => ({
  byProvider: { [key]: policy },
});
const cases: PolicyCase[] = [
  ["restricted agent", { alsoAllow: ["exec"] }, { ...minimal, ...restricted }],
  ["explicit exec", { alsoAllow: ["read"] }, { ...minimal, ...explicitExec }],
  ["no profile", { alsoAllow: ["read"] }, grants(["exec"], ["message"])],
  ["inherited minimal profile", { profile: "minimal", alsoAllow: ["exec"] }, restricted],
  ["agent full profile", minimalExtras, grants(["exec"], ["message"], "full")],
  ["global extras consumed by an agent profile", fullExec, minimal],
  [
    "gateway config-read authority",
    { alsoAllow: ["exec"] },
    grants(["session_status", "gateway"], ["gateway"], "minimal"),
  ],
  ["wildcard extras", undefined, grants(["session_status"], ["custom_*"], "minimal")],
  ["plugin group extras", undefined, grants(["session_status"], ["group:plugins"], "minimal")],
  ["aliases and core groups", undefined, grants(["bash", "read"], ["group:runtime"], "coding")],
  [
    "provider extras",
    byProvider({ ...minimal, alsoAllow: ["exec"] }),
    byProvider(restricted),
    "openai",
  ],
  [
    "model override extras",
    byProvider(fullExec),
    byProvider(minimal, "openai/model"),
    "openai",
    "model",
  ],
  ["inherited model profile", modelProfiles, byProvider(explicitExec), "openai", "model"],
];

it.each(cases)("preserves profile grants: %s", (name, global, agent, provider, model) => {
  const raw: OpenClawConfig = {
    tools: global,
    agents: { ownership: "explicit", entries: { restricted: { tools: agent } } },
  };
  const before = effective(raw, provider, model);
  const result = repair(raw);
  expect(effective(result.config, provider, model)).toStrictEqual(before);
  if (name === "restricted agent") {
    expect(before.tools).toContain("session_status");
    expect(before.tools).not.toContain("exec");
    expect(
      validateConfigObjectWithPlugins(result.config, { pluginValidation: "core-only" }).ok,
    ).toBe(true);
    expect(result.config.agents?.entries?.restricted?.tools?.alsoAllow).toEqual([]);
    expect(repair(result.config).changes).toEqual([]);
  }
  if (name === "explicit exec") {
    expect(before.tools).toContain("exec");
    expect(before.tools).not.toContain("gateway");
    expect(result.config).toEqual(raw);
    expect(result.changes).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings?.[0]).toMatch(
      /remove agents.entries.restricted.tools.allow.*agents.entries.restricted.tools.alsoAllow=\[\]/,
    );
  }
});
