import type { UsageBarTemplate } from "./translator.js";

/**
 * Built-in `/usage full` footer template, used when `messages.usageTemplate` is
 * set to the sentinel string `"default"`. Opt-in and intentionally undocumented
 * in the config schema/help for now — a path or inline object still overrides.
 *
 * It is the same `openclaw.usageBar.v1` DSL a user template uses, kept in source
 * (rather than a shipped JSON) so the default stays in lockstep with the engine.
 *
 * DSL recap (see translator.ts for the full verb set):
 *   - Each surface in `output.surfaces` is an ordered piece list; the engine
 *     renders each piece, drops empties, and joins survivors with `output.sep`.
 *   - `{path|verb:arg|fallback}` resolves `path` against the contract, applies
 *     verbs left→right, and uses `fallback` when the value is absent.
 *   - Verbs: num (compact count) · fixed:N (decimals) · dur (seconds→4h07m/5.2d)
 *     · pct · inv (100−x) · alias:TABLE (lookup in `aliases`, echo if unlisted)
 *     · meter:W:SCALE (glyph bar — used for the 📚 context-window bar).
 *   - `{ when }` shows a piece only if a path is truthy; `{ map, cases }` maps a
 *     value to a glyph; `{ each, item }` iterates an array.
 *
 * Contract paths used below (built by buildUsageContract in contract.ts):
 *   model.{provider,display_name,reasoning,is_fallback,is_override}
 *   identity.emoji · state.fast_mode · context.{pct_used,max_tokens}
 *   usage.last.{input_tokens,output_tokens,cache_hit_pct} · cost.turn_usd
 *
 * `when` guards wrap the optional segments so an absent field drops the whole
 * piece (no dangling separators or empty glyphs).
 */
export const DEFAULT_USAGE_BAR_TEMPLATE: UsageBarTemplate = {
  schema: "openclaw.usageBar.v1",
  scales: {
    braille: "⠐⡀⡄⡆⡇⣇⣧⣷⣿",
  },
  aliases: {
    models: {
      "claude-opus-4-6": "opus46",
      "claude-opus-4-8": "opus48",
      "claude-sonnet-4-6": "sonnet46",
      "claude-haiku-4-5": "haiku45",
      "gpt-5.5": "gpt5.5",
    },
    reasoning: { off: "🌑", minimal: "🌚", low: "🌘", medium: "🌗", high: "🌕", xhigh: "🌝" },
  },
  output: {
    sep: "",
    // Surfaces without an explicit entry (telegram, web, …) fall back to this.
    // The engine reads `output.default`, NOT `output.surfaces.default`.
    default: [
      { text: "{model.display_name|alias:models}" },
      { map: "model.is_fallback", cases: { true: " 🔄" } },
      { map: "model.is_override", cases: { true: " 📌" } },
      { when: "model.reasoning", text: " {model.reasoning|alias:reasoning}" },
      { map: "state.fast_mode", cases: { true: " ⚡", false: " 🐌" } },
      {
        when: "context.max_tokens",
        text: " | 📚 [{context.pct_used|meter:5:braille}]{context.max_tokens|num}",
      },
    ],
    surfaces: {
      discord: [
        { text: "-# -\n" },
        { text: "-# {model.provider}{identity.emoji|🤖} {model.display_name|alias:models}" },
        { map: "model.is_fallback", cases: { true: "🔄" } },
        { map: "model.is_override", cases: { true: "📌" } },
        { when: "model.reasoning", text: " {model.reasoning|alias:reasoning}" },
        { map: "state.fast_mode", cases: { true: " ⚡️", false: " 🐌" } },
        {
          when: "context.max_tokens",
          text: " | 📚 [{context.pct_used|meter:5:braille}]{context.max_tokens|num}",
        },
        {
          when: "usage.last",
          text: " ↕️ {usage.last.input_tokens|num}/{usage.last.output_tokens|num}",
        },
        { when: "usage.last.cache_hit_pct", text: " 🗄 {usage.last.cache_hit_pct|pct}" },
        { when: "cost.turn_usd", text: " 💰{cost.turn_usd|fixed:4}" },
      ],
    },
  },
};
