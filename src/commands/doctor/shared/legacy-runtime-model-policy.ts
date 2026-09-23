// Shared legacy runtime policy projection for selected canonical model refs.
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { getRecord } from "../../../config/legacy.shared.js";
import {
  computeModelPolicyAllowlist,
  hasModelPolicyAllowlistMigrationMarker,
  materializeModelPolicyAllowlist,
} from "../../../config/model-policy-allowlist-migration.js";
import { isRecord } from "./legacy-config-record-shared.js";

export function collectLegacyDefaultModelAllowRefs(raw: Record<string, unknown>): string[] | null {
  // Marker seeding at the config write boundary ships atomically with metadata-only
  // model maps. Therefore an unmarked map is legacy even if a general write version advanced.
  const defaults = getRecord(getRecord(raw.agents)?.defaults);
  return computeModelPolicyAllowlist({ root: raw, defaults });
}

export function migrateExplicitDefaultModelAllowPolicy(
  raw: Record<string, unknown>,
  changes: string[],
): void {
  if (hasModelPolicyAllowlistMigrationMarker(raw)) {
    return;
  }
  const defaults = getRecord(getRecord(raw.agents)?.defaults);
  const defaultModelPolicy = getRecord(defaults?.modelPolicy);
  const defaultNeedsEvaluation =
    Boolean(getRecord(defaults?.models)) &&
    !(defaultModelPolicy && Object.hasOwn(defaultModelPolicy, "allow"));
  if (!defaultNeedsEvaluation) {
    return;
  }
  const migrated = materializeModelPolicyAllowlist(raw);
  if (migrated.kind === "deferred") {
    return;
  }
  Object.assign(raw, migrated.config);
  changes.push(
    migrated.config.agents?.defaults?.modelPolicy?.allow
      ? "Copied the legacy default model map to agents.defaults.modelPolicy.allow."
      : "Recorded the legacy default model map as unrestricted without creating modelPolicy.allow.",
  );
}

/** Select canonical refs owned by a provider, preserving config order and duplicates. */
export function selectedCanonicalModelRefsForRuntimePolicy(
  rawModel: unknown,
  provider: string,
): string[] {
  const refs: string[] = [];
  const addRef = (rawRef: unknown) => {
    if (typeof rawRef !== "string") {
      return;
    }
    const ref = rawRef.trim();
    const slash = ref.indexOf("/");
    if (
      slash <= 0 ||
      slash >= ref.length - 1 ||
      normalizeProviderId(ref.slice(0, slash)) !== normalizeProviderId(provider)
    ) {
      return;
    }
    refs.push(ref);
  };

  if (typeof rawModel === "string") {
    addRef(rawModel);
    return refs;
  }
  if (!isRecord(rawModel)) {
    return refs;
  }
  addRef(rawModel.primary);
  if (Array.isArray(rawModel.fallbacks)) {
    for (const fallback of rawModel.fallbacks) {
      addRef(fallback);
    }
  }
  return refs;
}

/** Add runtime policy unless the model entry already selects an explicit non-auto runtime. */
export function modelEntryWithRuntimePolicy(
  entry: unknown,
  runtime: string,
): { changed: boolean; entry: Record<string, unknown> } {
  const next = isRecord(entry) ? { ...entry } : {};
  const currentRuntime = isRecord(next.agentRuntime) ? next.agentRuntime : undefined;
  const currentRuntimeId = normalizeOptionalLowercaseString(currentRuntime?.id);
  if (currentRuntimeId && currentRuntimeId !== "auto") {
    return { changed: false, entry: next };
  }
  next.agentRuntime = { ...currentRuntime, id: runtime };
  return { changed: true, entry: next };
}
