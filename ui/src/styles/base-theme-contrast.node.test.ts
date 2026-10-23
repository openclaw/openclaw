// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postcss, { type Rule } from "postcss";
import { describe, expect, it } from "vitest";
import { readThemeBlocks } from "./theme-palette.test-support.ts";

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

// #107299: palette edits dimmed --muted to 3.1–3.5:1 on dark surfaces.
const TEXT_TOKENS = "text text-strong chat-text muted muted-strong muted-foreground"
  .split(" ")
  .map((name) => `--${name}`);

const SURFACE_TOKENS = ["--bg", "--bg-elevated", "--bg-muted", "--card", "--panel"] as const;

const AA_NORMAL_TEXT_MIN = 4.5;

// Beacon promises AAA; the other themes promise AA.
const AAA_NORMAL_TEXT_MIN = 7;

// Read overrides from CSS: missing Beacon once left white on pale at 1.80:1.
const CONFIRM_BUTTON_RULE = ".chat-confirm-popover__yes";
const AAA_THEMES = new Set(["beacon", "beacon-light"]);

// --secondary matched --card and hid code chips in dark user bubbles.
const CODE_CHIP_RULE = ".chat-text :where(:not(pre, a.markdown-file-link) > code)";
const CODE_CHIP_HOST_SURFACES = ["--card", "--bg"] as const;
const CHIP_SURFACE_MIN_STEP = 1.05;
const CHIP_BORDER_MIN_STEP = 1.25;

// Missing light-mode overrides left tinted additions at 1.15:1 on --bg-muted.
const DIFF_SELECTORS = [
  ":is(.code-block, .code-block-wrapper pre code.hljs) .hljs-addition",
  ":is(.code-block, .code-block-wrapper pre code.hljs) .hljs-deletion",
] as const;
const DIFF_HOST_SURFACES = ["--bg", "--bg-muted", "--card"] as const;

// Accent-derived bubbles can swallow links; sender tints vary the failing hue.
const CHAT_LINK_RULE = ".chat-text :where(a)";
const CHAT_LINK_HOVER_RULE = ".chat-text :where(a:hover)";
const USER_BUBBLE_RULE = ".chat-group.user .chat-bubble";
const SENDER_TINT_BUBBLE_RULE =
  ".chat-group:is(.user, .chat-group--forwarded).chat-group--sender-tint .chat-bubble";
const LIGHT_USER_BUBBLE_RULE =
  ':where(:root[data-theme-mode="light"]) .chat-group.user .chat-bubble';
const LIGHT_SENDER_TINT_BUBBLE_RULE =
  ':where(:root[data-theme-mode="light"]) .chat-group.user.chat-group--sender-tint .chat-bubble';

type TokenMap = Map<string, string>;
type RGB = readonly [red: number, green: number, blue: number];
type Color = { rgb: RGB; alpha: number };

/** Compose each selectable theme the way theme.ts layers blocks over :root. */
function resolveThemes(blocks: Map<string, TokenMap>): Map<string, TokenMap> {
  const root = blocks.get(":root") ?? new Map();
  const light = blocks.get(':root:where([data-theme-mode="light"])') ?? new Map();
  const names = [
    "dark",
    "light",
    ..."openknot dash absolutely tide beacon phosphor crt manuscript rose miami"
      .split(" ")
      .flatMap((name) => [name, `${name}-light`]),
  ];
  return new Map(
    names.map((name) => [
      name,
      new Map([
        ...root,
        ...(name === "light" || name.endsWith("-light") ? light : []),
        ...(blocks.get(`:root[data-theme="${name}"]`) ?? []),
      ]),
    ]),
  );
}

function parseHex(hex: string): RGB {
  const match = required(hex.match(/^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/iu), hex);
  const channel = (index: number) => Number.parseInt(match[index] ?? "", 16);
  return [channel(1), channel(2), channel(3)];
}

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

function parseAlpha(value: string | undefined): number {
  return value ? Number.parseFloat(value) / (value.endsWith("%") ? 100 : 1) : 1;
}

function hslToRgb(hue: number, saturation: number, lightness: number): RGB {
  const normalizedHue = ((hue % 360) + 360) % 360;
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const segment = normalizedHue / 60;
  const secondary = chroma * (1 - Math.abs((segment % 2) - 1));
  const sectors: RGB[] = [
    [chroma, secondary, 0],
    [secondary, chroma, 0],
    [0, chroma, secondary],
    [0, secondary, chroma],
    [secondary, 0, chroma],
    [chroma, 0, secondary],
  ];
  const [red, green, blue] = sectors[Math.floor(segment)]!;
  const offset = lightness - chroma / 2;
  return [(red + offset) * 255, (green + offset) * 255, (blue + offset) * 255];
}

function resolveNumber(value: string, tokens: TokenMap): number {
  const variable = value.match(/^var\((--[\w-]+)\)$/u)?.[1];
  const resolved = variable ? tokens.get(variable) : value;
  if (resolved === undefined || !Number.isFinite(Number.parseFloat(resolved))) {
    throw new Error(`could not resolve numeric value "${value}"`);
  }
  return Number.parseFloat(resolved);
}

function mixColors(first: Color, firstWeight: number, second: Color): Color {
  const secondWeight = 1 - firstWeight;
  const alpha = first.alpha * firstWeight + second.alpha * secondWeight;
  if (alpha === 0) {
    return { rgb: [0, 0, 0], alpha };
  }
  // CSS color-mix weights translucent operands by their alpha too.
  const channel = (index: 0 | 1 | 2): number =>
    (first.rgb[index] * first.alpha * firstWeight +
      second.rgb[index] * second.alpha * secondWeight) /
    alpha;
  return { rgb: [channel(0), channel(1), channel(2)], alpha };
}

function resolveColor(value: string, tokens: TokenMap, resolving = new Set<string>()): Color {
  const color = value.trim();
  if (color.startsWith("#")) {
    return { rgb: parseHex(color), alpha: 1 };
  }

  const variable = color.match(/^var\((--[\w-]+)\)$/u)?.[1];
  if (variable) {
    if (resolving.has(variable)) {
      throw new Error(`circular color token "${variable}"`);
    }
    const resolved = required(tokens.get(variable), variable);
    return resolveColor(resolved, tokens, new Set(resolving).add(variable));
  }

  const rgb = color.match(
    /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+%?))?\s*\)$/u,
  );
  if (rgb) {
    return {
      rgb: [
        Number.parseFloat(rgb[1] ?? ""),
        Number.parseFloat(rgb[2] ?? ""),
        Number.parseFloat(rgb[3] ?? ""),
      ],
      alpha: parseAlpha(rgb[4]),
    };
  }

  const hsl = color.match(
    /^hsl\(\s*(var\(--[\w-]+\)|-?[\d.]+)\s+([\d.]+)%\s+([\d.]+)%(?:\s*\/\s*([\d.]+%?))?\s*\)$/u,
  );
  if (hsl) {
    return {
      rgb: hslToRgb(
        resolveNumber(hsl[1] ?? "", tokens),
        Number.parseFloat(hsl[2] ?? "") / 100,
        Number.parseFloat(hsl[3] ?? "") / 100,
      ),
      alpha: parseAlpha(hsl[4]),
    };
  }

  const mix = color.match(
    /^color-mix\(in srgb,\s*(var\(--[\w-]+\))\s+([\d.]+)%,\s*(var\(--[\w-]+\))\s*\)$/u,
  );
  if (mix) {
    return mixColors(
      resolveColor(mix[1] ?? "", tokens, resolving),
      Number.parseFloat(mix[2] ?? "") / 100,
      resolveColor(mix[3] ?? "", tokens, resolving),
    );
  }

  throw new Error(`could not resolve color "${value}"`);
}

function composite(color: Color, background: RGB): RGB {
  return [
    color.rgb[0] * color.alpha + background[0] * (1 - color.alpha),
    color.rgb[1] * color.alpha + background[1] * (1 - color.alpha),
    color.rgb[2] * color.alpha + background[2] * (1 - color.alpha),
  ];
}

function resolveOpaqueColor(value: string, tokens: TokenMap): RGB {
  const color = resolveColor(value, tokens);
  if (color.alpha !== 1) {
    throw new Error(`expected opaque color "${value}"`);
  }
  return color.rgb;
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

function readConfirmButtonPaint(rules: Rule[]) {
  type Paint = { background: string; color: string };
  let base: Paint | undefined;
  const overrides = new Map<string, Paint>();
  for (const rule of rules) {
    if (
      !/\.chat-confirm-popover__yes(?![\w-])/u.test(rule.selector) ||
      rule.selector.includes(":hover")
    ) {
      continue;
    }
    const values = declarations(rule);
    const background = readColorToken(values.get("background") ?? "");
    const color = readColorToken(values.get("color") ?? "");
    if (!background || !color) {
      continue;
    }
    const themes = [...rule.selector.matchAll(/\[data-theme="([^"]+)"\]/gu)].map((m) => m[1]!);
    if (themes.length === 0) {
      base = { background, color };
    }
    for (const theme of themes) {
      overrides.set(theme, { background, color });
    }
  }
  return { base: required(base, CONFIRM_BUTTON_RULE), overrides };
}

function readBubbleBackgrounds(rules: Rule[]) {
  const background = (selector: string) =>
    readPaint(readRule(rules, selector), "--chat-bubble-background");
  return {
    user: background(USER_BUBBLE_RULE),
    lightUser: background(LIGHT_USER_BUBBLE_RULE),
    lightUserText: readColorToken(readPaint(readRule(rules, LIGHT_USER_BUBBLE_RULE), "color")),
    senderTint: background(SENDER_TINT_BUBBLE_RULE),
    lightSenderTint: background(LIGHT_SENDER_TINT_BUBBLE_RULE),
  };
}

const themeBlocks = readThemeBlocks(stylesDir);

describe("Control UI theme contrast", () => {
  const themes = resolveThemes(themeBlocks);
  const textCss = readStyle("chat/text.css");
  const textRules = cssRules(textCss);
  const groupedRules = cssRules(readStyle("chat/grouped.css"));
  type Paint = readonly [ink: string, fill: string, minimum: number, host?: string];
  const paletteCases = (
    paints: (themeName: string, tokens: TokenMap, floor: number) => readonly Paint[],
  ) =>
    [...themes].flatMap(([themeName, tokens]) =>
      paints(
        themeName,
        tokens,
        AAA_THEMES.has(themeName) ? AAA_NORMAL_TEXT_MIN : AA_NORMAL_TEXT_MIN,
      ).map(([ink, fill, minimum, host]) => ({ themeName, tokens, ink, fill, minimum, host })),
    );
  const controls = (
    [
      ["components.css", ".btn.active", "var(--accent-subtle)"],
      [
        "settings-controls.css",
        ".settings-segmented--accent > .settings-segmented__btn--active",
        "var(--accent-subtle)",
      ],
      ["sessions.css", ".session-label-chip", null],
      ["sessions.css", ".session-kind--direct", null],
    ] as const
  ).flatMap(([filename, selector, tint]) => {
    const ink = readPaint(readRule(cssRules(readStyle(filename)), selector), "color");
    return SURFACE_TOKENS.map(
      (surface) =>
        [
          ink,
          tint ?? `var(${surface})`,
          AA_NORMAL_TEXT_MIN,
          tint ? `var(${surface})` : undefined,
        ] as const,
    );
  });
  const componentsRules = cssRules(readStyle("components.css"));
  const diffs = DIFF_SELECTORS.map((selector) => {
    const rule = readRule(componentsRules, selector);
    const foregroundToken = readColorToken(readPaint(rule, "color"));
    const tint = readPaint(rule, "background");
    return { foregroundToken, tint };
  });
  const confirmation = readConfirmButtonPaint(groupedRules);
  const bubbles = readBubbleBackgrounds(groupedRules);
  const bubblePaints = (theme: string, tokens: TokenMap) => {
    const light = theme === "light" || theme.endsWith("-light");
    const page = resolveOpaqueColor("var(--bg)", tokens);
    const user = composite(resolveColor(light ? bubbles.lightUser : bubbles.user, tokens), page);
    const tinted = (value: string) =>
      Array.from({ length: 360 }, (_, hue) =>
        composite(resolveColor(value, new Map(tokens).set("--chat-sender-hue", String(hue))), page),
      );
    return {
      page,
      user,
      light,
      sender: tinted(light ? bubbles.lightSenderTint : bubbles.senderTint),
      forwarded: () => tinted(bubbles.senderTint),
    };
  };

  const checks = {
    "native selection text: AA": paletteCases(() => [
      ["var(--selection-fg)", "var(--selection-bg)", AA_NORMAL_TEXT_MIN],
    ]),
    "native selection highlight: distinguishable from page and cards": paletteCases(() => [
      ["var(--selection-bg)", "var(--bg)", 3],
      ["var(--selection-bg)", "var(--card)", 3],
      ["var(--selection-bg)", "var(--panel)", 3],
    ]),
    "text tokens: AA on every surface, AAA where promised": paletteCases((_theme, _tokens, floor) =>
      TEXT_TOKENS.flatMap((ink) =>
        SURFACE_TOKENS.map((fill) => [`var(${ink})`, `var(${fill})`, floor] as const),
      ),
    ),
    "selected controls and session labels: AA": paletteCases(() => controls),
    "filled actions and accent glyphs": paletteCases(() => [
      ["var(--primary-foreground)", "var(--primary)", AA_NORMAL_TEXT_MIN],
      ["var(--primary-foreground)", "var(--primary-hover)", AA_NORMAL_TEXT_MIN],
      ["var(--destructive-foreground)", "var(--destructive-hover)", AA_NORMAL_TEXT_MIN],
      ["var(--accent-foreground)", "var(--accent)", 3],
    ]),
    "chat confirmation": paletteCases((themeName, tokens, floor) => {
      const paint = confirmation.overrides.get(themeName) ?? confirmation.base;
      const fill = tokens.get(paint.background);
      const ink = tokens.get(paint.color);
      return fill?.startsWith("#") && ink?.startsWith("#") ? [[ink, fill, floor]] : [];
    }),
    "highlighted diffs: AA on every code surface": paletteCases((_theme, _tokens, floor) =>
      diffs.flatMap(({ foregroundToken, tint }) =>
        DIFF_HOST_SURFACES.map(
          (surface) => [`var(${foregroundToken})`, tint, floor, `var(${surface})`] as const,
        ),
      ),
    ),
  };
  it.each(Object.entries(checks))("%s", (_name, samples) => {
    for (const { themeName, tokens, ink, fill, minimum, host } of samples) {
      const foreground = resolveOpaqueColor(ink, tokens);
      const background = host
        ? composite(resolveColor(fill, tokens), resolveOpaqueColor(host, tokens))
        : resolveOpaqueColor(fill, tokens);
      expect(
        contrastRatio(foreground, background),
        `${themeName}: ${ink} on ${fill}${host ? ` over ${host}` : ""}`,
      ).toBeGreaterThanOrEqual(minimum);
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
    const rule = readRule(textRules, CODE_CHIP_RULE);
    for (const [property, minimum] of [
      ["background", CHIP_SURFACE_MIN_STEP],
      ["border", CHIP_BORDER_MIN_STEP],
    ] as const) {
      const name = readColorToken(readPaint(rule, property));
      for (const [theme, tokens] of themes) {
        const color = tokens.get(name);
        expect(color, `${theme}: ${name} is not a hex token`).toMatch(/^#/u);
        for (const hostToken of CODE_CHIP_HOST_SURFACES) {
          const host = tokens.get(hostToken);
          if (host?.startsWith("#")) {
            expectFloor(
              contrastRatio(parseHex(color ?? ""), parseHex(host)),
              minimum,
              `${theme}/${hostToken} chip ${property}`,
            );
          }
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
    const failures: string[] = [];
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
          for (const host of hosts) {
            const background = composite(resolveColor(surface, tokens), host);
            const ink = composite(resolveColor(foreground, tokens), background);
            const ratio = contrastRatio(ink, background);
            const floor = AAA_THEMES.has(theme) ? AAA_NORMAL_TEXT_MIN : AA_NORMAL_TEXT_MIN;
            if (ratio < floor) {
              failures.push(theme + "/" + tone + ": " + ratio.toFixed(2) + " < " + floor);
            }
            const focusRatio = contrastRatio(composite(resolveColor(focus, tokens), host), host);
            if (focusRatio < 3) {
              failures.push(theme + "/focus: " + focusRatio.toFixed(2));
            }
          }
        }
      }
    }
    expect([...new Set(failures)]).toEqual([]);
  });

  it("keeps chat links at WCAG AA on every bubble surface", () => {
    const link = readColorToken(readPaint(readRule(textRules, CHAT_LINK_RULE), "color"));
    const linkTokens = {
      link,
      hover: readColorToken(readRule(textRules, CHAT_LINK_HOVER_RULE).get("color") ?? "") || link,
    };
    for (const [themeName, tokens] of themes) {
      const { light, user, sender } = bubblePaints(themeName, tokens);

      if (light) {
        expect(bubbles.lightUserText).not.toBe("");
        const foreground = resolveOpaqueColor(`var(${bubbles.lightUserText})`, tokens);
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
