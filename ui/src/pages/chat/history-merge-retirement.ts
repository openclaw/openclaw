import { readPairingQrContent } from "../../lib/chat/pairing-qr.ts";
import {
  getChatSessionProjection,
  publishChatSessionProjection,
  type ChatSessionProjectionOwner,
} from "./history-merge.ts";
import { isSupersededLiveProjection } from "./terminal-message-identity.ts";

/**
 * Retire pane entries whose run's authoritative terminal is already in history.
 * Ownership stays with the projection owner: the reduction that republishes the
 * snapshot must not retain the retired live rows, so clear them through the
 * projection owner before the snapshot lands (#149153).
 */
export function retireSupersededLiveProjections(
  owner: ChatSessionProjectionOwner,
  appliedRunIds: ReadonlySet<string>,
): void {
  // The caller passes the effective set from the same apply pass that filtered
  // history: retirement and the history filter must read one consistent
  // snapshot, so a fenced run's newer reply survives both (#149153).
  if (appliedRunIds.size === 0) {
    return;
  }
  const projection = getChatSessionProjection(owner);
  const entries = projection.entries.filter(
    (entry) =>
      // Pairing-QR live rows stay under the QR owner's retention, mirroring
      // the gateway's hasPairingQr exemption (#149153).
      readPairingQrContent(entry.message).length > 0 ||
      !isSupersededLiveProjection(entry.message, appliedRunIds),
  );
  // A retained snapshot can resurrect a run's inferred terminal; drop the
  // inference so later reloads cannot reinsert the retired row. Pairing-QR
  // carriers keep their inference: the QR owner relies on it to survive
  // refreshes (#149153).
  const runs = { ...projection.runs };
  let runsChanged = false;
  for (const runId of appliedRunIds) {
    const run = runs[runId];
    const inferred = run?.inferredSnapshotTerminal;
    if (inferred && readPairingQrContent(inferred.entry.message).length === 0) {
      const { inferredSnapshotTerminal: _cleared, ...rest } = run;
      runs[runId] = rest;
      runsChanged = true;
    }
  }
  if (entries.length === projection.entries.length && !runsChanged) {
    return;
  }
  publishChatSessionProjection(owner, {
    ...projection,
    entries,
    messages: entries.map((entry) => entry.message),
    runs,
  });
}
