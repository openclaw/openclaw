import { loadSessionStore } from "../../config/sessions.js";
import { type OutputRuntimeEnv, writeRuntimeJson } from "../../runtime.js";
import {
  resolveGatewaySessionStoreTarget,
  resolveSessionModelRef,
} from "../../gateway/session-utils.js";
import { colorize, theme } from "../../terminal/theme.js";
import { shortenHomePath } from "../../utils.js";
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

  const rich = process.stdout.isTTY;
  const label = (value: string) => colorize(rich, theme.accent, value.padEnd(28));
  const muted = (value: string) => colorize(rich, theme.muted, value);
  const info = (value: string) => colorize(rich, theme.info, value);
  const success = (value: string) => colorize(rich, theme.success, value);

  runtime.log(`${label("Agent")}${muted(": ")}${info(payload.agentId)}`);
  if (payload.session) {
    runtime.log(
      `${label("Session")}${muted(": ")}${info(payload.session.key)}${muted(` (${shortenHomePath(payload.session.storePath ?? "")})`)}`,
    );
  }
  runtime.log(
    `${label("Default resolved")}${muted(": ")}${info(`${payload.defaults.provider}/${payload.defaults.model}`)}`,
  );
  runtime.log(
    `${label("Provider override")}${muted(": ")}${info(payload.resolution.explicitProviderOverrideApplied ?? "-")}`,
  );
  runtime.log(
    `${label("Model override")}${muted(": ")}${info(payload.resolution.explicitModelOverrideApplied ?? "-")}`,
  );
  if (payload.input.runtimeProvider || payload.input.runtimeModel) {
    runtime.log(
      `${label("Persisted runtime ref")}${muted(": ")}${info(`${payload.input.runtimeProvider ?? "-"}/${payload.input.runtimeModel ?? "-"}`)}`,
    );
  }
  runtime.log(
    `${label("Family inference")}${muted(": ")}${payload.resolution.familyInferenceApplied ? success("yes") : muted("no")}`,
  );
  runtime.log(
    `${label("Final resolved")}${muted(": ")}${success(`${payload.resolved.provider}/${payload.resolved.model}`)}`,
  );
}
