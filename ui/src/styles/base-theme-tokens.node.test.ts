// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postcss, { type AnyNode } from "postcss";
import { describe, expect, it } from "vitest";
import {
  readThemeBlocks,
  resolveThemes,
  resolveOpaqueColor,
} from "./theme-palette.test-support.ts";

const stylesDir = path.dirname(fileURLToPath(import.meta.url));
const readStyle = (name: string) => fs.readFileSync(path.join(stylesDir, name), "utf8");
const themeBlocks = readThemeBlocks(stylesDir);

// Undefined aliases silently drop declarations or invalidate color-mix.
const undefinedTokenMappings = {
  "bg-subtle": "bg-muted",
  "border-subtle": "border",
  fg: "text",
  "font-mono": "mono",
  "font-sans": "font-body",
  foreground: "text",
  "panel-2": "panel-strong",
  success: "ok",
  surface: "panel",
  "text-muted": "muted",
  warning: "warn",
  "warning-subtle": "warn-subtle",
} as const;

function collectStyleSources(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "node_modules" ? [] : collectStyleSources(file);
    }
    return entry.isFile() && /\.(css|ts)$/u.test(entry.name) && !entry.name.endsWith(".test.ts")
      ? [file]
      : [];
  });
}

describe("Control UI base theme tokens", () => {
  it("defines every canonical replacement", () => {
    for (const token of new Set(Object.values(undefinedTokenMappings))) {
      expect(readStyle("base.css"), `missing --${token} in base.css`).toMatch(
        new RegExp(`^\\s*--${token}\\s*:`, "mu"),
      );
    }
  });

  it("does not reference undefined theme token names", () => {
    const pattern = new RegExp(
      `var\\(--(?:${Object.keys(undefinedTokenMappings).join("|")})(?:\\s*\\)|\\s*,)`,
      "u",
    );
    const root = path.dirname(stylesDir);
    expect(
      collectStyleSources(root)
        .filter((file) => pattern.test(fs.readFileSync(file, "utf8")))
        .map((file) => path.relative(root, file)),
    ).toEqual([]);
  });
});

// Absolutely palette edits left both mirrors stale: pre-paint and preview chips
// need each palette's own --bg, independent of the active theme.
describe("Control UI theme --bg mirrors", () => {
  const themes = resolveThemes(themeBlocks);
  const canonical = new Map(
    [...themes].map(([name, tokens]) => [
      name,
      resolveOpaqueColor("var(--bg)", tokens).map(Math.round),
    ]),
  );

  it("keeps the index.html pre-paint background on every theme's --bg", () => {
    const html = fs.readFileSync(path.join(stylesDir, "..", "..", "index.html"), "utf8");
    const prePaint = new Map(
      Array.from(
        html.matchAll(
          /html(?:\[data-theme(?:-mode)?="([^"]+)"\])?\s*\{\s*background:\s*([^;]+);/gu,
        ),
        (match) => [match[1] ?? "dark", (match[2] ?? "").trim().toLowerCase()],
      ),
    );
    for (const [name, bg] of canonical) {
      expect(
        resolveOpaqueColor(prePaint.get(name) ?? "", themes.get(name)!).map(Math.round),
        `${name}: pre-paint background`,
      ).toEqual(bg);
    }
    expect(canonical.size).toBeGreaterThanOrEqual(2);
  });

  it("keeps the Appearance preview chips on every theme's --bg", () => {
    const css = postcss.parse(readStyle("config.css"));
    let checked = 0;
    css.walkRules((rule) => {
      const match = rule.selector.match(/\.settings-theme-card--([\w-]+)/u);
      const declaration = rule.nodes.find(
        (node) => node.type === "decl" && node.prop === "--theme-chip-bg",
      );
      if (!match || declaration?.type !== "decl") {
        return;
      }
      const chip = declaration.value.trim();
      if (chip.startsWith("var(")) {
        return;
      }
      let light = rule.selector.includes('data-theme-mode="light"');
      for (let parent: AnyNode | undefined = rule.parent; parent; parent = parent.parent) {
        if (parent.type === "rule" && parent.selector.includes('data-theme-mode="light"')) {
          light = true;
        }
      }
      const family = match[1] === "knot" ? "openknot" : (match[1] ?? "");
      const name =
        family === "claw" ? (light ? "light" : "dark") : `${family}${light ? "-light" : ""}`;
      const bg = canonical.get(name);
      if (!bg) {
        return;
      }
      checked += 1;
      expect(
        resolveOpaqueColor(chip, themes.get(name)!).map(Math.round),
        `${name}: chip background`,
      ).toEqual(bg);
    });
    expect(checked).toBeGreaterThan(0);
  });
});
