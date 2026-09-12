import { html, nothing, type TemplateResult } from "lit";
import { t } from "../i18n/index.ts";
import "./tooltip.ts";

type SessionGlyphContent = TemplateResult | typeof nothing;

/** Run-state shape: a circle around one face, or a trace around the owner stack's pair. */
export type SessionGlyphRing = "circle" | "pair";

// Union outline of the two-identity owner stack, 2px outside its 18px faces:
// radius-11 circles at x = ±5 around the glyph center (see .session-owner-stack
// in components.css); the cusps sit at x = 0, y = ±sqrt(11² − 5²).
const PAIR_TRACE_PATH = "M0,-9.798A11,11 0 1 1 0,9.798A11,11 0 1 1 0,-9.798Z";

function renderRunRing(ring: SessionGlyphRing, queued: boolean, label: string): TemplateResult {
  if (ring === "pair") {
    return html`<svg
      class="session-glyph__trace${queued ? " session-glyph__trace--queued" : ""}"
      viewBox="-16 -11 32 22"
      role="img"
      aria-label=${label}
    >
      <path class="session-glyph__trace-track" d=${PAIR_TRACE_PATH}></path>
      <path class="session-glyph__trace-run" d=${PAIR_TRACE_PATH} pathLength="100"></path>
    </svg>`;
  }
  return html`<span
    class="session-glyph__ring${queued ? " session-glyph__ring--queued" : ""}"
    role="img"
    aria-label=${label}
  ></span>`;
}

/**
 * Persistent artwork in the sidebar's leading slot (owner avatar, page icon,
 * attention glyph). Callers can carry run state as a ring when that surface
 * owns activity in the leading slot. Circular content already fits the ring;
 * arbitrary square icons and thumbnails scale down so their corners stay
 * inside it.
 */
export function renderSessionGlyph(options: {
  content: SessionGlyphContent;
  running: boolean;
  queued?: boolean;
  runningLabel?: string;
  circular?: boolean;
  badge?: SessionGlyphContent;
  ring?: SessionGlyphRing;
}): TemplateResult {
  const {
    content,
    running,
    queued = false,
    runningLabel,
    circular = false,
    badge = nothing,
    ring = "circle",
  } = options;
  // A glyph-less row still owns its run state in the lead slot; the bare
  // modifier lets CSS draw a compact ring there instead of a 24px empty circle.
  const modifiers = `${circular ? " session-glyph--circular" : ""}${running ? " session-glyph--running" : ""}${content === nothing ? " session-glyph--bare" : ""}`;
  const glyph = html`<span class="session-glyph${modifiers}">
    <span class="session-glyph__content">${content}</span>
    ${running ? renderRunRing(ring, queued, runningLabel ?? t(queued ? "sessionsView.statusQueued" : "sessionsView.activeRun")) : nothing}
    ${badge}
  </span>`;
  return running && runningLabel
    ? html`<openclaw-tooltip .content=${runningLabel} .describe=${false}
        >${glyph}</openclaw-tooltip
      >`
    : glyph;
}

export function renderSessionUnreadBadge(): TemplateResult {
  return html`<span
    class="session-glyph__badge session-glyph__badge--unread"
    role="img"
    aria-label=${t("sessionsView.unread")}
  ></span>`;
}
