import { parseModelCatalogRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { getRecord } from "../../../config/legacy.shared.js";
import {
  computeModelPolicyAllowlist,
  hasModelPolicyAllowlistMigrationMarker,
  materializeModelPolicyAllowlist,
} from "../../../config/model-policy-allowlist-migration.js";
import { parseModelPolicyWildcardRef } from "../../../config/model-policy-ref.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { DoctorPrompter } from "../../doctor-prompter.js";
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

type ModelAllowlistWildcardOffer = {
  agentId?: string;
  before: string[];
  after: string[];
};

/** The narrowest segment wildcard covering an exact ref, e.g. clawrouter/anthropic/*. */
function familyWildcard(ref: string): string | null {
  if (parseModelPolicyWildcardRef(ref)) {
    return null;
  }
  const parsed = parseModelCatalogRef(ref.trim());
  if (!parsed) {
    return null;
  }
  const family = parsed.modelId.split("/").slice(0, -1);
  return parseModelPolicyWildcardRef([parsed.provider, ...family, "*"].join("/"))?.key ?? null;
}

function wildcardOffer(
  allow: unknown,
  modelKeys: ReadonlySet<string>,
): Omit<ModelAllowlistWildcardOffer, "agentId"> | null {
  if (!Array.isArray(allow) || allow.length === 0) {
    return null;
  }
  const before = allow.filter((ref): ref is string => typeof ref === "string");
  const refs = new Set(before.map((ref) => ref.trim()));
  // Only the copied shape qualifies; a list that differs from the model map was written by hand.
  if (
    before.length !== allow.length ||
    refs.size !== modelKeys.size ||
    [...refs].some((ref) => !modelKeys.has(ref))
  ) {
    return null;
  }
  const after = new Set<string>();
  for (const ref of before) {
    const wildcard = familyWildcard(ref);
    if (!wildcard) {
      return null;
    }
    after.add(wildcard);
  }
  return { before, after: [...after] };
}

/** Exact-ref allowlists that mirror agents.defaults.models, the shape the legacy migration copied. */
function collectModelAllowlistWildcardOffers(cfg: OpenClawConfig): ModelAllowlistWildcardOffer[] {
  const modelKeys = new Set(
    Object.keys(cfg.agents?.defaults?.models ?? {})
      .map((key) => key.trim())
      .filter(Boolean),
  );
  if (modelKeys.size === 0) {
    return [];
  }
  const offers: ModelAllowlistWildcardOffer[] = [];
  const defaultOffer = wildcardOffer(cfg.agents?.defaults?.modelPolicy?.allow, modelKeys);
  if (defaultOffer) {
    offers.push(defaultOffer);
  }
  for (const [agentId, entry] of Object.entries(cfg.agents?.entries ?? {})) {
    const offer = wildcardOffer(entry?.modelPolicy?.allow, modelKeys);
    if (offer) {
      offers.push({ agentId, ...offer });
    }
  }
  return offers;
}

function applyModelAllowlistWildcardOffers(
  cfg: OpenClawConfig,
  offers: readonly ModelAllowlistWildcardOffer[],
): OpenClawConfig {
  const agents = { ...cfg.agents };
  for (const { agentId, after } of offers) {
    if (agentId === undefined) {
      agents.defaults = {
        ...agents.defaults,
        modelPolicy: { ...agents.defaults?.modelPolicy, allow: after },
      };
      continue;
    }
    const entry = agents.entries?.[agentId];
    agents.entries = {
      ...agents.entries,
      [agentId]: { ...entry, modelPolicy: { ...entry?.modelPolicy, allow: after } },
    };
  }
  return { ...cfg, agents };
}

/**
 * Offer provider wildcards for a copied exact-ref allowlist. A handcrafted list can match the
 * copied shape, so only an operator at a terminal may accept; the default keeps the list.
 */
export async function maybeOfferModelAllowlistWildcards(params: {
  cfg: OpenClawConfig;
  prompter: DoctorPrompter;
}): Promise<{ config: OpenClawConfig; changes: string[] }> {
  const unchanged = { config: params.cfg, changes: [] };
  const { repairMode } = params.prompter;
  if (!repairMode.canPrompt || repairMode.updateInProgress) {
    return unchanged;
  }
  const offers = collectModelAllowlistWildcardOffers(params.cfg);
  if (offers.length === 0) {
    return unchanged;
  }
  const { note } = await import("../../../../packages/terminal-core/src/note.js");
  note(
    [
      "Your allowed-models list matches your per-model settings, so new models from these providers stay hidden.",
      ...offers.map(
        ({ agentId, before, after }) =>
          `${agentId === undefined ? "agents.defaults" : `agents.entries.${agentId}`}.modelPolicy.allow\n  now: ${before.join(", ")}\n  new: ${after.join(", ")}`,
      ),
    ].join("\n"),
    "Model policy",
  );
  const accepted = await params.prompter.confirmRuntimeRepair({
    message: "Allow all models from these providers instead?",
    initialValue: false,
    requiresInteractiveConfirmation: true,
  });
  if (!accepted) {
    return unchanged;
  }
  // The config writer prints these once the write commits.
  return {
    config: applyModelAllowlistWildcardOffers(params.cfg, offers),
    changes: offers.map(
      ({ agentId, after }) =>
        `- ${agentId === undefined ? "agents.defaults" : `agents.entries.${agentId}`}.modelPolicy.allow: ${after.join(", ")}`,
    ),
  };
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
