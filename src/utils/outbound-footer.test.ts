import { describe, expect, test } from "vitest";
import {
  computeContextPercent,
  evaluateContextWarning,
  processOutboundText,
  renderFooter,
  stripFabricatedFooter,
} from "./outbound-footer.js";

describe("stripFabricatedFooter", () => {
  test("strips a canonical model-written footer", () => {
    const input = "hello world\n\n📚 5% (10k/200k) · 🧹 0 compactions · 🧠 anthropic/claude-opus-4-7";
    const result = stripFabricatedFooter(input);
    expect(result.changed).toBe(true);
    expect(result.text).toBe("hello world");
  });

  test("strips a footer that lies about the percent", () => {
    // The whole point: even a fabricated 5% claim vs real 134% must be stripped.
    const input = "reply body\n📚 5% (10k/200k) · 🧹 3 compactions · 🧠 claude-opus-4-7";
    const result = stripFabricatedFooter(input);
    expect(result.changed).toBe(true);
    expect(result.text).toBe("reply body");
  });

  test("strips footers using bullet variant", () => {
    const input = "ok\n📚 70% (140k/200k) • 🧹 2 compactions • 🧠 gpt-4o";
    const result = stripFabricatedFooter(input);
    expect(result.changed).toBe(true);
    expect(result.text).toBe("ok");
  });

  test("strips footer with decimal token counts", () => {
    const input = "body\n📚 12% (24.5k/200k) · 🧹 0 compactions · 🧠 mini";
    const result = stripFabricatedFooter(input);
    expect(result.changed).toBe(true);
    expect(result.text).toBe("body");
  });

  test("does not touch text that has no footer", () => {
    const input = "just a regular reply with no footer at all";
    const result = stripFabricatedFooter(input);
    expect(result.changed).toBe(false);
    expect(result.text).toBe(input);
  });

  test("does not strip an unrelated 📚 emoji line", () => {
    const input = "📚 reading list updated";
    const result = stripFabricatedFooter(input);
    expect(result.changed).toBe(false);
    expect(result.text).toBe(input);
  });

  test("handles missing-input gracefully", () => {
    expect(stripFabricatedFooter("").text).toBe("");
    expect(stripFabricatedFooter("").changed).toBe(false);
  });
});

describe("renderFooter", () => {
  test("substitutes all known placeholders", () => {
    const out = renderFooter(
      "📚 {context_pct}% ({context_tokens}/{context_limit}) · 🧹 {compactions} compactions · 🧠 {model_alias}",
      {
        contextTokens: 134_000,
        contextLimit: 200_000,
        compactions: 2,
        modelAlias: "anthropic/claude-opus-4-7",
      },
    );
    expect(out).toBe("📚 67% (134k/200k) · 🧹 2 compactions · 🧠 anthropic/claude-opus-4-7");
  });

  test("renders ? for missing values", () => {
    const out = renderFooter("📚 {context_pct}% · 🧠 {model_alias}", {});
    expect(out).toBe("📚 ?% · 🧠 ?");
  });

  test("preserves unknown placeholders so config typos remain visible", () => {
    const out = renderFooter("{model_alias} has {garbage}", {
      modelAlias: "x",
    });
    expect(out).toBe("x has {garbage}");
  });

  test("rounds percent to nearest integer", () => {
    const out = renderFooter("{context_pct}", {
      contextTokens: 130_500,
      contextLimit: 200_000,
    });
    expect(out).toBe("65");
  });

  test("computeContextPercent guards against zero or invalid limits", () => {
    expect(computeContextPercent(100, 0)).toBeUndefined();
    expect(computeContextPercent(100, undefined)).toBeUndefined();
    expect(computeContextPercent(undefined, 200_000)).toBeUndefined();
  });
});

describe("evaluateContextWarning", () => {
  test("returns a warning at the highest crossed unwarned threshold", () => {
    const result = evaluateContextWarning({
      contextTokens: 180_000,
      contextLimit: 200_000,
      thresholds: [70, 85, 95],
      alreadyWarned: [],
    });
    expect(result.thresholdToRecord).toBe(85);
    expect(result.warningLine).toBe("\u26A0\uFE0F Context 90% - consider /new");
  });

  test("does not refire a threshold that has already been warned", () => {
    const result = evaluateContextWarning({
      contextTokens: 145_000,
      contextLimit: 200_000,
      thresholds: [70, 85, 95],
      alreadyWarned: [70],
    });
    expect(result.thresholdToRecord).toBeUndefined();
    expect(result.warningLine).toBeUndefined();
  });

  test("fires a higher threshold even when a lower one is already warned", () => {
    const result = evaluateContextWarning({
      contextTokens: 175_000,
      contextLimit: 200_000,
      thresholds: [70, 85, 95],
      alreadyWarned: [70],
    });
    expect(result.thresholdToRecord).toBe(85);
    expect(result.warningLine).toBe("\u26A0\uFE0F Context 88% - consider /new");
  });

  test("returns nothing when usage is below all thresholds", () => {
    const result = evaluateContextWarning({
      contextTokens: 10_000,
      contextLimit: 200_000,
      thresholds: [70, 85, 95],
      alreadyWarned: [],
    });
    expect(result).toEqual({});
  });

  test("returns nothing when context info is missing", () => {
    const result = evaluateContextWarning({
      contextTokens: undefined,
      contextLimit: 200_000,
      thresholds: [70, 85, 95],
      alreadyWarned: [],
    });
    expect(result).toEqual({});
  });

  test("ignores invalid threshold entries", () => {
    const result = evaluateContextWarning({
      contextTokens: 180_000,
      contextLimit: 200_000,
      thresholds: [Number.NaN, -10, 0, 1500, 85],
      alreadyWarned: [],
    });
    expect(result.thresholdToRecord).toBe(85);
  });
});

describe("processOutboundText", () => {
  test("strips fabricated footer and appends server-rendered one", () => {
    const result = processOutboundText({
      text: "real reply\n📚 5% (10k/200k) · 🧹 0 compactions · 🧠 fake-model",
      footer: {
        enabled: true,
        template: "📚 {context_pct}% ({context_tokens}/{context_limit}) · 🧠 {model_alias}",
        vars: {
          contextTokens: 268_000,
          contextLimit: 200_000,
          modelAlias: "anthropic/claude-opus-4-7",
        },
      },
    });
    expect(result.strippedFabricatedFooter).toBe(true);
    expect(result.appendedFooter).toBe(true);
    expect(result.text).toBe(
      "real reply\n\n📚 134% (268k/200k) · 🧠 anthropic/claude-opus-4-7",
    );
  });

  test("prepends a context warning when threshold crossed for the first time", () => {
    const result = processOutboundText({
      text: "body",
      warning: {
        contextTokens: 180_000,
        contextLimit: 200_000,
        thresholds: [70, 85, 95],
        alreadyWarned: [],
      },
    });
    expect(result.prependedWarning).toBe(true);
    expect(result.warningThresholdRecorded).toBe(85);
    expect(result.text.startsWith("\u26A0\uFE0F Context 90% - consider /new\n")).toBe(true);
    expect(result.text.endsWith("body")).toBe(true);
  });

  test("does not append a footer when disabled", () => {
    const result = processOutboundText({
      text: "body\n📚 5% (10k/200k) · 🧹 0 compactions · 🧠 fake",
      footer: {
        enabled: false,
        template: "📚 {context_pct}%",
        vars: { contextTokens: 100_000, contextLimit: 200_000 },
      },
    });
    expect(result.strippedFabricatedFooter).toBe(true);
    expect(result.appendedFooter).toBe(false);
    expect(result.text).toBe("body");
  });

  test("is a no-op for plain text when no features are enabled", () => {
    const result = processOutboundText({ text: "hello" });
    expect(result.text).toBe("hello");
    expect(result.strippedFabricatedFooter).toBe(false);
    expect(result.appendedFooter).toBe(false);
    expect(result.prependedWarning).toBe(false);
    expect(result.warningThresholdRecorded).toBeUndefined();
  });
});
