// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postcss, { type Rule } from "postcss";
import { describe, expect, it } from "vitest";
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
    const rule = readRule(
      componentsRules,
      `:is(.code-block, .code-block-wrapper pre code.hljs) .hljs-${kind}`,
    );
    return rule;
  });
  // #160568 retired per-theme confirmation overrides in favor of paired action tokens.
  const confirmation = readRule(
    groupedRules.filter((rule) => rule.selector === ".chat-confirm-popover__yes"),
    ".chat-confirm-popover__yes",
  );
  const bubblePaints = (theme: string, tokens: TokenMap) => {
    const light = theme === "light" || theme.endsWith("-light");
    const page = resolveOpaqueColor("var(--bg)", tokens);
    const lightRoot = ':where(:root[data-theme-mode="light"]) ';
    const lightUser = lightRoot + ".chat-group.user .chat-bubble";
    const sender =
      ".chat-group:is(.user, .chat-group--forwarded).chat-group--sender-tint .chat-bubble";
    const paint = (selector: string, property = "--chat-bubble-background") =>
      readPaint(readRule(groupedRules, selector), property);
    const background = (selector: string, palette = tokens) =>
      composite(resolveColor(paint(selector), palette), page);
    const tinted = (selector: string) => {
      const value = paint(selector);
      return Array.from({ length: 360 }, (_, hue) =>
        composite(resolveColor(value, new Map(tokens).set("--chat-sender-hue", String(hue))), page),
      );
    };
    return {
      page,
      light,
      user: background(".chat-group.user .chat-bubble"),
      lightUserText: paint(lightUser, "color"),
      sender: tinted(
        light ? lightRoot + ".chat-group.user.chat-group--sender-tint .chat-bubble" : sender,
      ),
      forwarded: () => tinted(sender),
    };
  };

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

  it("keeps GitHub item surfaces neutral and ink and focus legible across themes and bubbles", () => {
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
      const { page, user, sender, forwarded } = bubblePaints(theme, palette);
      const hosts = [page, user, ...sender, ...forwarded()];
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

  it("keeps chat links at WCAG AA on every bubble surface", () => {
    const link = readColorToken(readPaint(readRule(textRules, ".chat-text :where(a)"), "color"));
    const linkTokens = {
      link,
      hover:
        readColorToken(readRule(textRules, ".chat-text :where(a:hover)").get("color") ?? "") ||
        link,
    };
    for (const [themeName, tokens] of themes) {
      const { light, user, sender, lightUserText } = bubblePaints(themeName, tokens);

      if (light) {
        const foreground = resolveOpaqueColor(lightUserText, tokens);
        expectFloor(contrastRatio(foreground, user), AA_NORMAL_TEXT_MIN, `${themeName}: user text`);
      }

      for (const [state, token] of [
        ["link", linkTokens.link],
        ["link hover", linkTokens.hover],
      ] as const) {
        const foreground = resolveColor(`var(${token})`, tokens);
        const ratioOn = (background: RGB) =>
          contrastRatio(composite(foreground, background), background);
        expectFloor(ratioOn(user), AA_NORMAL_TEXT_MIN, `${themeName}: ${state} on user bubble`);
        expectFloor(
          Math.min(...sender.map(ratioOn)),
          AA_NORMAL_TEXT_MIN,
          `${themeName}: ${state} on sender tints`,
        );
      }
    }
  });
});
