import { describe, expect, it } from "vitest";
import { parseAdaptiveCardMarkers, stripCardMarkers } from "./parse.js";

const SAMPLE_CARD = JSON.stringify({
  type: "AdaptiveCard",
  version: "1.5",
  body: [{ type: "TextBlock", text: "Hello", weight: "Bolder" }],
  actions: [{ type: "Action.OpenUrl", title: "Open", url: "https://example.com" }],
});

const SAMPLE_DATA = JSON.stringify({ key: "val" });

function buildMarkedText(opts?: { card?: string; data?: string; fallback?: string }): string {
  const fallback = opts?.fallback ?? "Fallback text here";
  const card = opts?.card ?? SAMPLE_CARD;
  let text = `${fallback}\n\n<!--adaptive-card-->${card}<!--/adaptive-card-->`;
  if (opts?.data !== undefined) {
    text += `\n<!--adaptive-card-data-->${opts.data}<!--/adaptive-card-data-->`;
  }
  return text;
}

describe("parseAdaptiveCardMarkers", () => {
  it("returns null for plain text without markers", () => {
    expect(parseAdaptiveCardMarkers("just some text")).toBeNull();
  });

  it("parses card JSON and fallback text", () => {
    const text = buildMarkedText();
    const result = parseAdaptiveCardMarkers(text);
    expect(result).not.toBeNull();
    expect(result!.card.type).toBe("AdaptiveCard");
    expect(result!.card.version).toBe("1.5");
    expect(result!.card.body).toHaveLength(1);
    expect(result!.card.actions).toHaveLength(1);
    expect(result!.fallbackText).toBe("Fallback text here");
    expect(result!.templateData).toBeUndefined();
  });

  it("parses template data when present", () => {
    const text = buildMarkedText({ data: SAMPLE_DATA });
    const result = parseAdaptiveCardMarkers(text);
    expect(result).not.toBeNull();
    expect(result!.templateData).toEqual({ key: "val" });
  });

  it("returns null for malformed card JSON", () => {
    const text = buildMarkedText({ card: "not valid json" });
    expect(parseAdaptiveCardMarkers(text)).toBeNull();
  });

  it("returns null when card type is not AdaptiveCard", () => {
    const text = buildMarkedText({
      card: JSON.stringify({ type: "Other", version: "1.0", body: [] }),
    });
    expect(parseAdaptiveCardMarkers(text)).toBeNull();
  });

  it("handles empty fallback text", () => {
    const text = `<!--adaptive-card-->${SAMPLE_CARD}<!--/adaptive-card-->`;
    const result = parseAdaptiveCardMarkers(text);
    expect(result).not.toBeNull();
    expect(result!.fallbackText).toBe("");
  });

  it("ignores malformed template data but still parses the card", () => {
    const text = buildMarkedText({ data: "{broken" });
    const result = parseAdaptiveCardMarkers(text);
    expect(result).not.toBeNull();
    expect(result!.card.type).toBe("AdaptiveCard");
    expect(result!.templateData).toBeUndefined();
  });

  it("extracts cardId and previewUrl from meta marker", () => {
    const meta = JSON.stringify({
      cardId: "abc-123",
      previewUrl: "https://img.example.com/preview.png",
    });
    const text = buildMarkedText() + `\n<!--adaptive-card-meta-->${meta}<!--/adaptive-card-meta-->`;
    const result = parseAdaptiveCardMarkers(text);
    expect(result).not.toBeNull();
    expect(result!.cardId).toBe("abc-123");
    expect(result!.previewUrl).toBe("https://img.example.com/preview.png");
  });

  it("extracts cardId and previewUrl from card top-level $cardId/$previewUrl", () => {
    const card = JSON.stringify({
      type: "AdaptiveCard",
      version: "1.5",
      body: [{ type: "TextBlock", text: "Hi" }],
      $cardId: "top-level-id",
      $previewUrl: "https://img.example.com/top.png",
    });
    const text = buildMarkedText({ card });
    const result = parseAdaptiveCardMarkers(text);
    expect(result).not.toBeNull();
    expect(result!.cardId).toBe("top-level-id");
    expect(result!.previewUrl).toBe("https://img.example.com/top.png");
    // Should be stripped from the card object
    expect((result!.card as Record<string, unknown>).$cardId).toBeUndefined();
    expect((result!.card as Record<string, unknown>).$previewUrl).toBeUndefined();
  });

  it("prefers meta marker over card top-level for cardId/previewUrl", () => {
    const card = JSON.stringify({
      type: "AdaptiveCard",
      version: "1.5",
      body: [],
      $cardId: "from-card",
      $previewUrl: "https://card.example.com",
    });
    const meta = JSON.stringify({ cardId: "from-meta", previewUrl: "https://meta.example.com" });
    const text = `Fallback\n\n<!--adaptive-card-->${card}<!--/adaptive-card-->\n<!--adaptive-card-meta-->${meta}<!--/adaptive-card-meta-->`;
    const result = parseAdaptiveCardMarkers(text);
    expect(result).not.toBeNull();
    expect(result!.cardId).toBe("from-meta");
    expect(result!.previewUrl).toBe("https://meta.example.com");
  });
});

describe("stripCardMarkers", () => {
  it("strips all markers and returns fallback text", () => {
    const text = buildMarkedText({ data: SAMPLE_DATA });
    expect(stripCardMarkers(text)).toBe("Fallback text here");
  });

  it("returns original text when no markers present", () => {
    expect(stripCardMarkers("hello world")).toBe("hello world");
  });

  it("strips card marker without data marker", () => {
    const text = buildMarkedText();
    expect(stripCardMarkers(text)).toBe("Fallback text here");
  });

  it("strips meta markers too", () => {
    const meta = JSON.stringify({ cardId: "abc" });
    const text = buildMarkedText() + `\n<!--adaptive-card-meta-->${meta}<!--/adaptive-card-meta-->`;
    expect(stripCardMarkers(text)).toBe("Fallback text here");
  });
});
