import { normalizeAgentId } from "@openclaw/normalization-core/agent-id";
import { readAgentRosterProperty } from "../agents/agent-scope-config.js";
import {
  listLegacyOwnershipWarnings,
  retainLegacyDefaultAgentId,
  tryGetLegacyDefaultAgentId,
} from "./legacy.default-agent-owner.js";
import { materializeLegacyDefaultAgentRoles } from "./legacy.default-agent-roles.js";
import type { OpenClawConfig } from "./types.openclaw.js";

type MigrationResult = {
  config: unknown;
  changed: boolean;
  diagnostics: string[];
  insertedPaths?: string[][];
  retainedLegacyDefaultAgentId?: string;
};

/** Returns the effective owner encoded by a legacy roster/default-marker shape. */
function tryResolveLegacyDefaultAgentId(raw: unknown): string | undefined {
  const rosterProperty = readAgentRosterProperty(raw);
  if (!rosterProperty) {
    return undefined;
  }
  const values =
    rosterProperty.kind === "list"
      ? Array.isArray(rosterProperty.value)
        ? rosterProperty.value.map((entry) =>
            entry && typeof entry === "object" && !Array.isArray(entry)
              ? { id: (entry as Record<string, unknown>).id, entry }
              : undefined,
          )
        : []
      : rosterProperty.value &&
          typeof rosterProperty.value === "object" &&
          !Array.isArray(rosterProperty.value)
        ? Object.entries(rosterProperty.value).map(([id, entry]) => ({ id, entry }))
        : [];
  if (
    values.some((candidate) => {
      if (
        !candidate?.entry ||
        typeof candidate.entry !== "object" ||
        Array.isArray(candidate.entry)
      ) {
        return false;
      }
      const entry = candidate.entry as Record<string, unknown>;
      return Object.hasOwn(entry, "default") && typeof entry.default !== "boolean";
    })
  ) {
    return undefined;
  }
  const valid = values.flatMap((candidate) => {
    if (
      !candidate ||
      typeof candidate.id !== "string" ||
      !candidate.entry ||
      typeof candidate.entry !== "object" ||
      Array.isArray(candidate.entry)
    ) {
      return [];
    }
    const entry = candidate.entry as Record<string, unknown>;
    return [{ id: normalizeAgentId(candidate.id), entry }];
  });
  if (valid.length === 0) {
    return undefined;
  }
  const marked = valid.find(({ entry }) => entry.default === true);
  if (marked) {
    return marked.id;
  }
  const hasBooleanMarker = valid.some(({ entry }) => Object.hasOwn(entry, "default"));
  if (hasBooleanMarker) {
    return valid[0]!.id;
  }
  const agents = (raw as { agents?: unknown }).agents;
  const explicitOwnership =
    agents &&
    typeof agents === "object" &&
    !Array.isArray(agents) &&
    (agents as Record<string, unknown>).ownership === "explicit";
  // The durable roster-level generation marker is the only discriminator.
  // Marker-free fleets that predate it retain shipped first-entry ownership.
  return valid.length > 1 && !explicitOwnership ? valid[0]!.id : undefined;
}

function injectImplicitMain(
  root: Record<string, unknown>,
  agents: Record<string, unknown>,
): MigrationResult {
  return {
    config: { ...root, agents: { ...agents, entries: { main: {} } } },
    changed: true,
    diagnostics: [],
  };
}

/**
 * Canonicalizes legacy roster shapes before schema validation.
 * Missing/empty rosters become the sole `main` agent; boolean default markers are
 * consumed only here and never reach steady-state runtime config.
 */
export function migratePersistedImplicitMainRoster(
  raw: unknown,
  env: NodeJS.ProcessEnv = process.env,
): MigrationResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { config: raw, changed: false, diagnostics: [] };
  }
  const root = raw as Record<string, unknown>;
  if (
    Object.hasOwn(root, "agents") &&
    (!root.agents || typeof root.agents !== "object" || Array.isArray(root.agents))
  ) {
    return { config: raw, changed: false, diagnostics: [] };
  }
  let agents =
    root.agents && typeof root.agents === "object" && !Array.isArray(root.agents)
      ? (root.agents as Record<string, unknown>)
      : {};
  const rawLegacyDefaultAgentId =
    tryGetLegacyDefaultAgentId(raw as OpenClawConfig) ??
    tryResolveLegacyDefaultAgentId({ ...root, agents });
  const diagnostics: string[] = [];
  let changed = false;
  let legacyListOrder: string[] | undefined;
  let rosterProperty = readAgentRosterProperty({ ...root, agents });
  if (rosterProperty?.kind === "list") {
    if (!Array.isArray(rosterProperty.value)) {
      return { config: raw, changed: false, diagnostics: [] };
    }
    const legacyList = rosterProperty.value;
    if (legacyList.some((value) => !value || typeof value !== "object" || Array.isArray(value))) {
      return { config: raw, changed: false, diagnostics: [] };
    }
    const legacyIds = new Set<string>();
    const legacyOrder: string[] = [];
    for (const value of legacyList) {
      const entry = value as Record<string, unknown>;
      if (typeof entry.id !== "string" || entry.id.trim() !== entry.id || !entry.id) {
        return { config: raw, changed: false, diagnostics: [] };
      }
      const normalizedId = normalizeAgentId(entry.id);
      if (normalizedId !== entry.id || legacyIds.has(normalizedId)) {
        return { config: raw, changed: false, diagnostics: [] };
      }
      legacyIds.add(normalizedId);
      legacyOrder.push(entry.id);
    }
    legacyListOrder = legacyOrder;
    const entries = Object.fromEntries(
      legacyList.map((value) => {
        const entry = value as Record<string, unknown>;
        const { id, ...config } = entry;
        return [id as string, config];
      }),
    );
    const { list: _list, ...rest } = agents;
    agents = { ...rest, entries };
    rosterProperty = readAgentRosterProperty({ ...root, agents });
    diagnostics.push("Moved agents.list to keyed agents.entries.");
    changed = true;
  }

  const entries = rosterProperty?.kind === "entries" ? rosterProperty.value : undefined;
  const explicitOwnership = agents.ownership === "explicit";
  if (!rosterProperty) {
    if (explicitOwnership) {
      return { config: changed ? { ...root, agents } : raw, changed, diagnostics };
    }
    const injected = injectImplicitMain(root, agents);
    return { ...injected, diagnostics: [...diagnostics, ...injected.diagnostics] };
  }
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
    return { config: changed ? { ...root, agents } : raw, changed, diagnostics };
  }
  const roster = entries as Record<string, unknown>;
  if (Object.keys(roster).length === 0) {
    if (explicitOwnership) {
      return { config: changed ? { ...root, agents } : raw, changed, diagnostics };
    }
    const injected = injectImplicitMain(root, agents);
    return { ...injected, diagnostics: [...diagnostics, ...injected.diagnostics] };
  }

  const validIds = Object.entries(roster).flatMap(([id, entry]) =>
    entry && typeof entry === "object" && !Array.isArray(entry) ? [id] : [],
  );
  if (validIds.length === 0) {
    return { config: changed ? { ...root, agents } : raw, changed, diagnostics };
  }
  const hasInvalidDefaultMarker = validIds.some((id) => {
    const entry = roster[id] as Record<string, unknown>;
    return Object.hasOwn(entry, "default") && typeof entry.default !== "boolean";
  });
  if (hasInvalidDefaultMarker) {
    // Non-boolean retired values remain visible so strict schema validation rejects them.
    return { config: changed ? { ...root, agents } : raw, changed, diagnostics };
  }

  const defaultIds = new Set(
    validIds.filter((id) => (roster[id] as Record<string, unknown>).default === true),
  );
  const hasBooleanMarker = validIds.some((id) =>
    Object.hasOwn(roster[id] as Record<string, unknown>, "default"),
  );
  // H2-0 normalized duplicate true markers to the first marked entry and
  // false-only marker sets to the first valid entry. Preserve that owner before
  // retiring the field so upgrades do not silently reroute ambient work.
  const orderedValidIds = legacyListOrder ?? validIds;
  const orderedDefaultId = orderedValidIds.find((id) => defaultIds.has(id));
  const candidateLegacyDefaultAgentId =
    rawLegacyDefaultAgentId ??
    orderedDefaultId ??
    (legacyListOrder || hasBooleanMarker ? orderedValidIds[0] : undefined);
  const markerFreeFleet = validIds.length > 1 && !hasBooleanMarker;
  let nextRoot: Record<string, unknown> = { ...root, agents };
  // Retired boolean markers always carry shipped ownership. Marker-free fleets
  // retain first-entry ownership only until Doctor stamps the durable generation.
  const legacyDefaultAgentId =
    (hasBooleanMarker && Object.keys(roster).length > 1) ||
    (validIds.length > 1 && !explicitOwnership)
      ? candidateLegacyDefaultAgentId
      : undefined;
  let materializationWarnings = listLegacyOwnershipWarnings(raw as OpenClawConfig);
  let insertedPaths: string[][] = [];
  if (Object.keys(roster).length > 1 && legacyDefaultAgentId) {
    const materialized = materializeLegacyDefaultAgentRoles(
      nextRoot as OpenClawConfig,
      legacyDefaultAgentId,
      { materializeWorkspace: true, env },
    );
    nextRoot = materialized.config as Record<string, unknown>;
    materializationWarnings = [...materializationWarnings, ...materialized.warnings];
    insertedPaths = materialized.insertedPaths;
    diagnostics.push(...materialized.changes);
    changed = changed || materialized.changes.length > 0;
    if (markerFreeFleet && !explicitOwnership && materialized.changes.length === 0) {
      // Doctor still needs a write even when every currently known surface was
      // already explicit; only agents.ownership durably ends legacy semantics.
      changed = true;
      diagnostics.push("Marked the legacy agent roster for explicit ownership persistence.");
    }
  }

  if (hasBooleanMarker) {
    const materializedEntries = ((nextRoot.agents as Record<string, unknown> | undefined)
      ?.entries ?? roster) as Record<string, unknown>;
    const strippedEntries = Object.fromEntries(
      Object.entries(materializedEntries).map(([id, entry]) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
          return [id, entry];
        }
        const { default: _default, ...nextEntry } = entry as Record<string, unknown>;
        return [id, nextEntry];
      }),
    );
    const nextAgents = {
      ...((nextRoot.agents as Record<string, unknown> | undefined) ?? agents),
      entries: strippedEntries,
    };
    nextRoot = { ...nextRoot, agents: nextAgents };
    diagnostics.push("Removed retired agents.entries.*.default markers.");
    changed = true;
  }

  const config = (changed ? nextRoot : raw) as OpenClawConfig;
  const retainedLegacyDefaultAgentId = legacyDefaultAgentId;
  retainLegacyDefaultAgentId(config, legacyDefaultAgentId, {
    warnings: markerFreeFleet ? materializationWarnings : undefined,
  });
  return {
    config,
    changed,
    diagnostics,
    ...(insertedPaths.length > 0 ? { insertedPaths } : {}),
    ...(retainedLegacyDefaultAgentId ? { retainedLegacyDefaultAgentId } : {}),
  };
}
