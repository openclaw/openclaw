import { expect, it } from "vitest";
import type { GatewaySessionRow } from "../api/types.ts";
import { buildCommandPaletteSessionItems } from "./command-palette-session-search.ts";

it.each([
  ["München", "München travel", "Mu\u0308nchen"],
  ["οσ", "ΟΣ travel", "ος"],
])("ranks the equivalent exact title above a newer prefix for %s", (search, prefix, exact) => {
  const visibleRows: GatewaySessionRow[] = [
    { key: "agent:main:prefix", kind: "direct", displayName: prefix, updatedAt: 2 },
    { key: "agent:main:exact", kind: "direct", displayName: exact, updatedAt: 1 },
  ];
  const items = buildCommandPaletteSessionItems({
    visibleRows,
    visibleKeys: new Set(visibleRows.map((row) => row.key)),
    transcriptResult: null,
    search,
  });

  expect(items.map(({ action, label }) => ({ action, label }))).toEqual([
    { action: "session:agent:main:exact", label: exact },
    { action: "session:agent:main:prefix", label: prefix },
  ]);
});

it("ranks sigma-equivalent literal metadata without a matching title", () => {
  const visibleRows: GatewaySessionRow[] = [
    {
      key: "agent:main:prefix",
      kind: "direct",
      displayName: "Newer",
      model: "ΟΣ-more",
      updatedAt: 2,
    },
    { key: "agent:main:exact", kind: "direct", displayName: "Older", model: "ος", updatedAt: 1 },
  ];
  const items = buildCommandPaletteSessionItems({
    visibleRows,
    visibleKeys: new Set(visibleRows.map((row) => row.key)),
    transcriptResult: null,
    search: "οσ",
  });
  expect(items.map((item) => item.action)).toEqual([
    "session:agent:main:exact",
    "session:agent:main:prefix",
  ]);
});

it("orders sessions by exact title, then recency, regardless of where the words fall", () => {
  const visibleRows: GatewaySessionRow[] = [
    { key: "agent:main:old-prefix", kind: "direct", displayName: "Voice notes", updatedAt: 1 },
    {
      key: "agent:main:new-middle",
      kind: "direct",
      displayName: "Fix the voice bug",
      updatedAt: 3,
    },
    { key: "agent:main:exact", kind: "direct", displayName: "Voice", updatedAt: 2 },
  ];
  const items = buildCommandPaletteSessionItems({
    visibleRows,
    visibleKeys: new Set(visibleRows.map((row) => row.key)),
    transcriptResult: null,
    search: "voice",
  });
  expect(items.map((item) => item.label)).toEqual(["Voice", "Fix the voice bug", "Voice notes"]);
});

it("adds at most three archived sessions whose titles match, in their own group", () => {
  const archived = (key: string, displayName: string, updatedAt: number, model?: string) => ({
    key: `agent:main:${key}`,
    kind: "direct" as const,
    displayName,
    updatedAt,
    archived: true,
    ...(model ? { model } : {}),
  });
  const items = buildCommandPaletteSessionItems({
    visibleRows: [],
    visibleKeys: new Set(),
    transcriptResult: null,
    archivedRows: [
      archived("model-only", "Unrelated", 9, "voice-model"),
      archived("older", "Old voice notes", 1),
      archived("newer", "Voice memo", 7),
      archived("newest", "Voice draft", 8),
      archived("exact", "Voice", 2),
    ],
    search: "voice",
  });
  expect(items.map((item) => [item.label, item.category])).toEqual([
    ["Voice", "archived"],
    ["Voice draft", "archived"],
    ["Voice memo", "archived"],
  ]);
});
