// Reconcile invocation projections before grouping so summaries and expanded
// cards consume the same calls, regardless of history/live delivery order.
import { readSessionMessageIdentity } from "@openclaw/gateway-client/browser";
import { asNullableRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  isToolCallContentType,
  isToolResultContentType,
} from "../../../../src/chat/tool-content.js";
import { readTranscriptDisplayPosition } from "../../../../src/chat/transcript-display-position.js";
import type { ChatItem, ToolCard } from "../../lib/chat/chat-types.ts";
import { normalizeRoleForGrouping, resolveMessageRole } from "../../lib/chat/message-normalizer.ts";
import { readPreparedActivity } from "../../lib/chat/tool-call-grouping.ts";
import { extractToolBlockCardsCached, extractToolCardsCached } from "../../lib/chat/tool-cards.ts";
import { resolveToolBlockId } from "./chat-thread-items.ts";
import { chatItemStartsDisplayTurn } from "./chat-turn-boundary.ts";
import { buildToolStreamIdentity, extractToolMessageRefs } from "./tool-stream-identity.ts";

type MessageItem = Extract<ChatItem, { kind: "message" }>;
type ProjectedItem = MessageItem & {
  message: Record<string, unknown> & { content: unknown[] };
};
type Source = {
  item: MessageItem;
  originalMessage: Record<string, unknown>;
  message: Record<string, unknown>;
  index: number;
  remaining: unknown[];
  standalone: boolean;
};
type Projection = {
  source: Source;
  block: Record<string, unknown>;
  id: string;
  runId?: string;
  name: string;
  call: boolean;
  rank: number;
};
type Invocation = {
  first: number;
  call?: Projection;
  result?: Projection;
  live?: Record<string, unknown>;
  attachments: unknown[];
  projections: Projection[];
};

type CachedBundle = { inputs: unknown[]; message: ProjectedItem["message"] };
const messagesBySource = new WeakMap<object, Map<string, CachedBundle>>();
type CachedTurn = { inputs: unknown[]; items: ChatItem[] };
// Interleaved transcript builds share the cache without evicting other owners.
const turnsByOwner = new WeakMap<object, CachedTurn>();

function resultBlock(card: ToolCard): Record<string, unknown> {
  return {
    type: "tool_result",
    id: card.callId,
    name: card.name,
    text: card.outputText ?? "",
    details: card.details,
    isError: card.isError,
    exitCode: card.exitCode,
    __openclaw: {
      id: card.resultMessageId,
      toolOutput: card.toolOutput,
      truncated: card.outputTruncated,
      ...(card.catalogTruncated ? { catalogTruncated: true } : {}),
    },
  };
}

function readProjections(item: MessageItem, index: number): Projection[] {
  let message = asRecord(item.message);
  if (!message) {
    return [];
  }
  const originalMessage = message;
  let content = Array.isArray(message.content) ? message.content : [];
  const isToolBlock = (block: unknown) => {
    const type = asRecord(block)?.type;
    return isToolCallContentType(type) || isToolResultContentType(type);
  };
  let blocks = content.filter(isToolBlock);
  const prepared = new Map<unknown, ToolCard>();
  // Resolve no-id fallback once through the card owner. Keep anonymous pairs
  // in the source while identified siblings still join the invocation registry.
  if (blocks.some((block) => !resolveToolBlockId(asRecord(block)!, message!))) {
    const pending = [...extractToolCardsCached(message)];
    content = content.flatMap((block) => {
      if (!isToolBlock(block)) {
        return [block];
      }
      const raw = asRecord(block)!;
      const id = resolveToolBlockId(raw, message!);
      const call = isToolCallContentType(raw.type);
      const cardIndex = pending.findIndex(
        (card) => call === Object.hasOwn(card, "args") && (!id || card.callId === id),
      );
      if (cardIndex < 0) {
        return [];
      }
      const card = pending.splice(cardIndex, 1)[0]!;
      const fields = { id: card.callId, name: card.name, details: card.details };
      const resolved = [
        ...(call ? [{ ...raw, ...fields, arguments: card.args }] : []),
        ...(!call || card.completed || card.outputText !== undefined ? [resultBlock(card)] : []),
      ];
      resolved.forEach((projection) => prepared.set(projection, card));
      return resolved;
    });
    message = { ...message, content };
    blocks = content.filter(
      (block) => isToolBlock(block) && resolveToolBlockId(asRecord(block)!, message!),
    );
    if (blocks.length === 0) {
      return [];
    }
  }
  const standalone = blocks.length === 0;
  if (standalone) {
    const [card] = extractToolCardsCached(message);
    if (!card?.callId) {
      return [];
    }
    blocks = [resultBlock(card)];
    prepared.set(blocks[0], card);
  }
  const source: Source = {
    item,
    originalMessage,
    message,
    index,
    standalone,
    remaining: content.filter(
      (block) => !blocks.includes(block) && (!standalone || asRecord(block)?.type !== "text"),
    ),
  };
  return blocks.map((block) => {
    const raw = asRecord(block)!;
    const id = resolveToolBlockId(raw, message)!;
    const call = isToolCallContentType(raw.type);
    const live = message["__openclawToolStreamLive"] === true;
    const card = prepared.get(raw) ?? extractToolBlockCardsCached(originalMessage, raw)[0];
    return {
      source,
      id,
      call,
      runId:
        normalizeOptionalString(raw.runId) ??
        readSessionMessageIdentity(message)?.runId ??
        normalizeOptionalString(message.runId),
      name:
        normalizeOptionalString(raw.name) ??
        normalizeOptionalString(message.toolName) ??
        normalizeOptionalString(message.tool_name) ??
        "tool",
      // Durable results outrank live terminal snapshots, which outrank partial
      // updates. A late partial replay must not resurrect a completed call.
      rank: call
        ? live
          ? 1
          : 2
        : !live
          ? 3
          : message["__openclawToolStreamResultReceived"] === true
            ? 2
            : 1,
      block: {
        ...raw,
        id,
        ...(call
          ? { arguments: card?.args }
          : {
              text: card?.outputText,
              // Preserve the result owner when the call becomes the grouped row.
              __openclaw: {
                id: card?.resultMessageId,
                toolOutput: card?.toolOutput,
                truncated: card?.outputTruncated,
                ...(card?.catalogTruncated ? { catalogTruncated: true } : {}),
              },
            }),
        ...(card?.details !== undefined ? { details: card.details } : {}),
        ...(!call && card?.isError !== undefined ? { isError: card.isError } : {}),
        ...(!call && card?.exitCode !== undefined ? { exitCode: card.exitCode } : {}),
      },
    };
  });
}

function preferProjection(previous: Projection | undefined, next: Projection): Projection {
  if (!previous) {
    return next;
  }
  const [fallback, preferred] = next.rank >= previous.rank ? [previous, next] : [next, previous];
  const details = asRecord(fallback.block.details);
  const preferredDetails = asRecord(preferred.block.details);
  return {
    ...preferred,
    name: preferred.name === "tool" ? fallback.name : preferred.name,
    block: {
      ...Object.fromEntries(
        Object.entries(fallback.block).filter(([, value]) => value !== undefined),
      ),
      ...Object.fromEntries(
        Object.entries(preferred.block).filter(([, value]) => value !== undefined),
      ),
      ...(details && preferredDetails ? { details: { ...details, ...preferredDetails } } : {}),
      // Payload aliases must not let stale text outrank a newer content/input.
      ...(preferred.call
        ? { arguments: preferred.block.arguments ?? fallback.block.arguments }
        : { text: preferred.block.text }),
    },
  };
}

function coalesceTurn(items: ChatItem[]): ChatItem[] {
  const projections = items.flatMap((item, index) =>
    item.kind === "message" ? readProjections(item, index) : [],
  );
  if (projections.length === 0) {
    return items;
  }
  const runs = new Map<string, Set<string>>();
  // Resolve missing-run ownership from the entire turn, not the prefix seen
  // so far: a later sibling with a reused id makes unscoped history ambiguous.
  for (const item of items) {
    if (item.kind !== "message") {
      continue;
    }
    for (const ref of extractToolMessageRefs(item.message)) {
      if (ref.runId) {
        const owners = runs.get(ref.id) ?? new Set<string>();
        owners.add(ref.runId);
        runs.set(ref.id, owners);
      }
    }
  }
  const identity = (projection: Projection) => {
    const owners = runs.get(projection.id);
    projection.runId ??= owners?.size === 1 ? owners.values().next().value : undefined;
    return buildToolStreamIdentity(projection.runId ?? "", projection.id);
  };
  const names = new Map<string, Set<string>>();
  for (const projection of projections) {
    const key = identity(projection);
    const known = names.get(key) ?? new Set<string>();
    if (projection.name !== "tool") {
      known.add(projection.name.toLowerCase());
    }
    names.set(key, known);
  }
  const invocations = new Map<string, Invocation>();
  const sources = new Map<number, Source>();
  for (const projection of projections) {
    sources.set(projection.source.index, projection.source);
    const key = identity(projection);
    const knownNames = names.get(key)!;
    const name =
      projection.name === "tool" && knownNames.size === 1
        ? knownNames.values().next().value
        : projection.name.toLowerCase();
    const invocationKey = JSON.stringify([key, name]);
    const invocation = invocations.get(invocationKey) ?? {
      first: projection.source.index,
      attachments: [],
      projections: [],
    };
    invocation.projections.push(projection);
    const kind = projection.call ? "call" : "result";
    invocation[kind] = preferProjection(invocation[kind], projection);
    if (projection.source.message["__openclawToolStreamLive"] === true) {
      invocation.live = projection.source.message;
    }
    if (projection.source.standalone) {
      // Attachment pixels follow the winning result too; a live omission must
      // not survive beside its persisted image or return on a late tool event.
      if (invocation.result?.source === projection.source) {
        invocation.attachments = projection.source.remaining;
      }
      projection.source.remaining = [];
    }
    invocations.set(invocationKey, invocation);
  }
  const rows = new Map<number, ProjectedItem[]>();
  const bundles = new Map<string, { item: ProjectedItem; index: number; inputs: unknown[] }>();
  const memoInputs = new Map<ProjectedItem, { owner: object; inputs: unknown[] }>();
  // Commentary beside a call always splits into its own row, even when the
  // call needs no merging, so no tool row renders outside its activity group.
  const unchanged = new Set(
    [...sources.values()].filter(({ remaining }) => remaining.length === 0),
  );
  for (const invocation of invocations.values()) {
    const owners = new Set(invocation.projections.map((projection) => projection.source));
    if (
      owners.size > 1 ||
      invocation.projections.length >
        Number(Boolean(invocation.call)) + Number(Boolean(invocation.result))
    ) {
      owners.forEach((source) => unchanged.delete(source));
    }
  }
  for (const invocation of invocations.values()) {
    const owner = invocation.call ?? invocation.result!;
    if (unchanged.has(owner.source)) {
      continue;
    }
    const message = owner.source.message;
    const metadata = asRecord(message["__openclaw"]);
    // History already composed durable activity. An earlier live echo must not
    // drag it across an intervening stream or above its parent call.
    const index = readTranscriptDisplayPosition(metadata?.transcriptPosition)?.activity
      ? owner.source.index
      : invocation.first;
    const result = invocation.result;
    const resultReceived = result !== undefined && result.rank > 1;
    const itemEnded = invocation.live?.["__openclawToolStreamItemEnded"] === true;
    const completed = resultReceived || itemEnded;
    const transcript =
      message.messageId ??
      metadata?.id ??
      result?.source.message.messageId ??
      asRecord(result?.source.message["__openclaw"])?.id;
    const content = [
      ...(invocation.call ? [{ ...invocation.call.block, name: invocation.call.name }] : []),
      ...(result ? [{ ...result.block, name: invocation.call?.name ?? result.name }] : []),
      ...invocation.attachments,
    ];
    // Batch only calls with the same message-scoped rendering metadata. Separate
    // result refs or completion states need separate rows, never sibling flags.
    // Prose between calls also separates them, so it keeps its position below.
    const ownerContent = Array.isArray(owner.source.message.content)
      ? owner.source.message.content
      : [];
    const ownerAt = ownerContent.findIndex(
      (block) => resolveToolBlockId(asRecord(block) ?? {}, owner.source.message) === owner.id,
    );
    const proseBefore = ownerContent
      .slice(0, Math.max(0, ownerAt))
      .filter((block) => owner.source.remaining.includes(block)).length;
    const renderingKey = JSON.stringify([
      proseBefore,
      owner.runId,
      Boolean(invocation.live),
      completed,
      resultReceived,
      itemEnded,
      transcript,
      invocation.live?.["__openclawToolStreamDiffStat"],
      invocation.live?.["__openclawToolStreamLiveOutput"],
      invocation.live?.["__openclawToolStreamReceivedAt"],
      (names.get(identity(owner))?.size ?? 0) > 1 ? owner.name : undefined,
    ]);
    const bundleKey = `${owner.source.index}:${renderingKey}`;
    const inputs = [
      renderingKey,
      identity(owner),
      owner.name,
      ...invocation.projections.flatMap(({ source }) => [
        source.originalMessage,
        ...(Array.isArray(source.originalMessage.content)
          ? source.originalMessage.content
          : [source.originalMessage.content]),
      ]),
    ];
    const bundle = bundles.get(bundleKey);
    const prepared = new Map<string, ReturnType<typeof readPreparedActivity>[number]>();
    const activitySources = [message, invocation.live, result?.source.message];
    // An empty prepared projection means hidden calls; sources without one keep raw cards.
    const ownsActivity = activitySources.some((source) =>
      Array.isArray(asRecord(source)?.activity),
    );
    for (const source of activitySources) {
      const activityItems = readPreparedActivity(source).filter(
        (activity) =>
          (activity.toolCallId ?? activity.itemId) === owner.id &&
          !activity.suppressChannelProgress,
      );
      if (
        source === result?.source.message &&
        Array.isArray(asRecord(source)?.activity) &&
        activityItems.length === 0
      ) {
        prepared.clear();
      }
      for (const activity of activityItems) {
        const previous = prepared.get(activity.itemId);
        // Only an explicitly unpaired history call yields to live progress.
        // A real terminal receipt stays terminal even when its outcome is unknown.
        if (previous?.phase !== "end" || previous.unpairedCall || activity.phase === "end") {
          prepared.set(activity.itemId, activity);
        }
      }
    }
    if (bundle) {
      bundle.inputs.push(...inputs);
      bundle.item.message.content.push(...content);
      if (invocation.attachments.length > 0) {
        bundle.item.message.role = "toolResult";
      }
      if (ownsActivity || Array.isArray(bundle.item.message.activity)) {
        bundle.item.message.activity = [
          ...readPreparedActivity(bundle.item.message),
          ...prepared.values(),
        ];
      }
      bundle.index = Math.min(bundle.index, index);
      continue;
    }
    const item: ProjectedItem = {
      ...owner.source.item,
      key: `${owner.source.item.key}:invocation:${identity(owner)}:${owner.name}`,
      message: {
        ...message,
        // Result media stays tool-owned when the invocation moves to its call row.
        role:
          invocation.attachments.length > 0
            ? "toolResult"
            : invocation.call
              ? "assistant"
              : message.role,
        runId: owner.runId,
        content,
        activity: ownsActivity ? [...prepared.values()] : undefined,
        ...(transcript ? { messageId: transcript } : {}),
        ...(invocation.live
          ? {
              __openclawToolStreamLive: true,
              __openclawToolStreamResultReceived: resultReceived,
              __openclawToolStreamItemEnded: itemEnded,
              __openclawToolStreamLiveOutput: completed
                ? undefined
                : invocation.live["__openclawToolStreamLiveOutput"],
              __openclawToolStreamDiffStat: completed
                ? undefined
                : invocation.live["__openclawToolStreamDiffStat"],
              __openclawToolStreamReceivedAt: invocation.live["__openclawToolStreamReceivedAt"],
            }
          : {}),
      },
    };
    bundles.set(bundleKey, { item, index, inputs });
    memoInputs.set(item, { owner: owner.source.originalMessage, inputs });
  }
  for (const { item, index } of bundles.values()) {
    const row = rows.get(index) ?? [];
    row.push(item);
    rows.set(index, row);
  }
  const result = items.flatMap((item, index) => {
    const source = sources.get(index);
    if (!source || unchanged.has(source)) {
      return [item];
    }
    const row = rows.get(index) ?? [];
    if (source.remaining.length === 0) {
      return row;
    }
    // Prose and media keep their original position as their own rows, so
    // commentary never carries a tool call: every call joins the tool rows
    // that its activity group summarizes.
    const prose = (content: unknown[], segment: number): ProjectedItem => {
      const projected: ProjectedItem = {
        ...source.item,
        key: segment === 0 ? source.item.key : `${source.item.key}:prose:${segment}`,
        message: {
          ...source.message,
          content,
          activity: undefined,
          toolCallId: undefined,
          tool_call_id: undefined,
          toolUseId: undefined,
          tool_use_id: undefined,
          toolName: undefined,
          tool_name: undefined,
        },
      };
      // Prose belongs to the same immutable source as its invocation projection.
      memoInputs.set(projected, {
        owner: source.originalMessage,
        inputs: [source.originalMessage, source.originalMessage.content],
      });
      return projected;
    };
    const ordered: ProjectedItem[] = [];
    let pendingProse: unknown[] = [];
    const flushProse = () => {
      if (pendingProse.length > 0) {
        ordered.push(prose(pendingProse, ordered.length));
        pendingProse = [];
      }
    };
    const unplaced = new Set(row);
    for (const block of Array.isArray(source.message.content) ? source.message.content : []) {
      if (source.remaining.includes(block)) {
        pendingProse.push(block);
        continue;
      }
      const raw = asRecord(block) ?? {};
      const id = resolveToolBlockId(raw, source.message);
      const target = [...unplaced].find((entry) =>
        entry.message.content.some((part) => {
          const record = asRecord(part);
          return record?.id === id && (!raw.name || raw.name === record?.name);
        }),
      );
      if (target) {
        flushProse();
        ordered.push(target);
        unplaced.delete(target);
      }
    }
    flushProse();
    return [...ordered, ...unplaced];
  });
  // Assembly and prose/media interleaving are complete. Only messages are
  // reused: duplicate grouping can still mutate the returned item wrappers.
  const nextBySource = new Map<object, Map<string, CachedBundle>>();
  for (const [item, { owner, inputs }] of memoInputs) {
    inputs.push(item.message.content.length);
    for (const block of item.message.content) {
      const raw = asRecord(block);
      if (isToolCallContentType(raw?.type) || isToolResultContentType(raw?.type)) {
        inputs.push(raw?.type, raw?.id, raw?.name);
      } else {
        inputs.push(block);
      }
    }
    const cached = messagesBySource.get(owner)?.get(item.key);
    if (
      cached?.inputs.length === inputs.length &&
      inputs.every((input, index) => input === cached.inputs[index])
    ) {
      item.message = cached.message;
    }
    const next = nextBySource.get(owner) ?? new Map<string, CachedBundle>();
    next.set(item.key, { inputs, message: item.message });
    nextBySource.set(owner, next);
  }
  for (const [owner, next] of nextBySource) {
    messagesBySource.set(owner, next);
  }
  return result;
}

export function coalesceToolActivityMessages(
  items: ChatItem[],
  hiddenKeys?: ReadonlySet<string>,
): ChatItem[] {
  const result: ChatItem[] = [];
  const appendTurn = (turn: ChatItem[]) => {
    if (turn.length === 0) {
      return;
    }
    const inputs: unknown[] = [];
    let owner: object | undefined;
    for (const item of turn) {
      const message = item.kind === "message" ? asRecord(item.message) : null;
      // Transient wrappers carry independently changing stream/attribution facts.
      if (item.kind !== "message" || !message || message["__openclawToolStreamLive"] === true) {
        result.push(...coalesceTurn(turn));
        return;
      }
      owner ??= message;
      inputs.push(item.kind, item.key, message, item.startsTurn);
      // Preserve the content-replacement contract of the tool-card owner too.
      inputs.push(message.content);
      if (Array.isArray(message.content)) {
        inputs.push(...message.content);
      }
    }
    const cached = turnsByOwner.get(owner!);
    const entry =
      cached?.inputs.length === inputs.length &&
      inputs.every((input, index) => input === cached.inputs[index])
        ? cached
        : // coalesceTurn can return caller wrappers; store copies so later annotations stay out.
          { inputs, items: coalesceTurn(turn).map((item) => Object.assign({}, item)) };
    turnsByOwner.set(owner!, entry);
    // Grouping annotates wrappers, so stored wrappers are never returned.
    for (const item of entry.items) {
      result.push({ ...item });
    }
  };
  let turn: ChatItem[] = [];
  for (const item of items) {
    const boundary = chatItemStartsDisplayTurn(item) || item.kind === "divider";
    if (boundary) {
      appendTurn(turn);
      turn = [];
    }
    // Hidden rows still delimit turns: reused call ids must never pair across
    // a prompt or forwarded input removed by transcript search.
    if (hiddenKeys?.has(item.key)) {
      continue;
    }
    if (
      boundary &&
      (item.kind !== "message" ||
        normalizeRoleForGrouping(resolveMessageRole(item.message)) === "user")
    ) {
      result.push(item);
      continue;
    }
    // A projected output starts the new turn and still owns its tool calls.
    turn.push(item);
  }
  appendTurn(turn);
  return result;
}

/**
 * A run that ends or hands off swaps its live tool rows for their stored
 * copies, which arrive under other message keys. Disclosure ids stay scoped to
 * their message, so what the reader had opened is carried across by tool call,
 * and only where one disclosure names that call on each side.
 */
export function carryMovedDisclosures(
  state: { expanded: Map<string, boolean>; explicit: ReadonlySet<string> },
  previous: ReadonlyMap<string, string> | undefined,
  current: ReadonlyMap<string, string>,
  // The expansion owner records versions and explicit choices through its writer.
  writeExpansion: (
    values: Map<string, boolean>,
    key: string,
    open: boolean,
    explicit: boolean,
  ) => void,
): void {
  if (!previous) {
    return;
  }
  const { expanded, explicit } = state;
  const single = (calls: ReadonlyMap<string, string>) => {
    const ids = new Map<string, string | null>();
    for (const [id, call] of calls) {
      ids.set(call, ids.has(call) ? null : id);
    }
    return ids;
  };
  const targets = single(current);
  for (const [call, source] of single(previous)) {
    const target = targets.get(call);
    const open = source ? expanded.get(source) : undefined;
    if (!source || !target || current.has(source) || explicit.has(target) || open === undefined) {
      continue;
    }
    writeExpansion(expanded, target, open, explicit.has(source));
  }
}
