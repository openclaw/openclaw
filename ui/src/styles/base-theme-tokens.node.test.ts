// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const stylesDir = path.dirname(fileURLToPath(import.meta.url));
const uiSrcDir = path.dirname(stylesDir);
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

function collectFiles(directory: string, extensions: readonly string[]): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "node_modules" ? [] : collectFiles(entryPath, extensions);
    }
    return entry.isFile() && extensions.some((extension) => entry.name.endsWith(extension))
      ? [entryPath]
      : [];
  });
}

describe("Control UI base theme tokens", () => {
  it("defines every canonical replacement", () => {
    const baseCss = fs.readFileSync(path.join(stylesDir, "base.css"), "utf8");

    for (const token of new Set(Object.values(undefinedTokenMappings))) {
      expect(baseCss, `missing --${token} in base.css`).toMatch(
        new RegExp(`^\\s*--${token}\\s*:`, "mu"),
      );
    }
  });

  it("does not reference undefined theme token names", () => {
    const referencePattern = new RegExp(
      `var\\(--(?:${Object.keys(undefinedTokenMappings).join("|")})(?:\\s*\\)|\\s*,)`,
      "u",
    );
    // Include inline styles and CSS templates, not just stylesheets.
    const violations = collectFiles(uiSrcDir, [".css", ".ts"])
      .filter((filePath) => !filePath.endsWith(".test.ts"))
      .filter((filePath) =>
        fs
          .readFileSync(filePath, "utf8")
          .split("\n")
          .some((line) => referencePattern.test(line)),
      )
      .map((filePath) => path.relative(uiSrcDir, filePath));

    expect(violations).toEqual([]);
  });
});

// Absolutely palette edits left both --bg mirrors stale. Pre-paint needs a color
// before CSS loads; preview chips must remain independent of the active theme.
describe("Control UI theme --bg mirrors", () => {
  function readCanonicalBackgrounds(): Map<string, string> {
    const themesDir = path.join(stylesDir, "..", "..", "public", "themes");
    const baseCss = [
      fs.readFileSync(path.join(stylesDir, "base.css"), "utf8"),
      ...fs
        .readdirSync(themesDir)
        .filter((entry) => entry.endsWith(".css"))
        .toSorted()
        .map((entry) => fs.readFileSync(path.join(themesDir, entry), "utf8")),
    ].join("\n");
    const selectors = [
      ["dark", ":root"],
      ["light", ':root:where([data-theme-mode="light"])'],
      ...Array.from(
        baseCss.matchAll(/:root\[data-theme="([^"]+)"\]\s*\{/gu),
        (match) => [match[1] ?? "", `:root[data-theme="${match[1] ?? ""}"]`] as const,
      ),
    ] as const;
    const backgrounds = new Map<string, string>();
    for (const [resolved, selector] of selectors) {
      const escaped = selector.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
      const body = baseCss.split(new RegExp(`${escaped}\\s*\\{`, "u"))[1]?.split("}")[0];
      const value = body?.match(/--bg:\s*([^;]+);/u)?.[1]?.trim();
      if (value) {
        backgrounds.set(resolved, value);
      }
    }
    return backgrounds;
  }

  it("keeps the index.html pre-paint background on every theme's --bg", () => {
    const indexHtml = fs.readFileSync(path.join(uiSrcDir, "..", "index.html"), "utf8");
    const canonical = readCanonicalBackgrounds();

    // Bare `html` is the default dark paint; the -mode selector is light.
    const prePaint = new Map(
      Array.from(
        indexHtml.matchAll(
          /html(?:\[data-theme(?:-mode)?="([^"]+)"\])?\s*\{\s*background:\s*([^;]+);/gu,
        ),
        (match) => [match[1] ?? "dark", (match[2] ?? "").trim()],
      ),
    );

    for (const [resolved, background] of canonical) {
      expect(prePaint.get(resolved)?.toLowerCase(), `${resolved}: pre-paint background`).toBe(
        background.toLowerCase(),
      );
    }

    expect(canonical.size).toBeGreaterThanOrEqual(2);
  });

  it("keeps the Appearance preview chips on every theme's --bg", () => {
    const configCss = fs.readFileSync(path.join(stylesDir, "config.css"), "utf8");
    const canonical = readCanonicalBackgrounds();
    let checked = 0;

    for (const match of configCss.matchAll(/\.settings-theme-card--([\w-]+)[^{]*\{([^}]*)\}/gu)) {
      const chip = match[2]?.match(/--theme-chip-bg:\s*([^;]+);/u)?.[1]?.trim();
      if (!chip || chip.startsWith("var(")) {
        continue;
      }
      // The preceding selector determines whether the chip is light-mode.
      const isLight = configCss
        .slice(0, match.index ?? 0)
        .split(".settings-theme-card--")
        .at(-1)
        ?.includes('data-theme-mode="light"');
      const family = match[1] === "knot" ? "openknot" : (match[1] ?? "");
      const resolved =
        family === "claw" ? (isLight ? "light" : "dark") : `${family}${isLight ? "-light" : ""}`;
      const background = canonical.get(resolved);
      if (!background) {
        continue;
      }
      checked += 1;
      expect(chip.toLowerCase(), `${resolved}: chip background`).toBe(background.toLowerCase());
    }

    expect(checked).toBeGreaterThan(0);
  });
});
