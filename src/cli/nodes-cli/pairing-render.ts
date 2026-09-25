// Shared renderer for pending node pairing request tables.
import { sanitizeTerminalText } from "../../../packages/terminal-core/src/safe-text.js";
import { renderTable } from "../../../packages/terminal-core/src/table.js";
import { formatTimeAgo } from "../../infra/format-time/format-relative.ts";
import type { PendingRequest } from "./types.js";

// Bidirectional formatting controls (overrides, isolates, marks, the Arabic
// letter mark) reorder the glyphs around them, so a pairing device could name
// itself to render as a different, trusted-looking device in this approval table
// (Trojan Source, CVE-2021-42574). Strip them from the displayed cells; the
// terminal's own bidi algorithm still lays out strong-directional letters.
const PAIRING_BIDI_CONTROL_RE = new RegExp("[؜‎‏‪-‮⁦-⁩]", "gu");

function sanitizePairingCell(value: string): string {
  return sanitizeTerminalText(value).replace(PAIRING_BIDI_CONTROL_RE, "");
}

/** Render pending pairing requests with sanitized labels and relative request age. */
export function renderPendingPairingRequestsTable(params: {
  pending: PendingRequest[];
  now: number;
  tableWidth: number;
  theme: {
    heading: (text: string) => string;
    warn: (text: string) => string;
    muted: (text: string) => string;
  };
}) {
  const { pending, now, tableWidth, theme } = params;
  const rows = pending.map((r) => {
    const nodeLabel = r.displayName?.trim() ? r.displayName.trim() : r.nodeId;
    return {
      Request: sanitizePairingCell(r.requestId),
      Node: sanitizePairingCell(nodeLabel),
      IP: sanitizePairingCell(r.remoteIp ?? ""),
      Requested:
        typeof r.ts === "number" ? formatTimeAgo(Math.max(0, now - r.ts)) : theme.muted("unknown"),
    };
  });
  return {
    heading: theme.heading("Pending"),
    table: renderTable({
      width: tableWidth,
      columns: [
        { key: "Request", header: "Request", minWidth: 8 },
        { key: "Node", header: "Node", minWidth: 14, flex: true },
        { key: "IP", header: "IP", minWidth: 10 },
        { key: "Requested", header: "Requested", minWidth: 12 },
      ],
      rows,
    }).trimEnd(),
  };
}
