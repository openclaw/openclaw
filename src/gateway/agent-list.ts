// Combines configured agents and existing on-disk agent state for lightweight UI use.
import fs from "node:fs/promises";
import path from "node:path";
import { listGatewayOwnedAgentIds } from "../agents/agent-roster.js";
import { listAgentEntries, tryResolveDefaultAgentId } from "../agents/agent-scope.js";
import { resolveAgentEntryDisplayName } from "../agents/identity.js";
import { tryResolveLegacyCompatibilityAgentId } from "../config/legacy.default-agent-owner.js";
import { resolveStateDir } from "../config/paths.js";
import type { SessionScope } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId, normalizeMainKey } from "../routing/session-key.js";
import type { GatewayAgentKind } from "../shared/session-types.js";
import {
  readAgentDatabaseAdmissionRefusal,
  type AgentDatabaseAdmissionRefusal,
} from "../state/agent-database-admission.js";
import { getPreparedAgentDeletionDiscovery } from "../state/agent-deletion-journal-status.js";
import { prepareAgentDatabaseDeletionSnapshotRead } from "../state/agent-deletion-journal.read.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { isReservedSystemAgentId } from "../system-agent/agent-id.js";

type GatewayAgentListRow = {
  id: string;
  status?: "degraded";
  admissionRefusal?: AgentDatabaseAdmissionRefusal;
  kind?: GatewayAgentKind;
  name?: string;
};

export type GatewayAgentOwnership = "sole" | "legacy" | "explicit";

type GatewayAgentSelectionState = {
  defaultId: string;
  ownership: GatewayAgentOwnership;
  selectionRequired: boolean;
};

async function listExistingAgentIdsFromDisk(): Promise<string[]> {
  const agentsDir = path.join(resolveStateDir(), "agents");
  try {
    return (await fs.readdir(agentsDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => normalizeAgentId(entry.name));
  } catch {
    return [];
  }
}

export function resolveGatewayAgentSelectionState(cfg: OpenClawConfig): GatewayAgentSelectionState {
  const configuredIds = listAgentEntries(cfg).map((entry) => normalizeAgentId(entry.id));
  const soleAgentId = tryResolveDefaultAgentId(cfg);
  if (soleAgentId) {
    return {
      defaultId: normalizeAgentId(soleAgentId),
      ownership: "sole",
      selectionRequired: false,
    };
  }
  const legacyAgentId = tryResolveLegacyCompatibilityAgentId(cfg);
  const legacyCompatibleId = legacyAgentId ?? configuredIds[0];
  if (!legacyCompatibleId) {
    throw new Error("Cannot project gateway agent ownership without a configured agent.");
  }
  const defaultId = normalizeAgentId(legacyCompatibleId);
  return {
    defaultId,
    ownership: legacyAgentId && cfg.agents?.ownership !== "explicit" ? "legacy" : "explicit",
    selectionRequired: !legacyAgentId,
  };
}

/** Lists gateway-visible agents with canonical membership, ordering, and semantic kind. */
export async function listGatewayAgentsBasic(cfg: OpenClawConfig): Promise<
  GatewayAgentSelectionState & {
    mainKey: string;
    scope: SessionScope;
    agents: GatewayAgentListRow[];
  }
> {
  const selection = resolveGatewayAgentSelectionState(cfg);
  const defaultId = selection.defaultId;
  const mainKey = normalizeMainKey(cfg.session?.mainKey);
  const scope = cfg.session?.scope ?? "per-sender";
  const configuredById = new Map<string, string | undefined>();
  const diskIds = new Set(await listExistingAgentIdsFromDisk());

  for (const entry of listAgentEntries(cfg)) {
    if (!entry?.id) {
      continue;
    }
    const id = normalizeAgentId(entry.id);
    configuredById.set(id, resolveAgentEntryDisplayName(entry));
  }

  const allowedIds = configuredById.size > 0 ? new Set(listGatewayOwnedAgentIds(cfg)) : null;
  const visibleIds = [...new Set([defaultId, ...configuredById.keys(), ...diskIds])].filter(
    (id) => !allowedIds || allowedIds.has(id),
  );
  visibleIds.sort((a, b) => a.localeCompare(b));
  const orderedIds =
    defaultId && visibleIds.includes(defaultId)
      ? [defaultId, ...visibleIds.filter((id) => id !== defaultId)]
      : visibleIds;
  if (mainKey && !orderedIds.includes(mainKey) && (!allowedIds || configuredById.has(mainKey))) {
    orderedIds.push(mainKey);
  }

  const disposition =
    getPreparedAgentDeletionDiscovery(resolveOpenClawStateSqlitePath()) ??
    (await prepareAgentDatabaseDeletionSnapshotRead({}, "runtime-discovery").read()).snapshot
      ?.retainedDeletions;
  const deletions =
    disposition?.status === "present"
      ? disposition.entries
      : disposition?.status === "unavailable"
        ? disposition.known?.entries
        : undefined;
  const agents: GatewayAgentListRow[] = orderedIds
    .filter((id) => !deletions?.some((entry) => entry.agentId === id))
    .map((id) => {
      const admissionRefusal = readAgentDatabaseAdmissionRefusal(id);
      const agent: GatewayAgentListRow = {
        id,
        kind:
          !configuredById.has(id) && diskIds.has(id) && isReservedSystemAgentId(id)
            ? "system"
            : "agent",
        name: configuredById.get(id),
      };
      if (admissionRefusal) {
        agent.status = "degraded";
        agent.admissionRefusal = admissionRefusal;
      }
      return agent;
    });
  return { ...selection, mainKey, scope, agents };
}
