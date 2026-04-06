import { describe, expect, it } from "vitest";
import { MEMES, formatMemesList, formatMemeSingle } from "./memes-cli.js";

describe("memes-cli", () => {
  describe("MEMES", () => {
    it("has at least one meme", () => {
      expect(MEMES.length).toBeGreaterThan(0);
    });

    it("every meme has required fields", () => {
      for (const meme of MEMES) {
        expect(meme.id).toBeTruthy();
        expect(meme.title).toBeTruthy();
        expect(meme.art).toBeTruthy();
        expect(meme.category).toMatch(/^(data-freedom|sovereignty|open-source|burgess-principle)$/);
        expect(Array.isArray(meme.tags)).toBe(true);
      }
    });

    it("all meme IDs are unique", () => {
      const ids = MEMES.map((m) => m.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(ids.length);
    });

    it("covers every category", () => {
      const categories = new Set(MEMES.map((m) => m.category));
      expect(categories).toContain("data-freedom");
      expect(categories).toContain("sovereignty");
      expect(categories).toContain("open-source");
      expect(categories).toContain("burgess-principle");
    });
  });

  describe("formatMemesList", () => {
    it("returns a message when no memes match", () => {
      const output = formatMemesList([]);
      expect(output).toContain("No memes found");
    });

    it("lists meme IDs and titles", () => {
      const output = formatMemesList(MEMES);
      expect(output).toContain(MEMES[0].id);
      expect(output).toContain(MEMES[0].title);
    });

    it("outputs valid JSON with --json flag", () => {
      const output = formatMemesList(MEMES, { json: true });
      const parsed = JSON.parse(output);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBe(MEMES.length);
      for (const item of parsed) {
        expect(item).toHaveProperty("id");
        expect(item).toHaveProperty("title");
        expect(item).toHaveProperty("category");
        expect(item).toHaveProperty("tags");
      }
    });

    it("filters by category", () => {
      const sovereignty = MEMES.filter((m) => m.category === "sovereignty");
      const output = formatMemesList(sovereignty);
      for (const meme of sovereignty) {
        expect(output).toContain(meme.id);
      }
      const nonSovereignty = MEMES.filter((m) => m.category !== "sovereignty");
      for (const meme of nonSovereignty) {
        expect(output).not.toContain(meme.id);
      }
    });
  });

  describe("formatMemeSingle", () => {
    it("displays the meme art and title", () => {
      const meme = MEMES[0];
      const output = formatMemeSingle(meme);
      expect(output).toContain(meme.title);
      expect(output).toContain(meme.art);
    });

    it("shows category and tags", () => {
      const meme = MEMES[0];
      const output = formatMemeSingle(meme);
      expect(output).toContain(meme.category);
      expect(output).toContain(meme.tags[0]);
    });

    it("outputs valid JSON with --json flag", () => {
      const meme = MEMES[0];
      const output = formatMemeSingle(meme, { json: true });
      const parsed = JSON.parse(output);
      expect(parsed.id).toBe(meme.id);
      expect(parsed.title).toBe(meme.title);
      expect(parsed.art).toBe(meme.art);
      expect(parsed.category).toBe(meme.category);
    });
  });

  describe("burgess-principle meme", () => {
    it("exists and references user control", () => {
      const burgess = MEMES.find((m) => m.category === "burgess-principle");
      expect(burgess).toBeDefined();
      expect(burgess!.art.toLowerCase()).toMatch(/user|principal|authority/);
    });
  });
});
