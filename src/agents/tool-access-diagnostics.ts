import type { ToolAccessDiagnostics } from "../../packages/gateway-protocol/src/schema/tools-catalog.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveEffectiveToolPolicy } from "./agent-tools.policy.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "./defaults.js";
import { resolveConfiguredModelRef } from "./model-selection-shared.js";
import { listCoreToolSections } from "./tool-catalog.js";
import { createToolPolicyMatcher } from "./tool-policy-match.js";
import {
  applyToolPolicyPipeline,
  buildDefaultToolPolicyPipelineSteps,
  type ToolPolicyFilterEvent,
} from "./tool-policy-pipeline.js";
import {
  mergeAlsoAllowPolicy,
  normalizeToolPolicyName,
  resolveToolProfilePolicy,
} from "./tool-policy.js";

export type { ToolAccessDiagnostics };
type ToolAccess = ToolAccessDiagnostics["tools"][number];
type Reason = ToolAccess["reasons"][number];

/** Observe the same expanded policies that filter tools, including later blockers. */
export function createToolAccessDiagnostics(params: {
  profiles: ToolAccessDiagnostics["profiles"];
  toolNames?: readonly string[];
}) {
  const candidates = new Map<string, { reasons: Reason[]; alsoAllowPath?: string }>();
  const constructed = new Set<string>();
  const include = (name: string) => {
    const id = normalizeToolPolicyName(name);
    if (!candidates.has(id)) {
      candidates.set(id, { reasons: [] });
    }
  };
  for (const name of params.toolNames ??
    listCoreToolSections().flatMap((section) => section.tools.map((tool) => tool.id))) {
    include(name);
  }
  const onFilter = (event: ToolPolicyFilterEvent<{ name: string }>) => {
    for (const tool of event.before) {
      include(tool.name);
      constructed.add(normalizeToolPolicyName(tool.name));
    }
    const permits = createToolPolicyMatcher(event.policy);
    const notDenied = createToolPolicyMatcher({ deny: event.policy.deny });
    const source = event.step.source;
    for (const [id, candidate] of candidates) {
      if (permits(id)) {
        continue;
      }
      const denied = !notDenied(id);
      const kind =
        source?.kind === "profile"
          ? "profile"
          : source?.kind === "session" || source?.kind === "runtime"
            ? source.kind
            : denied
              ? "deny"
              : "allowlist";
      const path = source?.path
        ? `${source.path}${source.kind === "config" ? (denied ? ".deny" : ".allow") : ""}`
        : undefined;
      candidate.reasons.push({
        kind,
        label:
          kind === "profile"
            ? `${source?.profile ?? "Selected"} profile`
            : `${denied ? "Denied by" : "Not included in"} ${path ?? event.step.label}`,
        ...(path ? { source: path } : {}),
        ...(source?.profile ? { profile: source.profile } : {}),
      });
      candidate.alsoAllowPath =
        candidate.reasons.length === 1 && kind === "profile" ? source?.alsoAllowPath : undefined;
    }
  };
  return {
    onFilter,
    finish(availableToolNames?: readonly string[]): ToolAccessDiagnostics {
      const available =
        availableToolNames && new Set(availableToolNames.map(normalizeToolPolicyName));
      available?.forEach(include);
      return {
        checked: available ? "live-session" : "local-config",
        profiles: params.profiles,
        tools: [...candidates].map(([id, candidate]): ToolAccess => {
          // Final presence wins: host-owned tools can intentionally survive policy filtering.
          if (available?.has(id)) {
            return { id, status: "available", reasons: [] };
          }
          if (candidate.reasons.length > 0) {
            const tool: ToolAccess = {
              id,
              status: "excluded",
              reasons: candidate.reasons,
            };
            if (candidate.alsoAllowPath && (!available || constructed.has(id))) {
              tool.alsoAllowPath = candidate.alsoAllowPath;
            }
            return tool;
          }
          return {
            id,
            status: available ? "unavailable" : "allowed",
            reasons: available
              ? [{ kind: "runtime", label: "Not included in the session preview" }]
              : [],
          };
        }),
      };
    },
  };
}

/** Local policy can prove exclusion; it cannot prove a live tool was constructed. */
export function resolveConfiguredToolAccess(params: {
  config: OpenClawConfig;
  agentId: string;
  toolNames?: readonly string[];
  modelProvider?: string;
  modelId?: string;
}): ToolAccessDiagnostics {
  const model =
    params.modelProvider && params.modelId
      ? undefined
      : resolveConfiguredModelRef({
          cfg: params.config,
          agentId: params.agentId,
          defaultProvider: DEFAULT_PROVIDER,
          defaultModel: DEFAULT_MODEL,
        });
  const policy = resolveEffectiveToolPolicy({
    config: params.config,
    agentId: params.agentId,
    modelProvider: params.modelProvider ?? model?.provider,
    modelId: params.modelId ?? model?.model,
  });
  const toolNames = params.toolNames ?? ["exec", "process"];
  const diagnostics = createToolAccessDiagnostics({ profiles: policy.profiles, toolNames });
  applyToolPolicyPipeline({
    tools: toolNames.map((name) => ({ name })),
    toolMeta: () => undefined,
    warn: () => undefined,
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
    onFilter: diagnostics.onFilter,
  });
  return diagnostics.finish();
}
