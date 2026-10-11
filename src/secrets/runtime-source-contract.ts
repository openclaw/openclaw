import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import { serializeConfigResolutionFacts } from "../config/resolution-facts.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { parseSecretRef, type SecretRef } from "../config/types.secrets.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { secretRefKey } from "./ref-contract.js";

type LocatedSecretRef = {
  path: Array<string | number>;
  ref: SecretRef;
};

function listLocatedSecretRefs(
  value: unknown,
  defaults: Parameters<typeof parseSecretRef>[1],
  path: Array<string | number> = [],
  refs: LocatedSecretRef[] = [],
): LocatedSecretRef[] {
  const ref = parseSecretRef(value, defaults);
  if (ref) {
    refs.push({ path, ref });
    return refs;
  }
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      listLocatedSecretRefs(entry, defaults, [...path, index], refs);
    }
    return refs;
  }
  if (isRecord(value)) {
    for (const key of Object.keys(value).toSorted()) {
      listLocatedSecretRefs(value[key], defaults, [...path, key], refs);
    }
  }
  return refs;
}

/** Canonical store refs across config and auth profiles for one mutated team entry. */
export function collectSecretStoreRefKeysInSnapshot(
  snapshot: {
    sourceConfig: OpenClawConfig;
    authStores: ReadonlyArray<{ store: AuthProfileStore }>;
  },
  name: string,
): Set<string> {
  const sources = [snapshot.sourceConfig, ...snapshot.authStores.map(({ store }) => store)];
  return new Set(
    listLocatedSecretRefs(sources, snapshot.sourceConfig.secrets?.defaults).flatMap(({ ref }) =>
      ref.source === "store" && ref.id === name ? [secretRefKey(ref)] : [],
    ),
  );
}

/** Whether two configs resolve the same SecretRefs through the same provider contracts. */
export function hasSameSecretReloadContract(left: OpenClawConfig, right: OpenClawConfig): boolean {
  const contract = (config: OpenClawConfig) => ({
    refs: listLocatedSecretRefs(config, config.secrets?.defaults),
    defaults: config.secrets?.defaults,
    providers: config.secrets?.providers,
  });
  return isDeepStrictEqual(contract(left), contract(right));
}

/** Compare display inputs after the state owner verifies its live credential revisions. */
export function isSecretsRuntimeDisplayChange(params: {
  config: OpenClawConfig;
  env?: Record<string, string | undefined>;
  includeAuthStoreRefs?: boolean;
  manifestRegistry?: Pick<PluginManifestRegistry, "plugins">;
  sourceConfig: OpenClawConfig;
  refreshContext: {
    env: Record<string, string | undefined>;
    includeConfigRefs?: boolean;
    includeAuthStoreRefs: boolean;
    manifestRegistry?: Pick<PluginManifestRegistry, "plugins">;
  };
}): boolean {
  const { sourceConfig, refreshContext } = params;
  if (
    !refreshContext.includeConfigRefs ||
    (params.includeAuthStoreRefs === true && !refreshContext.includeAuthStoreRefs) ||
    isDeepStrictEqual(sourceConfig.ui, params.config.ui) ||
    (params.env && !isDeepStrictEqual(refreshContext.env, params.env)) ||
    (params.manifestRegistry &&
      !isDeepStrictEqual(refreshContext.manifestRegistry, params.manifestRegistry)) ||
    !isDeepStrictEqual(
      serializeConfigResolutionFacts(sourceConfig),
      serializeConfigResolutionFacts(params.config),
    )
  ) {
    return false;
  }
  const runtimeInputs = ({ ui: _ui, meta, ...config }: OpenClawConfig) => {
    const { lastTouchedVersion: _lastTouchedVersion, ...runtimeMeta } = meta ?? {};
    return { ...config, meta: runtimeMeta };
  };
  return isDeepStrictEqual(runtimeInputs(sourceConfig), runtimeInputs(params.config));
}
