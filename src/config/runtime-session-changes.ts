import { isDeepStrictEqual } from "node:util";
import { collectConfiguredModelRefs } from "@openclaw/model-catalog-core/configured-model-refs";
import { resolveChannelConfigActivationFacts } from "./channel-config-activation.js";
import { serializeConfigResolutionFacts } from "./resolution-facts.js";
import type { OpenClawConfig } from "./types.openclaw.js";

function projectionConfig({
  meta: _meta,
  wizard: _wizard,
  logging: _logging,
  diagnostics: _diagnostics,
  update: _update,
  telemetry: _telemetry,
  channels,
  ui,
  gateway,
  talk,
  ...config
}: OpenClawConfig) {
  const { prefs: _prefs, ...uiConfig } = ui ?? {};
  const { auth, ...gatewayConfig } = gateway ?? {};
  const { identityScopes: _identityScopes, ...authConfig } = auth ?? {};
  const { realtime, ...talkConfig } = talk ?? {};
  const { model: _realtimeModel, ...realtimeConfig } = realtime ?? {};
  // Channel transport settings do not affect resident rows. Keep their catalog
  // inputs, including activation that can admit bundled plugin capabilities.
  return {
    ...config,
    channels: {
      activation: resolveChannelConfigActivationFacts({ channels }),
      models: collectConfiguredModelRefs({ channels }),
    },
    ui: uiConfig,
    gateway: { ...gatewayConfig, auth: authConfig },
    talk: { ...talkConfig, realtime: realtimeConfig },
  };
}

function withoutAgentIdentities(config: ReturnType<typeof projectionConfig>) {
  const agents = config.agents;
  const withoutIdentity = <T extends { identity?: unknown }>({
    identity: _identity,
    ...entry
  }: T) => entry;
  return {
    ...config,
    agents: agents && {
      ...agents,
      entries:
        agents.entries &&
        Object.fromEntries(
          Object.entries(agents.entries).map(([id, entry]) => [id, withoutIdentity(entry)]),
        ),
      // The loader's non-enumerable list is a projection when entries owns the roster.
      list: Object.hasOwn(agents, "entries") ? undefined : agents.list?.map(withoutIdentity),
    },
  };
}

/** Classify once at committed config publication; consumers retain their prepared facts. */
export function runtimeSessionChangeScope(
  previous: OpenClawConfig | null,
  next: OpenClawConfig,
): "config" | "config-presentation" | "config-profiles" {
  // In-place edits and changed resolution provenance cannot reuse captured facts.
  if (
    !previous ||
    previous === next ||
    !isDeepStrictEqual(
      serializeConfigResolutionFacts(previous),
      serializeConfigResolutionFacts(next),
    )
  ) {
    return "config";
  }
  const before = projectionConfig(previous);
  const after = projectionConfig(next);
  if (isDeepStrictEqual(before, after)) {
    return "config-presentation";
  }
  return isDeepStrictEqual(withoutAgentIdentities(before), withoutAgentIdentities(after))
    ? "config-profiles"
    : "config";
}
