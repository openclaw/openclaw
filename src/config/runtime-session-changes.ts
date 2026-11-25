import { isDeepStrictEqual } from "node:util";
import { configPathAffectsReader, projectConfigReadDependencies } from "./read-dependencies.js";
import { serializeConfigResolutionFacts } from "./resolution-facts.js";
import type { OpenClawConfig } from "./types.openclaw.js";

function withoutAgentIdentities(config: ReturnType<typeof projectConfigReadDependencies>) {
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
      serializeConfigResolutionFacts(previous, (path) => configPathAffectsReader(path, "sessions")),
      serializeConfigResolutionFacts(next, (path) => configPathAffectsReader(path, "sessions")),
    )
  ) {
    return "config";
  }
  const before = projectConfigReadDependencies(previous, "sessions");
  const after = projectConfigReadDependencies(next, "sessions");
  if (isDeepStrictEqual(before, after)) {
    return "config-presentation";
  }
  return isDeepStrictEqual(withoutAgentIdentities(before), withoutAgentIdentities(after))
    ? "config-profiles"
    : "config";
}

export function runtimeSessionPublicationChangeScope(params: {
  previousRuntimeConfig: OpenClawConfig | null;
  runtimeConfig: OpenClawConfig;
  previousSourceConfig: OpenClawConfig | null;
  sourceConfig?: OpenClawConfig;
  runtimeUnchanged: boolean;
  sourceUnchanged: boolean;
  previousEditedInPlace: boolean;
}): ReturnType<typeof runtimeSessionChangeScope> {
  if (params.previousEditedInPlace) {
    return "config";
  }
  const runtimeScope = params.runtimeUnchanged
    ? "config-presentation"
    : runtimeSessionChangeScope(params.previousRuntimeConfig, params.runtimeConfig);
  const sourceScope = params.sourceUnchanged
    ? "config-presentation"
    : runtimeSessionChangeScope(
        params.previousSourceConfig ?? params.previousRuntimeConfig,
        params.sourceConfig ?? params.runtimeConfig,
      );
  if (runtimeScope === "config" || sourceScope === "config") {
    return "config";
  }
  return runtimeScope === "config-profiles" || sourceScope === "config-profiles"
    ? "config-profiles"
    : "config-presentation";
}
