import type { SessionsSearchResult } from "../../../packages/gateway-protocol/src/index.js";
import { indexFirstByKey } from "../../../src/shared/dedupe-by-key.ts";
import {
  normalizeSessionSearchLiteral,
  normalizeSessionSearchText,
} from "../../../src/shared/session-search-text.ts";
import type { GatewaySessionRow } from "../api/types.ts";
import type { ApplicationContext } from "../app/context.ts";
import { clampText } from "../lib/format.ts";
import { resolveSessionDisplayName } from "../lib/session-display.ts";
import { SESSION_SEARCH_SCOPE } from "../lib/sessions/session-requests.ts";
import type { CommandPaletteItem } from "./command-palette-catalog-search.ts";

export const SESSION_ACTION_PREFIX = "session:";
export const SESSION_SEARCH_LIMIT = 10;
/** Archived sessions match by title only and stay few, so they never crowd out live results. */
const ARCHIVED_SESSION_RESULT_LIMIT = 3;
export { SESSION_SEARCH_SCOPE };
const SESSION_SEARCH_SNIPPET_MAX_CHARS = 160;

/** Start both reads; the optional archive lookup must not delay live results. */
export function listCommandPaletteSessions(
  sessions: Pick<ApplicationContext["sessions"], "list">,
  search: string,
) {
  const options = {
    ...SESSION_SEARCH_SCOPE,
    source: "command-palette",
    search,
    limit: SESSION_SEARCH_LIMIT,
  } as const;
  return {
    live: sessions.list(options),
    // Best effort: a failed lookup only omits archived rows until the next search.
    archived: sessions
      .list({ ...options, archivedFilter: "archived", searchTitlesOnly: true })
      .catch(() => null),
  };
}

export function buildCommandPaletteSessionItems(params: {
  visibleRows: readonly GatewaySessionRow[];
  visibleKeys: ReadonlySet<string>;
  transcriptResult: (SessionsSearchResult & { sessions: readonly GatewaySessionRow[] }) | null;
  archivedRows?: readonly GatewaySessionRow[];
  search: string;
}): CommandPaletteItem[] {
  const { visibleRows, visibleKeys, transcriptResult } = params;
  const normalizedSearch = normalizeSessionSearchLiteral(params.search);
  const titleSearch = normalizeSessionSearchText(params.search);
  // Session titles are sentences, so where the words fall says little about intent:
  // only an exact match outranks recency.
  const match = (values: readonly unknown[], titles: readonly unknown[]) => {
    const fields = values.map(normalizeSessionSearchLiteral).filter(Boolean);
    const titleFields = titleSearch ? titles.map(normalizeSessionSearchText) : [];
    return {
      exact:
        fields.some((field) => field === normalizedSearch) ||
        titleFields.some((field) => field === titleSearch),
      found:
        fields.some((field) => field.includes(normalizedSearch)) ||
        titleFields.some((field) => field.includes(titleSearch)),
    };
  };
  const exactThenRecent = (
    left: { exact: boolean; row: GatewaySessionRow },
    right: { exact: boolean; row: GatewaySessionRow },
  ) =>
    Number(right.exact) - Number(left.exact) ||
    (right.row.updatedAt ?? 0) - (left.row.updatedAt ?? 0);
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
  const live = [...rowsByKey.values()]
    .map((row) => {
      const label = resolveSessionDisplayName(row.key, row);
      const titles = [label, row.label, row.subject, row.category];
      const { exact, found } = match(
        [
          ...titles,
          row.key,
          row.kind,
          row.model,
          row.modelProvider,
          row.owner?.actor.label,
          row.owner?.actor.id,
          row.createdActor?.label,
          row.createdActor?.id,
        ],
        titles,
      );
      const transcriptHit = transcriptHitByKey.get(row.key);
      return {
        row,
        label,
        exact,
        found,
        inMessages: Boolean(transcriptHit) && !found,
        transcriptHit,
      };
    })
    // The server's own match keeps a row a session result even without a local match.
    .filter(({ row, found, transcriptHit }) => visibleKeys.has(row.key) || found || transcriptHit)
    .toSorted(
      (left, right) =>
        Number(left.inMessages) - Number(right.inMessages) ||
        (left.inMessages
          ? (right.transcriptHit?.score ?? 0) - (left.transcriptHit?.score ?? 0)
          : 0) ||
        exactThenRecent(left, right),
    )
    .slice(0, SESSION_SEARCH_LIMIT)
    .map<CommandPaletteItem>(({ row, label, inMessages, transcriptHit }) => ({
      id: `session-${row.key}`,
      label,
      icon: "messageSquare",
      category: inMessages ? "messages" : "chats",
      action: `${SESSION_ACTION_PREFIX}${row.key}`,
      session: row,
      description:
        inMessages && transcriptHit
          ? clampText(
              transcriptHit.snippet.replace(/\s+/gu, " ").trim(),
              SESSION_SEARCH_SNIPPET_MAX_CHARS,
            )
          : undefined,
    }));
  const archived = (params.archivedRows ?? [])
    .filter((row) => !rowsByKey.has(row.key))
    .map((row) => {
      const label = resolveSessionDisplayName(row.key, row);
      const titles = [label, row.label, row.subject];
      const { exact, found } = match(titles, titles);
      return { row, label, exact, found };
    })
    .filter(({ found }) => found)
    .toSorted(exactThenRecent)
    .slice(0, ARCHIVED_SESSION_RESULT_LIMIT)
    .map<CommandPaletteItem>(({ row, label }) => ({
      id: `session-${row.key}`,
      label,
      icon: "messageSquare",
      category: "archived",
      action: `${SESSION_ACTION_PREFIX}${row.key}`,
      session: row,
    }));
  return [...live, ...archived];
}
