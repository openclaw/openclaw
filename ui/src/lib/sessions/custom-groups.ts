import type { GatewaySessionRow } from "../../api/types.ts";
import { getSafeLocalStorage } from "../../local-storage.ts";
import type { SessionCapability } from "./index.ts";
import { parseAgentSessionKey } from "./session-key.ts";

export const SESSION_CUSTOM_GROUPS_STORAGE_KEY = "openclaw:sessions:custom-groups";

export function loadStoredSessionCustomGroups(): string[] {
  try {
    const raw = getSafeLocalStorage()?.getItem(SESSION_CUSTOM_GROUPS_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) {
      return [];
    }
    return [
      ...new Set(
        parsed.flatMap((name) => {
          const normalized = typeof name === "string" ? name.trim() : "";
          return normalized ? [normalized] : [];
        }),
      ),
    ];
  } catch {
    return [];
  }
}

export function saveStoredSessionCustomGroups(groups: readonly string[]) {
  try {
    getSafeLocalStorage()?.setItem(SESSION_CUSTOM_GROUPS_STORAGE_KEY, JSON.stringify(groups));
  } catch {
    // Assigned groups still persist server-side via the session category field.
  }
}

type SessionGroupClient = Pick<SessionCapability, "list" | "patch">;

/**
 * Enumerate every session assigned to the group. The shared sidebar/page lists
 * are windowed (recent, active-only, per-agent), so group mutations must not
 * derive membership from them: `sessions.list` filters archived rows either-or,
 * hence the two unbounded queries.
 */
async function listSessionGroupMembers(
  sessions: SessionGroupClient,
  group: string,
): Promise<GatewaySessionRow[]> {
  const results = await Promise.all([
    sessions.list({ activeMinutes: 0, limit: 0 }),
    sessions.list({ activeMinutes: 0, limit: 0, showArchived: true }),
  ]);
  const members = new Map<string, GatewaySessionRow>();
  for (const result of results) {
    for (const row of result?.sessions ?? []) {
      if (row.category?.trim() === group && !members.has(row.key)) {
        members.set(row.key, row);
      }
    }
  }
  return [...members.values()];
}

function patchSessionGroupMembers(
  sessions: SessionGroupClient,
  members: readonly GatewaySessionRow[],
  category: string | null,
): Promise<unknown> {
  // allSettled: one failed patch must not abandon the rest of the group; the
  // capability already publishes patch errors to its shared state.
  return Promise.allSettled(
    members.map((row) =>
      sessions.patch(row.key, { category }, { agentId: parseAgentSessionKey(row.key)?.agentId }),
    ),
  );
}

/** Rename a group everywhere: the stored group list plus every member session. */
export async function renameSessionGroup(
  sessions: SessionGroupClient,
  from: string,
  to: string,
): Promise<void> {
  const stored = loadStoredSessionCustomGroups();
  saveStoredSessionCustomGroups([
    ...new Set(
      stored.includes(from) ? stored.map((name) => (name === from ? to : name)) : [...stored, to],
    ),
  ]);
  const members = await listSessionGroupMembers(sessions, from);
  await patchSessionGroupMembers(sessions, members, to);
}

/** Delete a group: member sessions are kept and move back to Ungrouped. */
export async function dissolveSessionGroup(
  sessions: SessionGroupClient,
  group: string,
): Promise<void> {
  saveStoredSessionCustomGroups(loadStoredSessionCustomGroups().filter((name) => name !== group));
  const members = await listSessionGroupMembers(sessions, group);
  await patchSessionGroupMembers(sessions, members, null);
}
