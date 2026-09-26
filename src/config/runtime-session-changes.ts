import { isDeepStrictEqual } from "node:util";
import { serializeConfigResolutionFacts } from "./resolution-facts.js";
import type { OpenClawConfig } from "./types.openclaw.js";

function projectionConfig({
  meta: _meta,
  wizard: _wizard,
  logging: _logging,
  diagnostics: _diagnostics,
  update: _update,
  telemetry: _telemetry,
  ui,
  gateway,
  ...config
}: OpenClawConfig) {
  const { prefs: _prefs, ...uiConfig } = ui ?? {};
  const { auth, ...gatewayConfig } = gateway ?? {};
  const { identityScopes: _identityScopes, ...authConfig } = auth ?? {};
  // Everything else remains significant, including plugin policy, sharing, models,
  // session policy, roster and physical store selection.
  return { ...config, ui: uiConfig, gateway: { ...gatewayConfig, auth: authConfig } };
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
      list: agents.list?.map(withoutIdentity),
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
