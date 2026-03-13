import { describe, expect, it } from "vitest";
import { enrichTabResponseBody } from "./agent.shared.js";

const TAB = { targetId: "tid-1", url: "https://example.com/page" };

describe("enrichTabResponseBody", () => {
  it("adds targetId and url to successful response", () => {
    const body: Record<string, unknown> = { ok: true, data: "snapshot" };
    const result = enrichTabResponseBody(body, TAB);
    expect(result).toBe(true);
    expect(body.targetId).toBe("tid-1");
    expect(body.url).toBe("https://example.com/page");
  });

  it("prefers postRunUrl over tab.url", () => {
    const body: Record<string, unknown> = { ok: true };
    enrichTabResponseBody(body, TAB, "https://example.com/after-navigate");
    expect(body.url).toBe("https://example.com/after-navigate");
  });

  it("falls back to tab.url when postRunUrl is undefined", () => {
    const body: Record<string, unknown> = { ok: true };
    enrichTabResponseBody(body, TAB, undefined);
    expect(body.url).toBe("https://example.com/page");
  });

  it("does not overwrite existing targetId", () => {
    const body: Record<string, unknown> = { ok: true, targetId: "existing-id" };
    enrichTabResponseBody(body, TAB);
    expect(body.targetId).toBe("existing-id");
  });

  it("does not overwrite existing url", () => {
    const body: Record<string, unknown> = { ok: true, url: "https://existing.com" };
    enrichTabResponseBody(body, TAB, "https://new.com");
    expect(body.url).toBe("https://existing.com");
  });

  it("returns false for non-ok responses", () => {
    const body = { ok: false, error: "not found" };
    expect(enrichTabResponseBody(body, TAB)).toBe(false);
    expect((body as Record<string, unknown>).targetId).toBeUndefined();
  });

  it("returns false for null body", () => {
    expect(enrichTabResponseBody(null, TAB)).toBe(false);
  });

  it("returns false for array body", () => {
    expect(enrichTabResponseBody([{ ok: true }], TAB)).toBe(false);
  });

  it("returns false for primitive body", () => {
    expect(enrichTabResponseBody("ok", TAB)).toBe(false);
  });

  it("handles tab with no url and no postRunUrl", () => {
    const body: Record<string, unknown> = { ok: true };
    enrichTabResponseBody(body, { targetId: "tid-2" });
    expect(body.targetId).toBe("tid-2");
    expect(body.url).toBeUndefined();
  });
});
