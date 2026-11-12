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

it("prefers active sessions only after metadata and message relevance tie", () => {
  const visibleRows: GatewaySessionRow[] = [
    {
      key: "agent:main:archived-exact",
      kind: "direct",
      label: "Heron",
      archived: true,
      updatedAt: 3,
    },
    { key: "agent:main:active-prefix", kind: "direct", label: "Heron notes", updatedAt: 1 },
    {
      key: "agent:main:archived-prefix",
      kind: "direct",
      label: "Heron notes",
      archived: true,
      updatedAt: 4,
    },
  ];
  const items = buildCommandPaletteSessionItems({
    visibleRows,
    visibleKeys: new Set(visibleRows.map((row) => row.key)),
    transcriptResult: null,
    search: "Heron",
  });
  expect(items.map((item) => item.session?.key)).toEqual([
    "agent:main:archived-exact",
    "agent:main:active-prefix",
    "agent:main:archived-prefix",
  ]);
  const messages = buildCommandPaletteSessionItems({
    visibleRows: [],
    visibleKeys: new Set(),
    transcriptResult: {
      sessions: visibleRows,
      results: visibleRows.map((row, index) => ({
        sessionKey: row.key,
        messageId: row.key,
        sessionId: row.key,
        role: "user",
        timestamp: 1,
        snippet: "telescope",
        score: index === 0 ? 2 : 1,
      })),
    },
    search: "telescope",
  });
  expect(messages.map((item) => item.session?.key)).toEqual([
    "agent:main:archived-exact",
    "agent:main:active-prefix",
    "agent:main:archived-prefix",
  ]);
});
