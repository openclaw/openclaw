/**
 * Aggregate summaries for a run of consecutive tool calls, e.g.
 * "Ran 13 commands, read 6 files, edited 9 files, created a file".
 */

import { t } from "../../i18n/index.ts";
import type { ToolCard } from "./chat-types.ts";
import {
  resolveToolCallFileOperations,
  resolveToolCallKind,
  resolveToolCallTargetPaths,
  type ToolCallKind,
} from "./tool-call-view.ts";
import { resolveToolDisplay } from "./tool-display.ts";

export type ToolCardGroup<Card = ToolCard> = {
  card: Card;
  children: ToolCardGroup<Card>[];
};

/** Preserve recorded nesting without guessing relationships from names or arrival order. */
export function groupToolCards<
  Card extends Pick<ToolCard, "callId" | "runId" | "parentToolCallId">,
>(cards: readonly Card[]): ToolCardGroup<Card>[] {
  const groups = cards.map((card): ToolCardGroup<Card> => ({ card, children: [] }));
  const identities = new Map<string, ToolCardGroup<Card> | null>();
  for (const group of groups) {
    const { runId, callId } = group.card;
    if (runId && callId) {
      const key = JSON.stringify([runId, callId]);
      identities.set(key, identities.has(key) ? null : group);
    }
  }

  const parents = new Map<ToolCardGroup<Card>, ToolCardGroup<Card>>();
  for (const group of groups) {
    const { runId, callId, parentToolCallId } = group.card;
    if (
      !runId ||
      !parentToolCallId ||
      parentToolCallId === callId ||
      (callId && identities.get(JSON.stringify([runId, callId])) !== group)
    ) {
      continue;
    }
    const parent = identities.get(JSON.stringify([runId, parentToolCallId]));
    if (parent) {
      parents.set(group, parent);
    }
  }

  // Break every cycle member out as a root before linking children. Iterative
  // traversal also keeps malformed or deeply nested transcripts stack-safe.
  const visited = new Set<ToolCardGroup<Card>>();
  for (const group of groups) {
    const path: ToolCardGroup<Card>[] = [];
    let current: ToolCardGroup<Card> | undefined = group;
    while (current && !visited.has(current)) {
      visited.add(current);
      path.push(current);
      current = parents.get(current);
    }
    const cycleStart = current ? path.indexOf(current) : -1;
    if (cycleStart >= 0) {
      for (const member of path.slice(cycleStart)) {
        parents.delete(member);
      }
    }
  }

  const roots: ToolCardGroup<Card>[] = [];
  for (const group of groups) {
    const parent = parents.get(group);
    (parent ? parent.children : roots).push(group);
  }
  return roots;
}

type ToolGroupSummaryInput = {
  name: string;
  args?: unknown;
  callId?: string;
  runId?: string;
  parentToolCallId?: string;
  isError?: boolean;
};

type FileActivity = "read" | "edit" | "write" | "delete";

type FileActivityCounts = {
  calls: number;
  paths: Set<string>;
};

type GroupCounts = {
  commands: number;
  files: Record<FileActivity, FileActivityCounts>;
  searches: number;
  fetches: number;
  otherNames: Set<string>;
  others: number;
};

function countFiles(counts: GroupCounts, activity: FileActivity, paths: readonly string[]): void {
  const target = counts.files[activity];
  target.calls += 1;
  for (const path of paths) {
    if (path.trim()) {
      target.paths.add(path.trim());
    }
  }
}

function countCard(counts: GroupCounts, card: ToolGroupSummaryInput): void {
  const kind: ToolCallKind = resolveToolCallKind(card.name, card.args);
  const fileOperations = resolveToolCallFileOperations(card.name, card.args);
  if (fileOperations) {
    for (const { operation, path } of fileOperations) {
      const activity = operation === "add" ? "write" : operation === "delete" ? "delete" : "edit";
      countFiles(counts, activity, [path]);
    }
  } else {
    const pathKeys = resolveToolCallTargetPaths(card.name, card.args);
    switch (kind) {
      case "command":
        counts.commands += 1;
        break;
      case "read":
        countFiles(counts, "read", pathKeys);
        break;
      case "edit":
        countFiles(counts, "edit", pathKeys);
        break;
      case "write":
        countFiles(counts, "write", pathKeys);
        break;
      case "search":
        counts.searches += 1;
        break;
      case "fetch":
        counts.fetches += 1;
        break;
      default:
        counts.others += 1;
        // Same display label as the standalone row, so a collapsed rollup of
        // e.g. heartbeat_respond reads "Heartbeat Respond" in both shapes.
        counts.otherNames.add(resolveToolDisplay({ name: card.name, args: card.args }).label);
    }
  }
}

function countLabel(count: number, oneKey: string, manyKey: string): string {
  return t(count === 1 ? oneKey : manyKey, { count: String(count) });
}

function fileCount(calls: number, paths: Set<string>): number {
  return paths.size > 0 ? paths.size : calls;
}

/**
 * Build the collapsed group label. The first segment carries the verb
 * ("Ran 13 commands"); later segments continue lowercase ("read 6 files").
 */
export function summarizeToolGroup(cards: readonly ToolGroupSummaryInput[]): string {
  const counts: GroupCounts = {
    commands: 0,
    files: {
      read: { calls: 0, paths: new Set() },
      edit: { calls: 0, paths: new Set() },
      write: { calls: 0, paths: new Set() },
      delete: { calls: 0, paths: new Set() },
    },
    searches: 0,
    fetches: 0,
    otherNames: new Set(),
    others: 0,
  };
  const wrappers = new Set<ToolGroupSummaryInput>();
  const pending = groupToolCards(cards);
  for (const { card, children } of pending) {
    if (children.length) {
      wrappers.add(card);
      pending.push(...children);
    }
  }
  // Match the visible hierarchy; failed wrappers retain their own outcome.
  for (const card of cards) {
    if (card.isError || !wrappers.has(card)) {
      countCard(counts, card);
    }
  }

  const segments: string[] = [];
  if (counts.commands > 0) {
    segments.push(
      countLabel(
        counts.commands,
        "chat.toolCards.group.commandsOne",
        "chat.toolCards.group.commandsMany",
      ),
    );
  }
  const fileLabels = [
    ["read", "readsOne", "readsMany"],
    ["edit", "editsOne", "editsMany"],
    ["write", "writesOne", "writesMany"],
    ["delete", "deletesOne", "deletesMany"],
  ] as const;
  for (const [activity, one, many] of fileLabels) {
    const { calls, paths } = counts.files[activity];
    if (calls > 0) {
      segments.push(
        countLabel(
          fileCount(calls, paths),
          `chat.toolCards.group.${one}`,
          `chat.toolCards.group.${many}`,
        ),
      );
    }
  }
  if (counts.searches > 0) {
    segments.push(
      countLabel(
        counts.searches,
        "chat.toolCards.group.searchesOne",
        "chat.toolCards.group.searchesMany",
      ),
    );
  }
  if (counts.fetches > 0) {
    segments.push(
      countLabel(
        counts.fetches,
        "chat.toolCards.group.fetchesOne",
        "chat.toolCards.group.fetchesMany",
      ),
    );
  }
  if (counts.others > 0) {
    const names = [...counts.otherNames].slice(0, 2).join(", ");
    segments.push(
      counts.otherNames.size <= 2 && names
        ? t(
            counts.others > counts.otherNames.size
              ? "chat.toolCards.group.namedToolRepeated"
              : "chat.toolCards.group.namedTool",
            { names, count: String(counts.others) },
          )
        : countLabel(
            counts.others,
            "chat.toolCards.group.otherOne",
            "chat.toolCards.group.otherMany",
          ),
    );
  }

  if (segments.length === 0) {
    return countLabel(
      cards.length,
      "chat.toolCards.group.emptyOne",
      "chat.toolCards.group.emptyMany",
    );
  }
  const label = segments.join(", ");
  return label.charAt(0).toUpperCase() + label.slice(1);
}
