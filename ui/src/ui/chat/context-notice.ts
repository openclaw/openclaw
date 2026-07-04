// Control UI chat module implements context notice behavior.
import { html, nothing } from "lit";
import { icons } from "../icons.ts";
import type { GatewaySessionRow } from "../types.ts";
import { formatCompactTokenCount } from "./token-format.ts";

const CONTEXT_NOTICE_RATIO = 0.85;
const CONTEXT_COMPACT_RATIO = 0.9;

export type ContextNoticeOptions = {
  compactBusy?: boolean;
  compactDisabled?: boolean;
  onCompact?: () => void | Promise<void>;
};

/** Parse a 6-digit CSS hex color string to [r, g, b] integer components. */
function parseHexRgb(hex: string): [number, number, number] | null {
  const h = hex.trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(h)) {
    return null;
  }
  return [
    Number.parseInt(h.slice(0, 2), 16),
    Number.parseInt(h.slice(2, 4), 16),
    Number.parseInt(h.slice(4, 6), 16),
  ];
}

let cachedThemeNoticeColors: {
  warnHex: string;
  dangerHex: string;
  warnRgb: [number, number, number];
  dangerRgb: [number, number, number];
} | null = null;

function getThemeNoticeColors() {
  if (cachedThemeNoticeColors) {
    return cachedThemeNoticeColors;
  }
  const rootStyle = getComputedStyle(document.documentElement);
  const warnHex = rootStyle.getPropertyValue("--warn").trim() || "#f59e0b";
  const dangerHex = rootStyle.getPropertyValue("--danger").trim() || "#ef4444";
  cachedThemeNoticeColors = {
    warnHex,
    dangerHex,
    warnRgb: parseHexRgb(warnHex) ?? [245, 158, 11],
    dangerRgb: parseHexRgb(dangerHex) ?? [239, 68, 68],
  };
  return cachedThemeNoticeColors;
}

export function resetContextNoticeThemeCacheForTest(): void {
  cachedThemeNoticeColors = null;
}

export function getContextNoticeViewModel(
  session: GatewaySessionRow | undefined,
  defaultContextTokens: number | null,
): {
  pct: number;
  detail: string;
  color: string;
  bg: string;
  warning: boolean;
  compactRecommended: boolean;
} | null {
  if (session?.totalTokensFresh === false) {
    return null;
  }
  const used = session?.totalTokens;
  const limit = session?.contextTokens ?? defaultContextTokens ?? 0;
  if (typeof used !== "number" || !Number.isFinite(used) || used < 0 || !limit) {
    return null;
  }
  const ratio = used / limit;
  const pct = Math.min(Math.round(ratio * 100), 100);
  const warning = ratio >= CONTEXT_NOTICE_RATIO;
  if (!warning) {
    return {
      pct,
      detail: `${formatCompactTokenCount(used)} / ${formatCompactTokenCount(limit)}`,
      color: "var(--muted)",
      bg: "color-mix(in srgb, var(--muted) 8%, transparent)",
      warning,
      compactRecommended: false,
    };
  }
  // Read theme semantic tokens so color tracks the active theme (Dash, dark, light ...).
  const { warnRgb, dangerRgb } = getThemeNoticeColors();
  const [wr, wg, wb] = warnRgb;
  const [dr, dg, db] = dangerRgb;
  const t = Math.min(Math.max((ratio - 0.85) / 0.1, 0), 1);
  const r = Math.round(wr + (dr - wr) * t);
  const g = Math.round(wg + (dg - wg) * t);
  const b = Math.round(wb + (db - wb) * t);
  const color = `rgb(${r}, ${g}, ${b})`;
  const bgOpacity = 0.08 + 0.08 * t;
  const bg = `rgba(${r}, ${g}, ${b}, ${bgOpacity})`;
  return {
    pct,
    detail: `${formatCompactTokenCount(used)} / ${formatCompactTokenCount(limit)}`,
    color,
    bg,
    warning,
    compactRecommended: ratio >= CONTEXT_COMPACT_RATIO,
  };
}

const RING_RADIUS = 6.5;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

export function renderContextNotice(
  session: GatewaySessionRow | undefined,
  defaultContextTokens: number | null,
  options: ContextNoticeOptions = {},
) {
  const model = getContextNoticeViewModel(session, defaultContextTokens);
  if (!model) {
    return nothing;
  }
  const canRenderCompact = model.compactRecommended && options.onCompact;
  const compactDisabled = options.compactDisabled === true || options.compactBusy === true;
  const summary = `Session context usage: ${model.detail} (${model.pct}%)`;
  const dashOffset = RING_CIRCUMFERENCE * (1 - model.pct / 100);
  return html`
    <div
      class="context-ring ${model.warning ? "context-ring--warning" : ""}"
      role="status"
      aria-label=${summary}
      style="--ctx-color:${model.color};--ctx-bg:${model.bg}"
      title=${summary}
    >
      <svg class="context-ring__dial" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
        <circle class="context-ring__track" cx="8" cy="8" r=${RING_RADIUS} />
        <circle
          class="context-ring__fill"
          cx="8"
          cy="8"
          r=${RING_RADIUS}
          stroke-dasharray=${RING_CIRCUMFERENCE.toFixed(2)}
          stroke-dashoffset=${dashOffset.toFixed(2)}
        />
      </svg>
      <span class="context-ring__pct">${model.pct}%</span>
      ${canRenderCompact
        ? html`
            <button
              class="context-ring__action ${options.compactBusy
                ? "context-ring__action--busy"
                : ""}"
              type="button"
              title="Compact session context"
              aria-label="Compact recommended session context"
              ?disabled=${compactDisabled}
              @click=${(event: Event) => {
                event.preventDefault();
                event.stopPropagation();
                if (compactDisabled) {
                  return;
                }
                void options.onCompact?.();
              }}
            >
              ${options.compactBusy ? icons.loader : icons.minimize}
              <span>${options.compactBusy ? "Compacting" : "Compact"}</span>
            </button>
          `
        : nothing}
    </div>
  `;
}
