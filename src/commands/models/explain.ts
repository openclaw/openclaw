import { resolveDefaultModelForAgent } from "../../agents/model-selection.js";
import { type OutputRuntimeEnv, writeRuntimeJson } from "../../runtime.js";
import { resolveSessionModelRef } from "../../gateway/session-utils.js";
import { loadModelsConfigWithSource } from "./load-config.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER, resolveKnownAgentId } from "./shared.js";

export async function modelsExplainCommand(
  opts: {
    model?: string;
    provider?: string;
    json?: boolean;
    agent?: string;
  },
  runtime: OutputRuntimeEnv,
) {
  const { resolvedConfig } = await loadModelsConfigWithSource({
    commandName: "models explain",
    runtime,
  });
  const cfg = resolvedConfig;
  const agentId = resolveKnownAgentId({ cfg, rawAgentId: opts.agent });
  const defaults = agentId
    ? resolveDefaultModelForAgent({ cfg, agentId })
    : { provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL };

  const entry = {
    ...(opts.provider ? { providerOverride: opts.provider } : {}),
    ...(opts.model ? { modelOverride: opts.model } : {}),
  };

  const resolved = resolveSessionModelRef(cfg, entry, agentId);
  const payload = {
    agentId: agentId ?? "main",
    input: {
      providerOverride: opts.provider ?? null,
      modelOverride: opts.model ?? null,
    },
    defaults,
    resolved,
    inferredFamilyRoutingApplied:
      Boolean(opts.model) &&
      resolved.model === opts.model &&
      resolved.provider !== (opts.provider ?? defaults.provider),
  };

  if (opts.json) {
    writeRuntimeJson(runtime, payload);
    return;
  }

  runtime.log(`Agent: ${payload.agentId}`);
  runtime.log(`Input provider override: ${payload.input.providerOverride ?? "-"}`);
  runtime.log(`Input model override: ${payload.input.modelOverride ?? "-"}`);
  runtime.log(`Default resolved: ${payload.defaults.provider}/${payload.defaults.model}`);
  runtime.log(`Final resolved: ${payload.resolved.provider}/${payload.resolved.model}`);
  runtime.log(
    `Family inference applied: ${payload.inferredFamilyRoutingApplied ? "yes" : "no"}`,
  );
}
