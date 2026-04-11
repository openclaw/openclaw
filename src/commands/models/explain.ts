import { loadSessionStore } from "../../config/sessions.js";
import { type OutputRuntimeEnv, writeRuntimeJson } from "../../runtime.js";
import {
  resolveGatewaySessionStoreTarget,
  resolveSessionModelRef,
} from "../../gateway/session-utils.js";
import { loadModelsConfigWithSource } from "./load-config.js";
import { resolveKnownAgentId } from "./shared.js";

export async function modelsExplainCommand(
  opts: {
    model?: string;
    provider?: string;
    session?: string;
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
  let agentId = resolveKnownAgentId({ cfg, rawAgentId: opts.agent });
  let sessionKey: string | null = null;
  let sessionStorePath: string | null = null;
  let entry:
    | {
        providerOverride?: string;
        modelOverride?: string;
        modelProvider?: string;
        model?: string;
      }
    | undefined;

  if (opts.session) {
    const target = resolveGatewaySessionStoreTarget({ cfg, key: opts.session });
    const store = loadSessionStore(target.storePath);
    const matchedKey = target.storeKeys.find((key) => store[key]);
    const sessionEntry = matchedKey ? store[matchedKey] : undefined;
    if (!sessionEntry) {
      throw new Error(`Session not found: ${opts.session}`);
    }
    agentId = target.agentId;
    sessionKey = target.canonicalKey;
    sessionStorePath = target.storePath;
    entry = {
      ...(sessionEntry.providerOverride ? { providerOverride: sessionEntry.providerOverride } : {}),
      ...(sessionEntry.modelOverride ? { modelOverride: sessionEntry.modelOverride } : {}),
      ...(sessionEntry.modelProvider ? { modelProvider: sessionEntry.modelProvider } : {}),
      ...(sessionEntry.model ? { model: sessionEntry.model } : {}),
    };
  } else {
    entry = {
      ...(opts.provider ? { providerOverride: opts.provider } : {}),
      ...(opts.model ? { modelOverride: opts.model } : {}),
    };
  }

  const defaults = resolveSessionModelRef(cfg, undefined, agentId);
  const resolved = resolveSessionModelRef(cfg, entry, agentId);
  const inferredFamilyRoutingApplied =
    Boolean(opts.model) &&
    resolved.model === opts.model &&
    resolved.provider !== (opts.provider ?? defaults.provider);
  const payload = {
    agentId: agentId ?? "main",
    session: sessionKey
      ? {
          key: sessionKey,
          storePath: sessionStorePath,
        }
      : null,
    input: {
      providerOverride: opts.provider ?? entry?.providerOverride ?? null,
      modelOverride: opts.model ?? entry?.modelOverride ?? null,
      runtimeProvider: entry?.modelProvider ?? null,
      runtimeModel: entry?.model ?? null,
    },
    defaults,
    resolution: {
      startedFromDefault: `${defaults.provider}/${defaults.model}`,
      explicitProviderOverrideApplied: opts.provider ?? entry?.providerOverride ?? null,
      explicitModelOverrideApplied: opts.model ?? entry?.modelOverride ?? null,
      familyInferenceApplied: inferredFamilyRoutingApplied,
    },
    resolved,
    inferredFamilyRoutingApplied,
  };

  if (opts.json) {
    writeRuntimeJson(runtime, payload);
    return;
  }

  runtime.log(`Agent: ${payload.agentId}`);
  runtime.log(`Input provider override: ${payload.input.providerOverride ?? "-"}`);
  runtime.log(`Input model override: ${payload.input.modelOverride ?? "-"}`);
  runtime.log(`Default resolved: ${payload.defaults.provider}/${payload.defaults.model}`);
  runtime.log(
    `Explicit provider override applied: ${payload.resolution.explicitProviderOverrideApplied ?? "-"}`,
  );
  runtime.log(
    `Explicit model override applied: ${payload.resolution.explicitModelOverrideApplied ?? "-"}`,
  );
  runtime.log(
    `Family inference applied: ${payload.resolution.familyInferenceApplied ? "yes" : "no"}`,
  );
  runtime.log(`Final resolved: ${payload.resolved.provider}/${payload.resolved.model}`);
}
