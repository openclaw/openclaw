import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));

function relativeLuminance(hex: string): number {
  const channels = hex
    .replace("#", "")
    .match(/.{2}/g)
    ?.map((part) => Number.parseInt(part, 16) / 255)
    .map((channel) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
  if (!channels || channels.length !== 3) {
    throw new Error(`invalid color: ${hex}`);
  }
  const [r, g, b] = channels;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(foreground: string, background: string): number {
  const [lighter, darker] = [relativeLuminance(foreground), relativeLuminance(background)].toSorted(
    (a, b) => b - a,
  );
  return (lighter + 0.05) / (darker + 0.05);
}

function mixOpaque(foreground: string, background: string, opacity: number): string {
  const fh = foreground.replace("#", "");
  const bh = background.replace("#", "");
  const fr = Number.parseInt(fh.slice(0, 2), 16);
  const fg = Number.parseInt(fh.slice(2, 4), 16);
  const fb = Number.parseInt(fh.slice(4, 6), 16);
  const br = Number.parseInt(bh.slice(0, 2), 16);
  const bg = Number.parseInt(bh.slice(2, 4), 16);
  const bb = Number.parseInt(bh.slice(4, 6), 16);
  const r = Math.round(fr * opacity + br * (1 - opacity));
  const g = Math.round(fg * opacity + bg * (1 - opacity));
  const b = Math.round(fb * opacity + bb * (1 - opacity));
  return `#${[r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("")}`;
}

function readCssVarBlock(css: string, selector: string): Record<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{([\\s\\S]*?)\\n\\}`, "u"));
  if (!match?.[1]) {
    throw new Error(`missing CSS block for ${selector}`);
  }
  const vars: Record<string, string> = {};
  for (const line of match[1].matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\s*;/gu)) {
    vars[line[1]] = line[2].toLowerCase();
  }
  return vars;
}

function readRuleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, "u"));
  if (!match?.[1]) {
    throw new Error(`missing CSS rule for ${selector}`);
  }
  return match[1];
}

function readOpacity(ruleBody: string): number {
  const match = ruleBody.match(/opacity:\s*([0-9.]+)\s*;/u);
  return match ? Number.parseFloat(match[1]) : 1;
}

describe("Control UI theme contrast", () => {
  const baseCss = readFileSync(path.join(here, "base.css"), "utf8");
  const groupedCss = readFileSync(path.join(here, "chat", "grouped.css"), "utf8");
  const layoutCss = readFileSync(path.join(here, "chat", "layout.css"), "utf8");

  it("keeps default dark muted text tokens at WCAG AA on declared surfaces", () => {
    const dark = readCssVarBlock(baseCss, ":root");
    const backgrounds = [dark.bg, dark["bg-elevated"], dark["bg-muted"], dark.card];
    const foregrounds = [dark.muted, dark["muted-strong"], dark["muted-foreground"]];

    for (const foreground of foregrounds) {
      for (const background of backgrounds) {
        expect(contrastRatio(foreground, background)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it("keeps chat timestamps and slash-arg hints AA without opacity dimming", () => {
    const dark = readCssVarBlock(baseCss, ":root");
    const timestampRule = readRuleBody(groupedCss, ".chat-group-timestamp");
    const slashArgsRule = readRuleBody(layoutCss, ".slash-menu-args");

    expect(timestampRule).toMatch(/color:\s*var\(--muted\)/);
    expect(slashArgsRule).toMatch(/color:\s*var\(--muted\)/);

    const timestampOpacity = readOpacity(timestampRule);
    const slashArgsOpacity = readOpacity(slashArgsRule);
    expect(timestampOpacity).toBe(1);
    expect(slashArgsOpacity).toBe(1);

    for (const background of [dark.bg, dark["bg-elevated"], dark["bg-muted"], dark.card]) {
      const timestampFg = mixOpaque(dark.muted, background, timestampOpacity);
      const slashArgsFg = mixOpaque(dark.muted, background, slashArgsOpacity);
      expect(contrastRatio(timestampFg, background)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(slashArgsFg, background)).toBeGreaterThanOrEqual(4.5);
    }
  });
});
