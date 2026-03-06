import { resolveAgentExplicitModelPrimary } from "../../agents/agent-scope.js";
import { logConfigUpdated } from "../../config/logging.js";
import { resolveAgentModelPrimaryValue } from "../../config/model-input.js";
import type { RuntimeEnv } from "../../runtime.js";
import {
  applyAgentModelPrimaryUpdate,
  applyDefaultModelPrimaryUpdate,
  resolveKnownAgentId,
  updateConfig,
} from "./shared.js";

export async function modelsSetCommand(
  modelRaw: string,
  runtime: RuntimeEnv,
  opts?: { agent?: string },
) {
  const updated = await updateConfig((cfg) => {
    if (opts?.agent) {
      const agentId = resolveKnownAgentId({ cfg, rawAgentId: opts.agent });
      if (!agentId) {
        throw new Error(`Unknown agent id "${opts.agent}".`);
      }
      return applyAgentModelPrimaryUpdate({ cfg, modelRaw, agentId });
    }
    return applyDefaultModelPrimaryUpdate({ cfg, modelRaw, field: "model" });
  });

  logConfigUpdated(runtime);

  if (opts?.agent) {
    const agentId = resolveKnownAgentId({ cfg: updated, rawAgentId: opts.agent });
    const agentModel = agentId ? resolveAgentExplicitModelPrimary(updated, agentId) : undefined;
    runtime.log(`Agent "${opts.agent}" model: ${agentModel ?? modelRaw}`);
  } else {
    runtime.log(
      `Default model: ${resolveAgentModelPrimaryValue(updated.agents?.defaults?.model) ?? modelRaw}`,
    );
  }
}
