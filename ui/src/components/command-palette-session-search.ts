import type { SessionsSearchResult } from "../../../packages/gateway-protocol/src/index.js";
import { indexFirstByKey } from "../../../src/shared/dedupe-by-key.ts";
import {
  normalizeSessionSearchLiteral,
  normalizeSessionSearchText,
  rankSessionSearchFields,
} from "../../../src/shared/session-search-text.ts";
import type { GatewaySessionRow } from "../api/types.ts";
import { clampText } from "../lib/format.ts";
import { resolveSessionDisplayName } from "../lib/session-display.ts";
import { SESSION_SEARCH_SCOPE } from "../lib/sessions/session-requests.ts";
import type { CommandPaletteItem } from "./command-palette-catalog-search.ts";

export const SESSION_ACTION_PREFIX = "session:";
export const SESSION_SEARCH_LIMIT = 10;
// Discovery includes completed conversations without changing section membership.
export const COMMAND_PALETTE_SESSION_SEARCH_SCOPE = {
  ...SESSION_SEARCH_SCOPE,
  archivedFilter: "all",
} as const;
const SESSION_SEARCH_SNIPPET_MAX_CHARS = 160;

export function buildCommandPaletteSessionItems(params: {
  visibleRows: readonly GatewaySessionRow[];
  visibleKeys: ReadonlySet<string>;
  transcriptResult: (SessionsSearchResult & { sessions: readonly GatewaySessionRow[] }) | null;
  search: string;
}): CommandPaletteItem[] {
  const { visibleRows, visibleKeys, transcriptResult } = params;
  const normalizedSearch = normalizeSessionSearchLiteral(params.search);
  const titleSearch = normalizeSessionSearchText(params.search);
  const transcriptHitByKey = indexFirstByKey(
    transcriptResult?.results ?? [],
    (hit) => hit.sessionKey,
  );
  const rowsByKey = new Map(visibleRows.map((row) => [row.key, row] as const));
  for (const row of transcriptResult?.sessions ?? []) {
    if (!rowsByKey.has(row.key)) {
      rowsByKey.set(row.key, row);
    }
  }
  return [...rowsByKey.values()]
    .map((row) => {
      const label = resolveSessionDisplayName(row.key, row);
      const titles = [label, row.label, row.subject, row.category];
      const fields = [
        ...titles,
        row.key,
        row.kind,
        row.model,
        row.modelProvider,
        row.owner?.actor.label,
        row.owner?.actor.id,
        row.createdActor?.label,
        row.createdActor?.id,
      ]
        .map(normalizeSessionSearchLiteral)
        .filter(Boolean);
      const titleFields = titleSearch ? titles.map(normalizeSessionSearchText) : [];
      const rawMetadataRank = rankSessionSearchFields(
        fields,
        titleFields,
        normalizedSearch,
        titleSearch,
      );
      return {
        row,
        label,
        rawMetadataRank,
        metadataRank: Math.max(visibleKeys.has(row.key) ? 1 : 0, rawMetadataRank),
        transcriptHit: transcriptHitByKey.get(row.key),
      };
    })
    .filter(({ metadataRank, transcriptHit }) => metadataRank > 0 || transcriptHit)
    .toSorted((left, right) => {
      const metadataDiff = right.metadataRank - left.metadataRank;
      if (metadataDiff !== 0) {
        return metadataDiff;
      }
      const transcriptDiff =
        (right.transcriptHit?.score ?? Number.NEGATIVE_INFINITY) -
        (left.transcriptHit?.score ?? Number.NEGATIVE_INFINITY);
      return (
        transcriptDiff ||
        Number(left.row.archived === true) - Number(right.row.archived === true) ||
        (right.row.updatedAt ?? 0) - (left.row.updatedAt ?? 0)
      );
    })
    .slice(0, SESSION_SEARCH_LIMIT)
    .map<CommandPaletteItem>(({ row, label, rawMetadataRank, transcriptHit }) => ({
      id: `session-${row.key}`,
      label,
      icon: "messageSquare",
      category: transcriptHit && rawMetadataRank === 0 ? "messages" : "chats",
      action: `${SESSION_ACTION_PREFIX}${row.key}`,
      session: row,
      // The server match floor affects ordering, not whether the local metadata matched.
      description:
        transcriptHit && rawMetadataRank === 0
          ? clampText(
              transcriptHit.snippet.replace(/\s+/gu, " ").trim(),
              SESSION_SEARCH_SNIPPET_MAX_CHARS,
            )
          : undefined,
    }));
}
