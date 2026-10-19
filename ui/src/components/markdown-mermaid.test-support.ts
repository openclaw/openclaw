import { renderMermaidSvg, type MermaidTheme } from "@openclaw/mermaid-renderer";
import { expect } from "vitest";

export const theme: MermaidTheme = {
  background: "#18181b",
  foreground: "#fafafa",
  muted: "#a1a1aa",
  border: "#52525b",
  accent: "#f97316",
  fontFamily: "Arial, sans-serif",
  darkMode: true,
};

export function parsePassiveSvg(svg: string): Element {
  const root = new DOMParser().parseFromString(svg, "image/svg+xml").documentElement;
  expect(
    root.querySelector("style,script,a,image,foreignObject,animate,set,[style],[href],[onload]"),
  ).toBeNull();
  return root;
}

export const renderSvg = async (source: string) =>
  parsePassiveSvg(await renderMermaidSvg(source, theme));
