/** Doctor advisory for ACP-runtime agents whose configured primary model is harness-owned. */
import { listAgentEntries } from "../agents/agent-roster.js";
import { resolveDefaultModelForAgent } from "../agents/model-selection.js";
import { resolveAgentModelPrimaryValue } from "../config/model-input.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { HealthCheck, HealthFinding } from "./health-checks.js";

const CHECK_ID = "core/doctor/acp-agent-model";

/** Matches a `provider/model` reference, the shape OpenClaw could dispatch on its own. */
const PROVIDER_QUALIFIED_REF = /^[^/\s]+\/\S/;

/**
 * Reports how each ACP-runtime agent's `model.primary` is split between its harness and
 * OpenClaw's own model calls. Operators whose primary was a dispatchable reference get a
 * warning, because that precedence changed; a harness-only id is informational.
 */
function collectAcpAgentModelFindings(cfg: OpenClawConfig): HealthFinding[] {
  const findings: HealthFinding[] = [];
  for (const agent of listAgentEntries(cfg)) {
    if (agent.runtime?.type !== "acp") {
      continue;
    }
    const primary = resolveAgentModelPrimaryValue(agent.model)?.trim();
    // A legacy `agents.list` roster keeps entries verbatim, so an id is not guaranteed
    // until Doctor migrates it; without one there is no config path worth reporting.
    const agentId = agent.id?.trim();
    if (!primary || !agentId) {
      continue;
    }
    const local = resolveDefaultModelForAgent({ cfg, agentId });
    const localRef = `${local.provider}/${local.model}`;
    const path = `agents.entries.${agentId}.model.primary`;
    if (PROVIDER_QUALIFIED_REF.test(primary)) {
      findings.push({
        checkId: CHECK_ID,
        severity: "warning",
        source: "doctor",
        target: agentId,
        path,
        message: `Agent "${agentId}" runs on ACP, so model.primary "${primary}" now selects its ACP harness model only. This agent's OpenClaw-side model calls use agents.defaults.model "${localRef}" instead.`,
        requirement: "an agents.defaults.model that suits this agent's OpenClaw-side model calls",
        fixHint: `Set agents.defaults.model to the model those calls should use, or accept "${localRef}". ACP turns keep using "${primary}".`,
      });
      continue;
    }
    findings.push({
      checkId: CHECK_ID,
      severity: "info",
      source: "doctor",
      target: agentId,
      path,
      message: `Agent "${agentId}" pins the ACP harness model id "${primary}". This agent's OpenClaw-side model calls use agents.defaults.model "${localRef}".`,
    });
  }
  return findings;
}

export function createAcpAgentModelCheck(): HealthCheck {
  return {
    id: CHECK_ID,
    kind: "core",
    description: "ACP-runtime agents' harness model ids stay out of OpenClaw model dispatch.",
    source: "doctor",
    async detect(ctx) {
      return collectAcpAgentModelFindings(ctx.cfg);
    },
  };
}
