// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postcss, { type Rule } from "postcss";
import { describe, expect, it } from "vitest";
import { hexToOklch, prepareParticipantPalette } from "../lib/chat/participant-colors.ts";
import {
  readThemeBlocks,
  resolveThemes,
  resolveColor,
  resolveOpaqueColor,
  type TokenMap,
  type RGB,
  type Color,
} from "./theme-palette.test-support.ts";

const stylesDir = path.dirname(fileURLToPath(import.meta.url));
const readStyle = (name: string) => fs.readFileSync(path.join(stylesDir, name), "utf8");
const expectFloor = (ratio: number, minimum: number, label: string) =>
  expect(ratio, label).toBeGreaterThanOrEqual(minimum);
function required<T>(value: T | null | undefined, label: string): T {
  if (!value) {
    throw new Error(`could not resolve ${label}`);
  }
  return value;
}

// Beacon promises AAA; the other themes promise AA.
const AAA_THEMES = new Set(["beacon", "beacon-light"]);
const AA_NORMAL_TEXT_MIN = 4.5;
const contrastFloor = (theme: string) => (AAA_THEMES.has(theme) ? 7 : AA_NORMAL_TEXT_MIN);
const USER_CODE_INKS = [
  "--text",
  "--hljs-comment",
  "--hljs-link",
  "--hljs-keyword",
  "--hljs-number",
  "--hljs-string",
  "--hljs-title",
  "--hljs-type",
  "--hljs-attribute",
  "--hljs-meta",
  "--hljs-deletion",
  "--hljs-addition",
] as const;
const SURFACE_TOKENS = ["--bg", "--bg-elevated", "--bg-muted", "--card", "--panel"] as const;

function relativeLuminance(rgb: RGB): number {
  const [red, green, blue] = rgb.map((value) => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (red ?? 0) + 0.7152 * (green ?? 0) + 0.0722 * (blue ?? 0);
}

function contrastRatio(foreground: RGB, background: RGB): number {
  const a = relativeLuminance(foreground),
    b = relativeLuminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function composite(color: Color, background: RGB): RGB {
  return [
    color.rgb[0] * color.alpha + background[0] * (1 - color.alpha),
    color.rgb[1] * color.alpha + background[1] * (1 - color.alpha),
    color.rgb[2] * color.alpha + background[2] * (1 - color.alpha),
  ];
}

function oklchStyleToRgb(style: string): RGB {
  const [, l = "0", c = "0", h = "0"] = style.match(/surface: oklch\((\S+) (\S+) (\S+)\)/u) ?? [];
  const a = Number(c) * Math.cos((Number(h) * Math.PI) / 180);
  const b = Number(c) * Math.sin((Number(h) * Math.PI) / 180);
  const ll = (Number(l) + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const mm = (Number(l) - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const ss = (Number(l) - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const gamma = (value: number) =>
    255 * (value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055);
  return [
    gamma(4.0767416621 * ll - 3.3077115913 * mm + 0.2309699292 * ss),
    gamma(-1.2684380046 * ll + 2.6097574011 * mm - 0.3413193965 * ss),
    gamma(-0.0041960863 * ll - 0.7034186147 * mm + 1.707614701 * ss),
  ];
}

function cssRules(css: string): Rule[] {
  const rules: Rule[] = [];
  postcss.parse(css).walkRules((rule) => {
    rules.push(rule);
  });
  return rules;
}

const declarations = (rule: Rule) =>
  new Map(rule.nodes.filter((node) => node.type === "decl").map((node) => [node.prop, node.value]));
function readRule(rules: Rule[], selector: string) {
  return declarations(
    required(
      rules.find((rule) => rule.selectors.includes(selector)),
      selector,
    ),
  );
}
const readPaint = (rule: Map<string, string>, property: string) =>
  required(rule.get(property), property);
const readColorToken = (value: string) => value.match(/var\((--[\w-]+)\)/u)?.[1] ?? "";

const themeBlocks = readThemeBlocks(stylesDir);

describe("Control UI theme contrast", () => {
  const themes = resolveThemes(themeBlocks);
  const textCss = readStyle("chat/text.css");
  const textRules = cssRules(textCss);
  const groupedRules = cssRules(readStyle("chat/grouped.css"));
  type Paint = readonly [ink: string, fill: string, minimum: number, host?: string];
  const onSurfaces = (
    ink: string,
    surfaces: readonly string[],
    floor: number,
    tint?: string,
  ): Paint[] =>
    surfaces.map((surface) => [
      ink,
      tint ?? `var(${surface})`,
      floor,
      tint ? `var(${surface})` : undefined,
    ]);
  const controls = (
    [
      ["components.css", ".btn.active", "var(--accent-subtle)"],
      [
        "settings-controls.css",
        ".settings-segmented--accent > .settings-segmented__btn--active",
        "var(--accent-subtle)",
      ],
      ["sessions.css", ".session-label-chip"],
      ["sessions.css", ".session-kind--direct"],
    ] satisfies [string, string, string?][]
  ).flatMap(([file, selector, tint]) =>
    onSurfaces(
      readPaint(readRule(cssRules(readStyle(file)), selector), "color"),
      SURFACE_TOKENS,
      4.5,
      tint,
    ),
  );
  const componentsRules = cssRules(readStyle("components.css"));
  const diffs = ["addition", "deletion"].map((kind) => {
    const rule = readRule(componentsRules, `.hljs-${kind}`);
    return rule;
  });
  // #160568 retired per-theme confirmation overrides in favor of paired action tokens.
  const confirmation = readRule(
    groupedRules.filter((rule) => rule.selector === ".chat-confirm-popover__yes"),
    ".chat-confirm-popover__yes",
  );

  const checks = {
    "native selection text: AA": () => [
      ["var(--selection-fg)", "var(--selection-bg)", AA_NORMAL_TEXT_MIN],
    ],
    "native selection highlight: distinguishable from page and cards": () => [
      ["var(--selection-bg)", "var(--bg)", 3],
      ["var(--selection-bg)", "var(--card)", 3],
      ["var(--selection-bg)", "var(--panel)", 3],
    ],
    "text tokens: AA on every surface, AAA where promised": (_theme, _tokens, floor) =>
      // #107299: palette edits dimmed --muted to 3.1–3.5:1 on dark surfaces.
      "text text-strong chat-text muted muted-strong muted-foreground"
        .split(" ")
        .flatMap((ink) => onSurfaces(`var(--${ink})`, SURFACE_TOKENS, floor)),
    "links on reading surfaces: AA": () =>
      ["--link", "--link-hover"].flatMap((ink) =>
        onSurfaces(`var(${ink})`, ["--bg-content", ...SURFACE_TOKENS], AA_NORMAL_TEXT_MIN),
      ),
    "selected controls and session labels: AA": () => controls,
    "filled actions and accent glyphs": () => [
      ["var(--primary-foreground)", "var(--primary)", AA_NORMAL_TEXT_MIN],
      ["var(--primary-foreground)", "var(--primary-hover)", AA_NORMAL_TEXT_MIN],
      ["var(--destructive-foreground)", "var(--destructive-hover)", AA_NORMAL_TEXT_MIN],
      ["var(--accent-foreground)", "var(--accent)", 3],
      [
        "var(--chat-send-foreground, var(--primary-foreground))",
        "var(--chat-send-hover-bg, color-mix(in srgb, var(--primary) 86%, var(--text-strong)))",
        3,
      ],
    ],
    "chat confirmation": (_themeName, tokens, floor) => {
      const fill = tokens.get(readColorToken(readPaint(confirmation, "background")));
      const ink = tokens.get(readColorToken(readPaint(confirmation, "color")));
      return fill?.startsWith("#") && ink?.startsWith("#") ? [[ink, fill, floor]] : [];
    },
    "highlighted diffs: AA on every code surface": (_theme, _tokens, floor) =>
      diffs.flatMap((rule) =>
        onSurfaces(
          readPaint(rule, "color"),
          ["--bg", "--bg-muted", "--card"],
          floor,
          readPaint(rule, "background"),
        ),
      ),
  } satisfies Record<string, (theme: string, tokens: TokenMap, floor: number) => readonly Paint[]>;
  it.each(Object.entries(checks))("%s", (_name, samples) => {
    for (const [themeName, tokens] of themes) {
      for (const [ink, fill, minimum, host] of samples(
        themeName,
        tokens,
        contrastFloor(themeName),
      )) {
        const foreground = resolveOpaqueColor(ink, tokens);
        const background = host
          ? composite(resolveColor(fill, tokens), resolveOpaqueColor(host, tokens))
          : resolveOpaqueColor(fill, tokens);
        expect(
          contrastRatio(foreground, background),
          `${themeName}: ${ink} on ${fill}${host ? ` over ${host}` : ""}`,
        ).toBeGreaterThanOrEqual(minimum);
      }
    }
  });

  it("keeps user code block syntax colors at AA over every sender bubble", () => {
    const toHex = (rgb: RGB) =>
      `#${rgb.map((value) => Math.round(value).toString(16).padStart(2, "0")).join("")}`;
    const hues = [null, ...Array.from({ length: 24 }, (_, index) => index * 15)];
    for (const [theme, tokens] of themes) {
      const light = theme === "light" || theme.endsWith("-light");
      const panel = resolveColor("var(--user-code-bg)", tokens);
      const palette = prepareParticipantPalette({
        mode: light ? "light" : "dark",
        background: hexToOklch(toHex(resolveOpaqueColor("var(--bg-content)", tokens))),
        accent: hexToOklch(toHex(resolveOpaqueColor("var(--accent)", tokens))),
        viewerTone: ["dark", "beacon", "rose", "miami"].includes(theme)
          ? { l: 0.34, c: 0.07 }
          : undefined,
      });
      for (const hue of hues) {
        const bubble = oklchStyleToRgb(palette.style(hue));
        const surface = composite(panel, bubble);
        for (const ink of USER_CODE_INKS) {
          const tint = { "--hljs-deletion": "--danger-subtle", "--hljs-addition": "--ok-subtle" }[
            ink as string
          ];
          expectFloor(
            contrastRatio(
              resolveOpaqueColor(`var(${ink})`, tokens),
              tint ? composite(resolveColor(`var(${tint})`, tokens), surface) : surface,
            ),
            AA_NORMAL_TEXT_MIN,
            `${theme}: ${ink} over sender hue ${hue}`,
          );
        }
      }
    }
  });

  it("preserves imported fill/ink contrast when no hover pair is supplied", () => {
    const defaults = themeBlocks.get(":root") ?? new Map<string, string>();
    for (const text of ["#fafafa", "#211e1a"]) {
      for (const [primary, destructive, foreground] of [
        ["#d92a3f", "#d32f2f", "#fafafa"],
        ["#ffc233", "#ffabab", "#000000"],
      ] as const) {
        const imported = new Map(defaults);
        imported.set("--text", text);
        imported.set("--primary", primary);
        imported.set("--primary-foreground", foreground);
        imported.set("--destructive", destructive);
        imported.set("--destructive-foreground", foreground);
        for (const fill of ["--primary", "--destructive"]) {
          const ink = resolveOpaqueColor(`var(${fill}-foreground)`, imported);
          const rest = contrastRatio(ink, resolveOpaqueColor(`var(${fill})`, imported));
          const hover = contrastRatio(ink, resolveOpaqueColor(`var(${fill}-hover)`, imported));
          expect(rest).toBeGreaterThanOrEqual(AA_NORMAL_TEXT_MIN);
          expectFloor(hover, rest, `${fill} hover must preserve imported contrast`);
        }
      }
    }
  });

  it("keeps the markdown code chip separated from every surface it sits on", () => {
    // --secondary matched --card and hid code chips in dark user bubbles.
    const rule = readRule(textRules, ".chat-text :where(:not(pre, a.markdown-file-link) > code)");
    for (const [property, minimum] of [
      ["background", 1.05],
      ["border", 1.25],
    ] as const) {
      const paint = required(readPaint(rule, property).match(/var\(.+\)/u)?.[0], property);
      for (const [theme, tokens] of themes) {
        const color = resolveColor(paint, tokens);
        for (const hostToken of ["--card", "--bg"]) {
          const host = resolveOpaqueColor(`var(${hostToken})`, tokens);
          expectFloor(
            contrastRatio(composite(color, host), host),
            minimum,
            `${theme}/${hostToken} chip ${property}`,
          );
        }
      }
    }
  });

  it("keeps GitHub item surfaces neutral and ink and focus legible across themes", () => {
    const selector = ".chat-text a.markdown-github-item";
    const base = readRule(textRules, selector);
    const foreground = readPaint(base, "color");
    const surfaces = [
      readPaint(base, "background"),
      readPaint(readRule(textRules, selector + ":focus-visible"), "background"),
    ];
    const focus = required(
      textCss.match(/a\.markdown-github-item:focus-visible\s*\{\s*outline-color:\s*([^;]+);/u)?.[1],
      "GitHub chip focus paint",
    );
    for (const [theme, palette] of themes) {
      const hosts = [resolveOpaqueColor("var(--bg-content)", palette)];
      const neutralTokens = new Map(palette).set(
        "--github-item-tone",
        readPaint(base, "--github-item-tone"),
      );
      for (const tone of ["unknown", "neutral", "positive", "negative", "accent", "attention"]) {
        const rule =
          tone === "unknown" || tone === "neutral"
            ? base
            : readRule(textRules, selector + '[data-link-reader-tone="' + tone + '"]');
        const tokens = new Map(palette).set(
          "--github-item-tone",
          readPaint(rule, "--github-item-tone"),
        );
        for (const surface of surfaces) {
          const fill = resolveColor(surface, tokens);
          expect(fill, `${theme}/${tone}: chip fill is opaque and independent of status`).toEqual({
            ...resolveColor(surface, neutralTokens),
            alpha: 1,
          });
          // The opacity assertion makes every underlying host equivalent for chip ink.
          const ink = composite(resolveColor(foreground, tokens), fill.rgb);
          expectFloor(contrastRatio(ink, fill.rgb), contrastFloor(theme), `${theme}/${tone}`);
        }
        const focusColor = resolveColor(focus, tokens);
        expectFloor(
          Math.min(...hosts.map((host) => contrastRatio(composite(focusColor, host), host))),
          3,
          `${theme}/${tone}/focus`,
        );
      }
    }
  });
});
