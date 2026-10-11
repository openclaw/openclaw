import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  cloneConfigWithResolutionFacts,
  serializeConfigResolutionFacts,
} from "../config/resolution-facts.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { parseSecretRef, type SecretRef } from "../config/types.secrets.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { secretRefKey } from "./ref-contract.js";
import type {
  PreparedSecretsRuntimeSnapshot,
  SecretsRuntimeRefreshContext,
} from "./runtime-state.js";

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
  snapshot: Pick<PreparedSecretsRuntimeSnapshot, "sourceConfig" | "authStores">,
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

/** Prepare display-only bytes after the state owner verifies its live credential revisions. */
export function createSecretsRuntimeDisplaySnapshot(params: {
  config: OpenClawConfig;
  env?: Record<string, string | undefined>;
  includeAuthStoreRefs?: boolean;
  manifestRegistry?: Pick<PluginManifestRegistry, "plugins">;
  activeSnapshot: PreparedSecretsRuntimeSnapshot;
  refreshContext: SecretsRuntimeRefreshContext;
  cloneSnapshot: () => PreparedSecretsRuntimeSnapshot;
}): PreparedSecretsRuntimeSnapshot | null {
  const { activeSnapshot, refreshContext } = params;
  if (
    !refreshContext.includeConfigRefs ||
    (params.includeAuthStoreRefs === true && !refreshContext.includeAuthStoreRefs) ||
    isDeepStrictEqual(activeSnapshot.sourceConfig.ui, params.config.ui) ||
    (params.env && !isDeepStrictEqual(refreshContext.env, params.env)) ||
    (params.manifestRegistry &&
      !isDeepStrictEqual(refreshContext.manifestRegistry, params.manifestRegistry)) ||
    !isDeepStrictEqual(
      serializeConfigResolutionFacts(activeSnapshot.sourceConfig),
      serializeConfigResolutionFacts(params.config),
    )
  ) {
    return null;
  }
  const runtimeInputs = ({ ui: _ui, meta, ...config }: OpenClawConfig) => {
    const { lastTouchedVersion: _lastTouchedVersion, ...runtimeMeta } = meta ?? {};
    return { ...config, meta: runtimeMeta };
  };
  if (
    !isDeepStrictEqual(runtimeInputs(activeSnapshot.sourceConfig), runtimeInputs(params.config))
  ) {
    return null;
  }
  const snapshot = params.cloneSnapshot();
  snapshot.sourceConfig = cloneConfigWithResolutionFacts(params.config);
  if (params.config.ui === undefined) {
    delete snapshot.config.ui;
  } else {
    snapshot.config.ui = structuredClone(params.config.ui);
  }
  if (params.config.meta === undefined) {
    delete snapshot.config.meta;
  } else {
    snapshot.config.meta = structuredClone(params.config.meta);
  }
  return snapshot;
}
