import { svg } from "lit";
export { currentThemeBranding } from "../app/theme-branding.ts";

const MARK = {
  viewBox: "0 0 120 120",
  inset: 8,
  size: 104,
  radius: 28,
  glyph: "M40 42L62 60L40 78M68 80H88",
  strokeWidth: 11,
} as const;

export const neutralMark = svg`<svg viewBox=${MARK.viewBox} width="100%" height="100%" fill="none" aria-hidden="true">
  <rect
    x=${MARK.inset}
    y=${MARK.inset}
    width=${MARK.size}
    height=${MARK.size}
    rx=${MARK.radius}
    style="fill: var(--primary); stroke: none"
  />
  <path
    d=${MARK.glyph}
    style="fill: none; stroke: var(--primary-foreground)"
    stroke-width=${MARK.strokeWidth}
    stroke-linecap="round"
    stroke-linejoin="round"
  />
</svg>`;

export function neutralMarkSvg({ fill, glyph }: { fill: string; glyph: string }): string {
  const attribute = (value: string) =>
    value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${MARK.viewBox}" fill="none"><rect x="${MARK.inset}" y="${MARK.inset}" width="${MARK.size}" height="${MARK.size}" rx="${MARK.radius}" fill="${attribute(fill)}"/><path d="${MARK.glyph}" fill="none" stroke="${attribute(glyph)}" stroke-width="${MARK.strokeWidth}" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}
