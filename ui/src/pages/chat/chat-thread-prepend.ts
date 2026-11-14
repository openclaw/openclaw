import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import type { MessageGroup } from "../../lib/chat/chat-types.ts";
import { buildChatItems, type BuildChatItemsProps } from "./chat-thread-build.ts";
import { displayChatHistory, type ChatItemsFacts } from "./chat-thread-facts.ts";
import type { ChatInputOrderState } from "./chat-thread-inputs.ts";
import { transcriptMessageSourceKey } from "./chat-thread-items.ts";

type RenderChatItem = ReturnType<typeof buildChatItems>[number];
type SameChatItem = (previous: RenderChatItem, next: RenderChatItem) => boolean;
/** Build facts; source keys are counted on the first prepend that needs them. */
export type PrependFacts = ChatItemsFacts & { sourceKeys?: Map<string | null, number> };

function isIdleTranscript(input: BuildChatItemsProps): boolean {
  return (
    input.stream === null &&
    input.toolMessages.length === 0 &&
    input.streamSegments.length === 0 &&
    !input.reasoning?.items.length &&
    !input.queue?.length &&
    !input.pendingInputs?.length &&
    !input.guardianNotices?.length &&
    !input.compactionStatus &&
    !input.subagentWait &&
    !input.runWorking &&
    !input.runActive &&
    !input.questionPrompts?.some((prompt) => prompt.status !== "pending")
  );
}

/** A prompt every pass treats as a turn start: grouping, tool bundles, handoffs, canvases, streaks. */
function personPrompt(item: RenderChatItem | undefined): MessageGroup["messages"][number] | null {
  const entry = item?.kind === "group" && item.role === "user" ? item.messages[0] : undefined;
  const record = asRecord(entry?.message);
  const provenance = asRecord(record?.provenance)?.kind;
  return entry &&
    record?.role === "user" &&
    provenance !== "inter_session" &&
    provenance !== "internal_system"
    ? entry
    : null;
}

function countSourceKeys(history: readonly unknown[], counts = new Map<string | null, number>()) {
  for (const message of history) {
    const key = transcriptMessageSourceKey(message);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/**
 * Builds recreate display-only messages (canvas cards, bundled tool calls), so
 * equal rows need not share objects. Retained groups and compaction dividers
 * keep the key stabilization gave them.
 */
function sameSeamItem(previous: RenderChatItem, next: RenderChatItem, same: SameChatItem): boolean {
  const rekeyed =
    next.kind === "group" || (next.kind === "divider" && next.compactionId)
      ? { ...next, key: previous.key }
      : next;
  return same(previous, rekeyed) || JSON.stringify(previous) === JSON.stringify(rekeyed);
}

const promptIndex = (items: readonly RenderChatItem[], message: unknown) =>
  items.findIndex((item) => item.kind === "group" && item.messages[0]?.message === message);

/**
 * An older page only prepends history. Rebuild the page with the first retained
 * turn as its seam (the next turn as right context) and keep every later row,
 * while nothing transcript-wide can change: display order, row keys, first
 * canvas/inline owners, indexed dividers, model-selection state, participants
 * and run prompts. Otherwise, and for live runs, return null for the full build.
 */
export function prependOlderChatItems(
  previous: { messages: readonly unknown[]; items: readonly RenderChatItem[]; facts: PrependFacts },
  input: BuildChatItemsProps,
  inputOrder: ChatInputOrderState,
  same: SameChatItem,
): { head: RenderChatItem[]; retainedFrom: number; facts: PrependFacts } | null {
  const { messages: retained, facts, items: retainedItems } = previous;
  const added = input.messages.length - retained.length;
  if (
    !facts.history ||
    added <= 0 ||
    !isIdleTranscript(input) ||
    retained.some((message, index) => message !== input.messages[added + index])
  ) {
    return null;
  }
  const anchors: { index: number; prompt: MessageGroup["messages"][number] }[] = [];
  for (let index = 1; index < retainedItems.length && anchors.length < 4; index++) {
    const prompt = personPrompt(retainedItems[index]);
    if (prompt) {
      anchors.push({ index, prompt });
    }
  }
  const cuts = anchors.map(({ prompt }) => retained.indexOf(prompt.message));
  // The retained head holds a prompt, so the seam turn enters with settled model state.
  const [, turn, next] = anchors;
  if (
    !turn ||
    !next ||
    cuts.length < 4 ||
    cuts.some((cut, index) => cut <= (cuts[index - 1] ?? 0))
  ) {
    return null;
  }
  const history = displayChatHistory(input);
  const pageLength = history.length - facts.history.length;
  if (
    pageLength < 0 ||
    facts.history.some((message, index) => message !== history[pageLength + index])
  ) {
    return null;
  }
  const pageHistory = history.slice(0, pageLength);
  const sourceKeys = (facts.sourceKeys ??= countSourceKeys(facts.history));
  const pageKeys = countSourceKeys(pageHistory);
  if ([...pageKeys.keys()].some((key) => sourceKeys.has(key))) {
    return null;
  }
  const seam = retained.slice(0, cuts[3]);
  const replyPeople = [...(input.replyPeople ?? []), ...(facts.people ?? [])];
  const probe = turn.prompt.message;
  const seamFacts: ChatItemsFacts = { firsts: new Map(), indexedDividers: [], probe };
  const pageFacts: ChatItemsFacts = { firsts: new Map(), indexedDividers: [], probe };
  const ledger: ChatInputOrderState = { keys: [] };
  // Seeding every counted participant keeps reply attribution transcript-wide.
  const before = buildChatItems(
    { ...input, messages: seam, replyPeople },
    { keys: [] },
    "transcript",
    seamFacts,
  );
  const after = buildChatItems(
    { ...input, messages: [...input.messages.slice(0, added), ...seam], replyPeople },
    ledger,
    "transcript",
    pageFacts,
  );
  const start = promptIndex(after, probe);
  const end = promptIndex(after, next.prompt.message);
  const seamStart = promptIndex(before, probe);
  const seamEnd = promptIndex(before, next.prompt.message);
  const seamTurn = before.slice(seamStart, seamEnd);
  const seamHistory = seamFacts.history ?? [];
  const ledgerStart = ledger.keys.indexOf(turn.prompt.key);
  const retainedLedgerStart = inputOrder.keys.indexOf(turn.prompt.key);
  const pageMessages = new Set(pageHistory);
  const headMessages = new Set(retained.slice(0, cuts[1]));
  const head = after.slice(0, start);
  const archived = input.archiveNotice?.key;
  const count = (counts: ReadonlyMap<string, number> | undefined, runId: string) =>
    counts?.get(runId) ?? 0;
  if (
    start < 0 ||
    seamStart < 0 ||
    seamEnd < 0 ||
    end - start !== seamTurn.length ||
    next.index - turn.index !== seamTurn.length ||
    ledgerStart < 0 ||
    retainedLedgerStart < 0 ||
    pageFacts.history?.length !== pageLength + seamHistory.length ||
    [...pageHistory, ...seamHistory].some(
      (message, index) => message !== pageFacts.history![index],
    ) ||
    [...countSourceKeys(seamHistory)].some(
      ([key, seen]) => seen > 1 !== (sourceKeys.get(key) ?? 0) > 1,
    ) ||
    seamTurn.some(
      (item, index) =>
        !sameSeamItem(item, after[start + index]!, same) ||
        !sameSeamItem(retainedItems[turn.index + index]!, item, same),
    ) ||
    pageFacts.modelBefore !== seamFacts.modelBefore ||
    [...pageFacts.firsts].some(
      ([key, message]) => pageMessages.has(message) && facts.firsts.has(key),
    ) ||
    facts.indexedDividers.some((message) => !headMessages.has(message)) ||
    // A second participant turns on reply attribution for every retained row.
    (pageFacts.people?.size ?? 0) >= 2 !== (facts.people?.size ?? 0) >= 2 ||
    // Replies to the current prompt resolve against every prompt of their run.
    [...(pageFacts.currentReplies ?? [])].some(
      (runId) =>
        count(facts.prompts, runId) !== count(seamFacts.prompts, runId) &&
        count(pageFacts.prompts, runId) < 2,
    ) ||
    [...(facts.currentReplies ?? [])].some(
      (runId) =>
        count(pageFacts.prompts, runId) !== count(seamFacts.prompts, runId) &&
        count(facts.prompts, runId) < 2,
    ) ||
    (archived !== undefined &&
      [...head, ...retainedItems.slice(0, turn.index)].some((item) => item.key === archived))
  ) {
    return null;
  }
  inputOrder.keys = [
    ...ledger.keys.slice(0, ledgerStart),
    ...inputOrder.keys.slice(retainedLedgerStart),
  ];
  for (const [key, seen] of pageKeys) {
    sourceKeys.set(key, seen);
  }
  for (const [key, message] of pageFacts.firsts) {
    if (pageMessages.has(message)) {
      facts.firsts.set(key, message);
    }
  }
  const prompts = new Map(facts.prompts);
  for (const [runId, seen] of pageFacts.prompts ?? []) {
    prompts.set(runId, seen + count(facts.prompts, runId) - count(seamFacts.prompts, runId));
  }
  return {
    head,
    retainedFrom: turn.index,
    facts: {
      ...facts,
      history,
      indexedDividers: [
        ...pageFacts.indexedDividers.filter((message) => pageMessages.has(message)),
        ...facts.indexedDividers,
      ],
      people: pageFacts.people,
      prompts,
      currentReplies: new Set([
        ...(facts.currentReplies ?? []),
        ...(pageFacts.currentReplies ?? []),
      ]),
    },
  };
}
