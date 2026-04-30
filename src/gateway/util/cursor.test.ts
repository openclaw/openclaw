import { describe, expect, it } from "vitest";
import { CursorError, decodeCursor, encodeCursor } from "./cursor.js";

describe("cursor", () => {
  describe("round-trip", () => {
    it("encodes and decodes 1", () => {
      expect(decodeCursor(encodeCursor(1))).toBe(1);
    });

    it("encodes and decodes large seq values", () => {
      expect(decodeCursor(encodeCursor(99999))).toBe(99999);
    });

    it("produces base64url output (no +, /, or = padding)", () => {
      const cursor = encodeCursor(42);
      expect(cursor).not.toMatch(/[+/=]/);
    });
  });

  describe("decodeCursor errors", () => {
    it("throws CursorError for a random non-base64 string", () => {
      expect(() => decodeCursor("not-a-valid-cursor!!")).toThrow(CursorError);
    });

    it("throws CursorError for empty string", () => {
      expect(() => decodeCursor("")).toThrow(CursorError);
    });

    it("throws CursorError for a base64url string that decodes to NaN", () => {
      const nanCursor = Buffer.from("abc").toString("base64url");
      expect(() => decodeCursor(nanCursor)).toThrow(CursorError);
    });

    it("throws CursorError for a cursor encoding zero", () => {
      const zeroCursor = Buffer.from("0").toString("base64url");
      expect(() => decodeCursor(zeroCursor)).toThrow(CursorError);
    });

    it("throws CursorError for a cursor encoding a negative number", () => {
      const negativeCursor = encodeCursor(-1);
      expect(() => decodeCursor(negativeCursor)).toThrow(CursorError);
    });

    it("error has code INVALID_REQUEST", () => {
      try {
        decodeCursor("bad");
      } catch (e) {
        expect(e).toBeInstanceOf(CursorError);
        expect((e as CursorError).code).toBe("INVALID_REQUEST");
      }
    });
  });
});
