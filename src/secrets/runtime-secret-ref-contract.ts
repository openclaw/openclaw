import { isDeepStrictEqual } from "node:util";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { parseSecretRef, type SecretRef } from "../config/types.secrets.js";
import { isRecord } from "../utils.js";
import { secretRefKey } from "./ref-contract.js";
import type { PreparedSecretsRuntimeSnapshot } from "./runtime-state.js";
type LocatedSecretRef = {
  path: Array<string | number>;
  ref: SecretRef;
};

type SecretDefaults = Parameters<typeof parseSecretRef>[1];

function listLocatedSecretRefs(
  value: unknown,
  defaults: SecretDefaults | undefined,
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
  return isDeepStrictEqual(
    {
      refs: listLocatedSecretRefs(left, left.secrets?.defaults),
      defaults: left.secrets?.defaults,
      providers: left.secrets?.providers,
    },
    {
      refs: listLocatedSecretRefs(right, right.secrets?.defaults),
      defaults: right.secrets?.defaults,
      providers: right.secrets?.providers,
    },
  );
}
