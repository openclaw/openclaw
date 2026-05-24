/**
 * workspace-neotoma.ts — Neotoma agent_definition bootstrap integration.
 *
 * At daemon startup, OpenClaw can load an agent's `prompt_markdown` field from a
 * Neotoma `agent_definition` entity and inject it as the SOUL.md bootstrap file.
 *
 * This makes agent prompt updates a Neotoma `correct()` call rather than a disk edit —
 * the Neotoma-canonical principle applied at the OpenClaw layer.
 *
 * ## Fallback chain (in order)
 *  1. `NEOTOMA_AGENT_DEFINITION_ID` env var — load entity by ID
 *  2. `NEOTOMA_AGENT_NAME` env var — search for entity by `name` field
 *  3. Disk `SOUL.md` — unchanged (Neotoma unavailable or not configured)
 *
 * ## Required env vars
 *  NEOTOMA_BEARER_TOKEN          Neotoma API bearer token
 *  NEOTOMA_BASE_URL              Neotoma API base URL (default: https://neotoma.markmhendrickson.com)
 *
 * ## Optional env vars
 *  NEOTOMA_AGENT_DEFINITION_ID   Entity ID to load (e.g. ent_bf712273fe3ea48a505c6e81)
 *  NEOTOMA_AGENT_NAME            Agent name to search for (e.g. "onychomys")
 *  NEOTOMA_SOUL_OVERRIDE         Set to "0" to disable Neotoma SOUL injection even if configured
 *  NEOTOMA_SOUL_TIMEOUT_MS       HTTP timeout for Neotoma fetch (default: 8000)
 */

import type { WorkspaceBootstrapFile } from "./workspace.js";
import { DEFAULT_SOUL_FILENAME } from "./workspace.js";

const NEOTOMA_BASE_URL =
  process.env.NEOTOMA_BASE_URL?.trim() || "https://neotoma.markmhendrickson.com";
const NEOTOMA_BEARER_TOKEN = process.env.NEOTOMA_BEARER_TOKEN?.trim() || "";
const NEOTOMA_AGENT_DEFINITION_ID = process.env.NEOTOMA_AGENT_DEFINITION_ID?.trim() || "";
const NEOTOMA_AGENT_NAME = process.env.NEOTOMA_AGENT_NAME?.trim() || "";
const NEOTOMA_SOUL_OVERRIDE = process.env.NEOTOMA_SOUL_OVERRIDE?.trim();
const NEOTOMA_SOUL_TIMEOUT_MS = parseInt(process.env.NEOTOMA_SOUL_TIMEOUT_MS ?? "8000", 10);

/** True when Neotoma SOUL injection is configured and not explicitly disabled. */
export function isNeotomaSoulEnabled(): boolean {
  if (NEOTOMA_SOUL_OVERRIDE === "0") {
    return false;
  }
  if (!NEOTOMA_BEARER_TOKEN) {
    return false;
  }
  return Boolean(NEOTOMA_AGENT_DEFINITION_ID || NEOTOMA_AGENT_NAME);
}

type FetchResult =
  | { ok: true; promptMarkdown: string; entityId: string; agentName: string }
  | { ok: false; reason: string };

/** Fetch agent_definition snapshot from Neotoma by entity ID. */
async function fetchByEntityId(entityId: string): Promise<FetchResult> {
  const url = `${NEOTOMA_BASE_URL}/entities/${encodeURIComponent(entityId)}`;
  const resp = await fetchWithTimeout(url);
  if (!resp.ok) {
    return { ok: false, reason: `HTTP ${resp.status} for entity ${entityId}` };
  }
  const data = (await resp.json()) as {
    snapshot?: Record<string, unknown>;
    entity?: { snapshot?: Record<string, unknown> };
  };
  const snapshot = data.snapshot ?? data.entity?.snapshot ?? {};
  const promptMarkdown =
    typeof snapshot.prompt_markdown === "string" ? snapshot.prompt_markdown : "";
  if (!promptMarkdown) {
    return { ok: false, reason: `entity ${entityId} has no prompt_markdown field` };
  }
  const agentName = typeof snapshot.name === "string" ? snapshot.name : entityId;
  return { ok: true, promptMarkdown, entityId, agentName };
}

/** Search agent_definition entities by name and return the best match. */
async function fetchByAgentName(agentName: string): Promise<FetchResult> {
  const params = new URLSearchParams({
    entity_type: "agent_definition",
    search: agentName,
    limit: "5",
    include_snapshots: "true",
  });
  const url = `${NEOTOMA_BASE_URL}/entities?${params}`;
  const resp = await fetchWithTimeout(url);
  if (!resp.ok) {
    return { ok: false, reason: `HTTP ${resp.status} searching for agent "${agentName}"` };
  }
  const data = (await resp.json()) as {
    entities?: Array<{ entity_id: string; snapshot?: Record<string, unknown> }>;
  };
  const entities = data.entities ?? [];
  for (const ent of entities) {
    const snap = ent.snapshot ?? {};
    if (typeof snap.name === "string" && snap.name.toLowerCase() === agentName.toLowerCase()) {
      const promptMarkdown = typeof snap.prompt_markdown === "string" ? snap.prompt_markdown : "";
      if (!promptMarkdown) {
        continue;
      }
      return {
        ok: true,
        promptMarkdown,
        entityId: ent.entity_id,
        agentName: snap.name,
      };
    }
  }
  return { ok: false, reason: `no agent_definition with name="${agentName}" found in Neotoma` };
}

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NEOTOMA_SOUL_TIMEOUT_MS);
  try {
    return await fetch(url, {
      headers: { Authorization: `Bearer ${NEOTOMA_BEARER_TOKEN}` },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Load `prompt_markdown` from Neotoma using the configured fallback chain.
 * Returns null if Neotoma is disabled, unconfigured, or unreachable.
 */
export async function loadNeotomaSoulContent(): Promise<{
  content: string;
  entityId: string;
  agentName: string;
} | null> {
  if (!isNeotomaSoulEnabled()) {
    return null;
  }

  let result: FetchResult;

  if (NEOTOMA_AGENT_DEFINITION_ID) {
    result = await fetchByEntityId(NEOTOMA_AGENT_DEFINITION_ID);
  } else {
    result = await fetchByAgentName(NEOTOMA_AGENT_NAME);
  }

  if (!result.ok) {
    // Non-fatal: fall back to disk SOUL.md
    console.warn(`[workspace-neotoma] Neotoma fetch failed: ${result.reason} — using disk SOUL.md`);
    return null;
  }

  return {
    content: result.promptMarkdown,
    entityId: result.entityId,
    agentName: result.agentName,
  };
}

/**
 * Apply Neotoma `prompt_markdown` as the SOUL.md bootstrap file.
 *
 * If Neotoma is configured and reachable, replaces the SOUL.md entry in `files`
 * with the fetched content. Otherwise returns `files` unchanged.
 *
 * This is the primary integration point — call it from the bootstrap hook or
 * directly from `resolveBootstrapFilesForRun`.
 */
export async function applyNeotomaSoulOverride(
  files: WorkspaceBootstrapFile[],
): Promise<WorkspaceBootstrapFile[]> {
  if (!isNeotomaSoulEnabled()) {
    return files;
  }

  let soul: { content: string; entityId: string; agentName: string } | null = null;
  try {
    soul = await loadNeotomaSoulContent();
  } catch (err) {
    console.warn(
      `[workspace-neotoma] Unexpected error fetching agent_definition: ${String(err)} — using disk SOUL.md`,
    );
    return files;
  }

  if (!soul) {
    return files;
  }

  const soulIdx = files.findIndex((f) => f.name === DEFAULT_SOUL_FILENAME);
  const soulEntry: WorkspaceBootstrapFile = {
    name: DEFAULT_SOUL_FILENAME,
    path: files[soulIdx]?.path ?? DEFAULT_SOUL_FILENAME,
    content: soul.content,
    missing: false,
  };

  if (soulIdx === -1) {
    // SOUL.md was missing from disk — append the Neotoma version
    return [...files, soulEntry];
  }

  const updated = [...files];
  updated[soulIdx] = soulEntry;

  console.info(
    `[workspace-neotoma] Loaded SOUL from Neotoma: entity=${soul.entityId} agent=${soul.agentName}`,
  );
  return updated;
}
