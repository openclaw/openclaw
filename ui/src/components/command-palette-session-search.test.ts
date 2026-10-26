import { expect, it } from "vitest";
import type { GatewaySessionRow } from "../api/types.ts";
import { buildCommandPaletteSessionItems } from "./command-palette-session-search.ts";

it("ranks a canonically equivalent exact title above a newer title prefix", () => {
  const visibleRows: GatewaySessionRow[] = [
    { key: "agent:main:prefix", kind: "direct", displayName: "München travel", updatedAt: 2 },
    { key: "agent:main:exact", kind: "direct", displayName: "Mu\u0308nchen", updatedAt: 1 },
  ];
  const items = buildCommandPaletteSessionItems({
    visibleRows,
    visibleKeys: new Set(visibleRows.map((row) => row.key)),
    transcriptResult: null,
    search: "München",
  });

  expect(items.map(({ action, label }) => ({ action, label }))).toEqual([
    { action: "session:agent:main:exact", label: "Mu\u0308nchen" },
    { action: "session:agent:main:prefix", label: "München travel" },
  ]);
});
