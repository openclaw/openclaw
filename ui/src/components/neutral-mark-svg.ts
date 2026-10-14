import { NEUTRAL_MARK as MARK } from "./neutral-mark-geometry.ts";

// Serialization is only needed by the lazy favicon presentation runtime.
export function neutralMarkSvg({ fill, glyph }: { fill: string; glyph: string }): string {
  const attribute = (value: string) =>
    value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${MARK.viewBox}" fill="none"><rect x="${MARK.inset}" y="${MARK.inset}" width="${MARK.size}" height="${MARK.size}" rx="${MARK.radius}" fill="${attribute(fill)}"/><path d="${MARK.glyph}" fill="none" stroke="${attribute(glyph)}" stroke-width="${MARK.strokeWidth}" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}
