import { expect, it } from "vitest";
import { sessionCatalogPaging as paging } from "./session-catalog-paging.js";

it("binds opaque transcript cursors to the exact relationship and canonical encoding", () => {
  const owned = { relationship: "owned", target: { type: "github-account", id: "101" } } as const;
  const involving = { ...owned, relationship: "involving" } as const;
  expect(paging.encodeScopedCursor("opaque")).toBe("opaque");
  expect(paging.decodeScopedCursor(undefined, owned)).toBeUndefined();
  const scoped = paging.encodeScopedCursor("opaque", owned);
  expect(paging.decodeScopedCursor(scoped, owned)).toBe("opaque");
  for (const cursor of [scoped, "invalid", scoped + "="]) {
    expect(() => paging.decodeScopedCursor(cursor, involving)).toThrow(
      "cursor does not belong to this relationship query",
    );
  }
});
