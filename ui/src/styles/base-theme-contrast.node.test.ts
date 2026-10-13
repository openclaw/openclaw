// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postcss, { type Rule } from "postcss";
import { describe, expect, it } from "vitest";

const stylesDir = path.dirname(fileURLToPath(import.meta.url));

// #107299: palette edits dimmed --muted to 3.1–3.5:1 on dark surfaces.
const TEXT_TOKENS = [
  "--text",
  "--text-strong",
  "--chat-text",
  "--muted",
  "--muted-strong",
  "--muted-foreground",
] as const;

const SURFACE_TOKENS = ["--bg", "--bg-elevated", "--bg-muted", "--card", "--panel"] as const;

const AA_NORMAL_TEXT_MIN = 4.5;

// Beacon promises AAA; the other themes promise AA.
const AAA_NORMAL_TEXT_MIN = 7;

// Read overrides from CSS: missing Beacon once left white on pale at 1.80:1.
const CONFIRM_BUTTON_RULE = ".chat-confirm-popover__yes";
const AAA_THEMES = new Set(["beacon", "beacon-light"]);

// --secondary matched --card and hid chips in dark user bubbles. File links
// are excluded because they use link ink rather than a chip surface.
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
// User and forwarded (cross-session) bubbles share one tint rule via :is().
const SENDER_TINT_BUBBLE_RULE =
  ".chat-group:is(.user, .chat-group--forwarded).chat-group--sender-tint .chat-bubble";
// Theme selection changes the skin token without outranking the bare image shell.
const LIGHT_USER_BUBBLE_RULE =
  ':where(:root[data-theme-mode="light"]) .chat-group.user .chat-bubble';
// Only user bubbles override the shared sender tint in light mode.
const LIGHT_SENDER_TINT_BUBBLE_RULE =
  ':where(:root[data-theme-mode="light"]) .chat-group.user.chat-group--sender-tint .chat-bubble';

type TokenMap = Map<string, string>;
type RGB = readonly [red: number, green: number, blue: number];
type Color = { rgb: RGB; alpha: number };

// Include lazy palettes as well as the startup stylesheet.
function readPaletteSources(stylesRoot: string): string {
  const themesDir = path.join(stylesRoot, "..", "..", "public", "themes");
  const palettes = fs
    .readdirSync(themesDir)
    .filter((entry) => entry.endsWith(".css"))
    .toSorted()
    .map((entry) => fs.readFileSync(path.join(themesDir, entry), "utf8"));
  return [fs.readFileSync(path.join(stylesRoot, "base.css"), "utf8"), ...palettes].join("\n");
}

function parseThemeBlocks(baseCss: string): Map<string, TokenMap> {
  const blocks = new Map<string, TokenMap>();
  const blockPattern =
    /(:root(?::where\(\[data-theme-mode="light"\]\)|\[data-theme(?:-mode)?="[^"]+"\])?)\s*\{([^}]*)\}/g;
  for (const match of baseCss.matchAll(blockPattern)) {
    const selector = match[1] ?? "";
    const body = match[2] ?? "";
    // base.css declares `:root` more than once (palette, then the standalone
    // --cursor-action blocks). Merging keeps the palette; overwriting made the
    // default `dark` theme resolve to an empty map and skip every assertion.
    const tokens: TokenMap = blocks.get(selector) ?? new Map();
    for (const line of body.split("\n")) {
      const declaration = line.match(/^\s*(--[\w-]+)\s*:\s*([^;]+);/);
      const name = declaration?.[1];
      const value = declaration?.[2];
      if (name && value) {
        tokens.set(name, value.trim());
      }
    }
    blocks.set(selector, tokens);
  }
  return blocks;
}

/** Compose each selectable theme the way theme.ts layers blocks over :root. */
function resolveThemes(blocks: Map<string, TokenMap>): Map<string, TokenMap> {
  const root = blocks.get(":root") ?? new Map();
  const light = blocks.get(':root:where([data-theme-mode="light"])') ?? new Map();
  const layer = (...overrides: (TokenMap | undefined)[]): TokenMap => {
    const merged: TokenMap = new Map(root);
    for (const override of overrides) {
      for (const [key, value] of override ?? []) {
        merged.set(key, value);
      }
    }
    return merged;
  };
  return new Map([
    ["dark", layer(blocks.get(':root[data-theme="dark"]'))],
    ["light", layer(light, blocks.get(':root[data-theme="light"]'))],
    ["openknot", layer(blocks.get(':root[data-theme="openknot"]'))],
    ["openknot-light", layer(light, blocks.get(':root[data-theme="openknot-light"]'))],
    ["dash", layer(blocks.get(':root[data-theme="dash"]'))],
    ["dash-light", layer(light, blocks.get(':root[data-theme="dash-light"]'))],
    ["absolutely", layer(blocks.get(':root[data-theme="absolutely"]'))],
    ["absolutely-light", layer(light, blocks.get(':root[data-theme="absolutely-light"]'))],
    ["tide", layer(blocks.get(':root[data-theme="tide"]'))],
    ["tide-light", layer(light, blocks.get(':root[data-theme="tide-light"]'))],
    ["beacon", layer(blocks.get(':root[data-theme="beacon"]'))],
    ["beacon-light", layer(light, blocks.get(':root[data-theme="beacon-light"]'))],
    ["phosphor", layer(blocks.get(':root[data-theme="phosphor"]'))],
    ["phosphor-light", layer(light, blocks.get(':root[data-theme="phosphor-light"]'))],
    ["crt", layer(blocks.get(':root[data-theme="crt"]'))],
    ["crt-light", layer(light, blocks.get(':root[data-theme="crt-light"]'))],
    ["manuscript", layer(blocks.get(':root[data-theme="manuscript"]'))],
    ["manuscript-light", layer(light, blocks.get(':root[data-theme="manuscript-light"]'))],
    ["rose", layer(blocks.get(':root[data-theme="rose"]'))],
    ["rose-light", layer(light, blocks.get(':root[data-theme="rose-light"]'))],
    ["miami", layer(blocks.get(':root[data-theme="miami"]'))],
    ["miami-light", layer(light, blocks.get(':root[data-theme="miami-light"]'))],
  ]);
}

function parseHex(hex: string): RGB {
  const match = hex.match(/^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/iu);
  if (!match) {
    throw new Error(`could not parse hex color "${hex}"`);
  }
  return [
    Number.parseInt(match[1] ?? "", 16),
    Number.parseInt(match[2] ?? "", 16),
    Number.parseInt(match[3] ?? "", 16),
  ];
}

function relativeLuminance(rgb: RGB): number {
  const [red, green, blue] = rgb.map((value) => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (red ?? 0) + 0.7152 * (green ?? 0) + 0.0722 * (blue ?? 0);
}

function contrastRatio(foreground: RGB, background: RGB): number {
  const [lighter = 0, darker = 0] = [
    relativeLuminance(foreground),
    relativeLuminance(background),
  ].toSorted((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

function parseAlpha(value: string | undefined): number {
  if (!value) {
    return 1;
  }
  return value.endsWith("%") ? Number.parseFloat(value) / 100 : Number.parseFloat(value);
}

function hslToRgb(hue: number, saturation: number, lightness: number): RGB {
  const normalizedHue = ((hue % 360) + 360) % 360;
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const segment = normalizedHue / 60;
  const secondary = chroma * (1 - Math.abs((segment % 2) - 1));
  const [red, green, blue]: RGB =
    segment < 1
      ? [chroma, secondary, 0]
      : segment < 2
        ? [secondary, chroma, 0]
        : segment < 3
          ? [0, chroma, secondary]
          : segment < 4
            ? [0, secondary, chroma]
            : segment < 5
              ? [secondary, 0, chroma]
              : [chroma, 0, secondary];
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
  // Premultiplied, matching CSS color-mix: a translucent operand contributes in
  // proportion to its own alpha, not just its declared weight.
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
    const resolved = tokens.get(variable);
    if (!resolved) {
      throw new Error(`could not resolve color token "${variable}"`);
    }
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

/** Read the surface/border tokens the shipped code-chip rule actually paints. */
function readCodeChipTokens(chatTextCss: string): { surface: string; border: string } {
  const rule = chatTextCss.split(CODE_CHIP_RULE)[1]?.split("}")[0] ?? "";
  const surface = rule.match(/background:\s*var\((--[\w-]+)\)/u)?.[1];
  const border = rule.match(/border:[^;]*var\((--[\w-]+)\)/u)?.[1];
  if (!surface || !border) {
    throw new Error(`could not read chip tokens from "${CODE_CHIP_RULE}"`);
  }
  return { surface, border };
}

type ConfirmButtonPaint = { background: string; color: string };

function readConfirmButtonPaint(groupedCss: string): {
  base: ConfirmButtonPaint;
  overrides: Map<string, ConfirmButtonPaint>;
} {
  const pattern = /([^{}]*\.chat-confirm-popover__yes(?![\w-])[^{}]*)\{([^}]*)\}/gu;
  let base: ConfirmButtonPaint | undefined;
  const overrides = new Map<string, ConfirmButtonPaint>();
  for (const match of groupedCss.matchAll(pattern)) {
    const selector = (match[1] ?? "").trim();
    const body = match[2] ?? "";
    if (selector.includes(":hover")) {
      continue;
    }
    const background = body.match(/background:\s*var\((--[\w-]+)\)/u)?.[1];
    const color = body.match(/color:\s*var\((--[\w-]+)\)/u)?.[1];
    if (!background || !color) {
      continue;
    }
    const themes = [...selector.matchAll(/\[data-theme="([^"]+)"\]/gu)].map((m) => m[1] ?? "");
    if (themes.length === 0) {
      base = { background, color };
      continue;
    }
    for (const theme of themes) {
      overrides.set(theme, { background, color });
    }
  }
  if (!base) {
    throw new Error(`could not read the base "${CONFIRM_BUTTON_RULE}" paint`);
  }
  return { base, overrides };
}

function readRuleBody(css: string, selector: string): string {
  const body = css.split(`${selector} {`)[1]?.split("}")[0];
  if (body === undefined) {
    throw new Error(`could not read rule "${selector}"`);
  }
  return body;
}

function readChatLinkTokens(chatTextCss: string): { link: string; hover: string } {
  const link = readRuleBody(chatTextCss, CHAT_LINK_RULE).match(/color:\s*var\((--[\w-]+)\)/u)?.[1];
  const hover = readRuleBody(chatTextCss, CHAT_LINK_HOVER_RULE).match(
    /color:\s*var\((--[\w-]+)\)/u,
  )?.[1];
  if (!link) {
    throw new Error(`could not read link token from "${CHAT_LINK_RULE}"`);
  }
  return { link, hover: hover ?? link };
}

function readBubbleBackgrounds(groupedCss: string): {
  user: string;
  lightUser: string;
  lightUserText: string;
  senderTint: string;
  lightSenderTint: string;
} {
  const rules: Rule[] = [];
  postcss.parse(groupedCss).walkRules((rule) => {
    rules.push(rule);
  });
  const readPaint = (selector: string, property: string): string => {
    // Read only this rule's declarations, including those after nested artwork treatments.
    const declaration = rules
      .find((rule) => rule.selector === selector)
      ?.nodes.filter((node) => node.type === "decl")
      .find((node) => node.prop === property);
    if (!declaration) {
      throw new Error(`could not read ${property} from "${selector}"`);
    }
    return declaration.value;
  };
  const readBackground = (selector: string) => readPaint(selector, "--chat-bubble-background");
  return {
    user: readBackground(USER_BUBBLE_RULE),
    lightUser: readBackground(LIGHT_USER_BUBBLE_RULE),
    lightUserText:
      readPaint(LIGHT_USER_BUBBLE_RULE, "color").match(/^var\((--[\w-]+)\)$/u)?.[1] ?? "",
    senderTint: readBackground(SENDER_TINT_BUBBLE_RULE),
    lightSenderTint: readBackground(LIGHT_SENDER_TINT_BUBBLE_RULE),
  };
}

describe("Control UI theme contrast", () => {
  const baseCss = readPaletteSources(stylesDir);
  const themes = resolveThemes(parseThemeBlocks(baseCss));
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
    const rule = readRuleBody(fs.readFileSync(path.join(stylesDir, filename), "utf8"), selector);
    const ink = rule.match(/(?:^|;)\s*color:\s*([^;]+);/u)?.[1];
    if (!ink) {
      throw new Error(`could not read text color from "${selector}"`);
    }
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
  const componentsCss = fs.readFileSync(path.join(stylesDir, "components.css"), "utf8");
  const diffs = DIFF_SELECTORS.map((selector) => {
    const rule = readRuleBody(componentsCss, selector);
    const foregroundToken = rule.match(/color:\s*var\((--[\w-]+)\)/u)?.[1];
    const tint = rule.match(/background:\s*([^;]+);/u)?.[1];
    if (!foregroundToken || !tint) {
      throw new Error(`could not read diff colors from "${selector}"`);
    }
    return { foregroundToken, tint };
  });
  const confirmation = readConfirmButtonPaint(
    fs.readFileSync(path.join(stylesDir, "chat", "grouped.css"), "utf8"),
  );

  it.each([
    [
      "keeps every text token at WCAG AA on every theme surface, AAA on themes that promise it",
      paletteCases((_theme, _tokens, floor) =>
        TEXT_TOKENS.flatMap((ink) =>
          SURFACE_TOKENS.map((fill) => [`var(${ink})`, `var(${fill})`, floor] as const),
        ),
      ),
    ],
    [
      "keeps selected controls and session labels at WCAG AA across themes",
      paletteCases(() => controls),
    ],
    [
      "keeps filled action labels and accent glyphs legible across palettes",
      paletteCases(() => [
        ["var(--primary-foreground)", "var(--primary)", AA_NORMAL_TEXT_MIN],
        ["var(--primary-foreground)", "var(--primary-hover)", AA_NORMAL_TEXT_MIN],
        ["var(--destructive-foreground)", "var(--destructive-hover)", AA_NORMAL_TEXT_MIN],
        ["var(--accent-foreground)", "var(--accent)", 3],
      ]),
    ],
    [
      "keeps the chat confirmation button legible on every theme",
      paletteCases((themeName, tokens, floor) => {
        const paint = confirmation.overrides.get(themeName) ?? confirmation.base;
        const fill = tokens.get(paint.background);
        const ink = tokens.get(paint.color);
        return fill?.startsWith("#") && ink?.startsWith("#") ? [[ink, fill, floor]] : [];
      }),
    ],
    [
      "keeps highlighted diff lines at WCAG AA on every code surface",
      paletteCases((_theme, _tokens, floor) =>
        diffs.flatMap(({ foregroundToken, tint }) =>
          DIFF_HOST_SURFACES.map(
            (surface) => [`var(${foregroundToken})`, tint, floor, `var(${surface})`] as const,
          ),
        ),
      ),
    ],
  ] as const)("%s", (_name, samples) => {
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
    const defaults = parseThemeBlocks(baseCss).get(":root") ?? new Map<string, string>();
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
          expect(
            hover,
            `${fill} hover must not reduce the imported pair contrast`,
          ).toBeGreaterThanOrEqual(rest);
        }
      }
    }
  });

  it("keeps the markdown code chip separated from every surface it sits on", () => {
    const chatTextCss = fs.readFileSync(path.join(stylesDir, "chat", "text.css"), "utf8");
    const chip = readCodeChipTokens(chatTextCss);
    for (const [themeName, tokens] of themes) {
      const surface = tokens.get(chip.surface);
      const border = tokens.get(chip.border);
      expect(surface, `${themeName}: ${chip.surface} is not a hex token`).toMatch(/^#/u);
      expect(border, `${themeName}: ${chip.border} is not a hex token`).toMatch(/^#/u);
      for (const hostToken of CODE_CHIP_HOST_SURFACES) {
        const host = tokens.get(hostToken);
        if (!host?.startsWith("#")) {
          continue;
        }
        const surfaceStep = contrastRatio(parseHex(surface ?? ""), parseHex(host));
        const borderStep = contrastRatio(parseHex(border ?? ""), parseHex(host));
        expect(
          surfaceStep,
          `${themeName}: chip ${chip.surface} ${surface} on ${hostToken} ${host}`,
        ).toBeGreaterThanOrEqual(CHIP_SURFACE_MIN_STEP);
        expect(
          borderStep,
          `${themeName}: chip border ${chip.border} ${border} on ${hostToken} ${host}`,
        ).toBeGreaterThanOrEqual(CHIP_BORDER_MIN_STEP);
      }
    }
  });

  it("keeps GitHub item surfaces neutral and ink and focus legible across themes and bubbles", () => {
    const css = fs.readFileSync(path.join(stylesDir, "chat", "text.css"), "utf8");
    const bubble = readBubbleBackgrounds(
      fs.readFileSync(path.join(stylesDir, "chat", "grouped.css"), "utf8"),
    );
    const selector = ".chat-text a.markdown-github-item";
    const base = readRuleBody(css, selector);
    const declaration = (body: string, property: string) => {
      const value = body
        .split(property + ":")[1]
        ?.split(";")[0]
        ?.trim();
      if (!value) {
        throw new Error("Missing GitHub chip paint: " + property);
      }
      return value;
    };
    const foreground = declaration(base, "color");
    const surfaces = [
      declaration(base, "background"),
      declaration(readRuleBody(css, selector + ":focus-visible"), "background"),
    ];
    const focus = css.match(
      /a\.markdown-github-item:focus-visible\s*\{\s*outline-color:\s*([^;]+);/u,
    )?.[1];
    if (!focus) {
      throw new Error("Missing GitHub chip focus paint");
    }
    const failures: string[] = [];
    for (const [theme, palette] of themes) {
      const page = resolveOpaqueColor("var(--bg)", palette);
      const light = theme === "light" || theme.endsWith("-light");
      const hosts = [
        page,
        composite(resolveColor(light ? bubble.lightUser : bubble.user, palette), page),
      ];
      for (let hue = 0; hue < 360; hue++) {
        const tokens = new Map(palette).set("--chat-sender-hue", String(hue));
        hosts.push(
          composite(resolveColor(light ? bubble.lightSenderTint : bubble.senderTint, tokens), page),
        );
        // Forwarded assistant messages retain the translucent sender skin in light mode.
        hosts.push(composite(resolveColor(bubble.senderTint, tokens), page));
      }
      const neutralTokens = new Map(palette).set(
        "--github-item-tone",
        declaration(base, "--github-item-tone"),
      );
      for (const tone of ["unknown", "neutral", "positive", "negative", "accent", "attention"]) {
        const rule =
          tone === "unknown" || tone === "neutral"
            ? base
            : readRuleBody(css, selector + '[data-link-reader-tone="' + tone + '"]');
        const tokens = new Map(palette).set(
          "--github-item-tone",
          declaration(rule, "--github-item-tone"),
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
    const chatTextCss = fs.readFileSync(path.join(stylesDir, "chat", "text.css"), "utf8");
    const groupedCss = fs.readFileSync(path.join(stylesDir, "chat", "grouped.css"), "utf8");
    const linkTokens = readChatLinkTokens(chatTextCss);
    const bubbleBackgrounds = readBubbleBackgrounds(groupedCss);
    for (const [themeName, tokens] of themes) {
      const page = resolveOpaqueColor("var(--bg)", tokens);
      const isLight = themeName === "light" || themeName.endsWith("-light");
      const userFill = isLight ? bubbleBackgrounds.lightUser : bubbleBackgrounds.user;
      const senderTint = isLight ? bubbleBackgrounds.lightSenderTint : bubbleBackgrounds.senderTint;
      const userBubble = composite(resolveColor(userFill, tokens), page);

      if (isLight) {
        expect(bubbleBackgrounds.lightUserText).not.toBe("");
        const foreground = resolveOpaqueColor(`var(${bubbleBackgrounds.lightUserText})`, tokens);
        const ratio = contrastRatio(foreground, userBubble);
        expect(
          ratio,
          `${themeName}: text ${bubbleBackgrounds.lightUserText} on user bubble ${userFill}`,
        ).toBeGreaterThanOrEqual(AA_NORMAL_TEXT_MIN);
      }

      for (const [state, token] of [
        ["link", linkTokens.link],
        ["link hover", linkTokens.hover],
      ] as const) {
        const foreground = resolveColor(`var(${token})`, tokens);
        const userRatio = contrastRatio(composite(foreground, userBubble), userBubble);
        expect(
          userRatio,
          `${themeName}: ${state} ${token} on user bubble ${userFill}`,
        ).toBeGreaterThanOrEqual(AA_NORMAL_TEXT_MIN);

        let worstRatio = Number.POSITIVE_INFINITY;
        let worstHue = 0;
        for (let hue = 0; hue < 360; hue += 1) {
          const hueTokens = new Map(tokens).set("--chat-sender-hue", String(hue));
          const bubble = composite(resolveColor(senderTint, hueTokens), page);
          const ratio = contrastRatio(composite(foreground, bubble), bubble);
          if (ratio < worstRatio) {
            worstRatio = ratio;
            worstHue = hue;
          }
        }
        expect(
          worstRatio,
          `${themeName}: ${state} ${token} on sender-tinted bubble ${senderTint} at hue ${worstHue}`,
        ).toBeGreaterThanOrEqual(AA_NORMAL_TEXT_MIN);
      }
    }
  });
});
