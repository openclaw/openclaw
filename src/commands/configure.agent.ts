// Owner validation and lazy target selection shared by configure wizard sections.
import {
  listAgentIds,
  tryResolveAmbientOwnerAgentId,
  tryResolveLegacyCompatibilityAgentId,
} from "../agents/agent-scope-config.js";
import { inheritLegacyDefaultAgentId } from "../config/legacy.default-agent-owner.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isValidAgentId, normalizeAgentId } from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";
import { select } from "./configure.shared.js";
import { resolveOnboardingAgentTarget } from "./onboard-agent-target.js";
import { guardCancel } from "./onboard-helpers.js";

export function validateConfigureAgentId(config: OpenClawConfig, agentId: string | undefined) {
  if (agentId === undefined) {
    return undefined;
  }
  // Validate before remote setup or agent-scoped effects. Normalization alone
  // sanitizes malformed ids and could select another owner.
  if (!isValidAgentId(agentId)) {
    throw new Error(
      "Invalid --agent. Use 1–64 letters, digits, underscores or dashes, starting with a letter or digit.",
    );
  }
  const requestedAgentId = normalizeAgentId(agentId);
  const configured = listAgentIds(config);
  if (!configured.includes(requestedAgentId)) {
    throw new Error(
      `Unknown agent "${requestedAgentId}". Configured agents: ${configured.join(", ") || "(none)"}.`,
    );
  }
  return requestedAgentId;
}

export function createConfigureAgentTargetResolver(params: {
  baseConfig: OpenClawConfig;
  requestedAgentId?: string;
  runtime: RuntimeEnv;
}) {
  let setupAgentId = params.requestedAgentId;
  return async (config: OpenClawConfig) => {
    // Only agent-scoped steps choose an owner; keep that choice across sections.
    if (config.agents?.ownership !== "explicit") {
      inheritLegacyDefaultAgentId(params.baseConfig, config);
    }
    setupAgentId ??=
      config.agents?.ownership === "explicit"
        ? tryResolveAmbientOwnerAgentId(config)
        : tryResolveLegacyCompatibilityAgentId(config);
    const agentIds = listAgentIds(config);
    if (!setupAgentId && agentIds.length > 1) {
      setupAgentId = guardCancel(
        await select({
          message: "Which agent do you want to configure?",
          options: agentIds.map((id) => ({ value: id, label: id })),
        }),
        params.runtime,
        1,
      );
    }
    const target = resolveOnboardingAgentTarget(config, setupAgentId);
    return params.requestedAgentId === undefined
      ? target
      : { ...target, defaultsScope: "agent" as const };
  };
}
