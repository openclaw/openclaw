/** Doctor advisory for ACP-runtime agents whose configured primary model is harness-owned. */
import { sanitizeTerminalText } from "../../packages/terminal-core/src/safe-text.js";
import { listAgentEntriesWithSource } from "../agents/agent-roster.js";
import { resolveDefaultModelForAgent } from "../agents/model-selection.js";
import { resolveAgentModelPrimaryValue } from "../config/model-input.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { appendConfigPathSegment } from "../shared/dot-path.js";
import type { HealthCheck, HealthFinding } from "./health-checks.js";

const CHECK_ID = "core/doctor/acp-agent-model";

/** Explains the separate harness selection and native default without proposing a repair. */
function collectAcpAgentModelFindings(cfg: OpenClawConfig): HealthFinding[] {
  const findings: HealthFinding[] = [];
  for (const { entry: agent, source } of listAgentEntriesWithSource(cfg)) {
    if (agent.runtime?.type !== "acp") {
      continue;
    }
    const primary = resolveAgentModelPrimaryValue(agent.model)?.trim();
    // Legacy roster entries can lack an id before migration; native selection needs an owner.
    const agentId = agent.id?.trim();
    if (!primary || !agentId) {
      continue;
    }
    const nativeDefault = resolveDefaultModelForAgent({ cfg, agentId });
    const nativeRef = sanitizeTerminalText(`${nativeDefault.provider}/${nativeDefault.model}`);
    const agentPath =
      source.kind === "entries"
        ? appendConfigPathSegment("agents.entries", source.key)
        : appendConfigPathSegment("agents.list", source.index);
    const modelPath = appendConfigPathSegment(agentPath, "model");
    const path = sanitizeTerminalText(
      typeof agent.model === "string" ? modelPath : appendConfigPathSegment(modelPath, "primary"),
    );
    const displayAgentId = sanitizeTerminalText(agentId);
    const harnessModel = sanitizeTerminalText(primary);
    findings.push({
      checkId: CHECK_ID,
      severity: "info",
      source: "doctor",
      target: displayAgentId,
      path,
      message: `Agent "${displayAgentId}" uses ACP harness model "${harnessModel}" from ${path}. Its OpenClaw native default is "${nativeRef}". Explicit native session, utility, and subagent model selections still apply.`,
    });
  }
  return findings;
}

export function createAcpAgentModelCheck(): HealthCheck {
  return {
    id: CHECK_ID,
    kind: "core",
    description: "ACP harness models and OpenClaw native defaults are shown separately.",
    source: "doctor",
    async detect(ctx) {
      return collectAcpAgentModelFindings(ctx.cfg);
    },
  };
}
