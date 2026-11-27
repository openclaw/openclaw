import type { StoredClaw } from "./claw-store.js";
import { pendingUnlinkHosts } from "./unlink-operations.js";

/**
 * What any admitted client may read about the link: whether the claw is linked, its address and
 * pinned owner key (both public), and any unlink still waiting to reach Discovery. No people,
 * devices, activity or publication account; those are owner-only.
 */
export function linkSummaryOf(record: StoredClaw | undefined) {
  const state = record?.authority;
  if (!record || !state) {
    return { linked: false as const, ...pendingUnlinkHosts(record) };
  }
  return {
    linked: true as const,
    ...pendingUnlinkHosts(record),
    clawId: record.claw_id,
    hostname: record.hostname ?? undefined,
    rootPub: state.anchor.root_pub,
  };
}
