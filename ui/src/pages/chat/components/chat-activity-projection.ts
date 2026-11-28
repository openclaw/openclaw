import { safeParseJsonRecord } from "@openclaw/normalization-core/json-coercion";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { readNodePermissionRequest } from "../../../../../packages/gateway-protocol/src/node-permissions.js";
import {
  unwrapToolCallForDisplay,
  unwrapToolResultTextForDisplay,
} from "../../../../../src/agents/tool-display-call.js";
import { groupToolCalls } from "../../../../../src/chat/tool-call-grouping.js";
import { readCollectionErrorCount } from "../../../../../src/shared/subagent-completion.js";
import type {
  ChatCompaction,
  MessageGroup as MessageGroupData,
  ToolCard,
} from "../../../lib/chat/chat-types.ts";
import {
  isStandaloneToolMessageForDisplay,
  normalizeMessage,
} from "../../../lib/chat/message-normalizer.ts";
import { resolveMessageVisibleContent } from "../../../lib/chat/message-visibility.ts";
import { readPreparedActivity } from "../../../lib/chat/tool-call-grouping.ts";
import { extractToolCardsCached, resolveToolCardOutcome } from "../../../lib/chat/tool-cards.ts";
import {
  resolveSessionLaunchPresentation,
  readSubagentCancellation,
} from "../chat-spawned-subagent.ts";
import type { SystemEventRenderItem } from "../chat-system-event-grouping.ts";
import { persistedMessageEntryId } from "../chat-thread-items.ts";
import { transcriptRunId } from "../chat-thread-run-identity.ts";
import { isActivityMessageGroup } from "../chat-turn-presentation.ts";
import {
  isInvocationContainer,
  isInlineCommandCard,
  isStandaloneActivity,
  descendantCards,
  projectActivityOperations,
} from "./chat-activity-operations.ts";
import type {
  ActivityOperationGroup,
  ActivityOperationProps,
  ActivityOperationContext,
} from "./chat-message-bubble-options.ts";
import {
  resolveFileLinkOwnerOptions,
  type NativeMessageGroupOptions,
} from "./chat-message-group-options.ts";

function activityEntryGroupKey(
  group: MessageGroupData,
  entry: MessageGroupData["messages"][number],
): string {
  return entry === group.messages[0] ? group.key : `${group.key}:${entry.key}`;
}

export type ProjectedActivity = ReturnType<typeof readPreparedActivity>[number] & {
  compaction?: ChatCompaction;
  sourceOrder?: number;
};

export function collectActivityGroup(
  groups: readonly MessageGroupData[],
  opts: NativeMessageGroupOptions,
) {
  const shownGroups =
    opts.showToolCalls === false ? groups.filter((group) => group.compaction) : groups;
  const firstGroup = groups[0];
  if (!firstGroup || !shownGroups.length) {
    return undefined;
  }
  const entries = shownGroups.flatMap((group) => group.messages);
  const cards: ToolCard[] = [];
  const toolContexts = new Map<ToolCard, ActivityOperationContext>();
  const preparedByCard = new Map<ToolCard, ReturnType<typeof readPreparedActivity>[number]>();
  const currentRunActivity = new Set<ReturnType<typeof readPreparedActivity>[number]>();
  const preparedByCall = new Map<string, ReturnType<typeof readPreparedActivity>[number]>();
  const suppressedCards = new Set<ToolCard>();
  const activityKeys = new Map<ReturnType<typeof readPreparedActivity>[number], string>();
  const activity = shownGroups.flatMap<ProjectedActivity>((group, sourceOrder) => {
    if (group.compaction) {
      const compaction = group.compaction;
      const item: ProjectedActivity = {
        compaction,
        sourceOrder,
        itemId: group.key,
        kind: "compaction",
        phase: compaction.phase === "active" ? "start" : "end",
        status: compaction.phase === "active" ? "running" : "completed",
        title: compaction.label,
      };
      activityKeys.set(item, group.key);
      if (compaction.phase === "active" || (opts.runActive && group.runId === opts.activityRunId)) {
        currentRunActivity.add(item);
      }
      return [item];
    }
    return group.messages.flatMap((entry) => {
      const prepared = readPreparedActivity(entry.message);
      const fileOptions = resolveFileLinkOwnerOptions(
        group,
        opts,
        persistedMessageEntryId(entry.message) ?? undefined,
      );
      if (
        opts.runActive &&
        opts.activityRunId &&
        (opts.activityGroupKey === undefined ||
          groups.some((candidate) => candidate.key === opts.activityGroupKey)) &&
        transcriptRunId(entry.message) === opts.activityRunId
      ) {
        prepared.forEach((item) => currentRunActivity.add(item));
      }
      const runId = transcriptRunId(entry.message);
      const localPrepared = new Map(prepared.map((item) => [item.toolCallId, item]));
      for (const item of prepared) {
        activityKeys.set(
          item,
          JSON.stringify([runId ?? entry.key, item.toolCallId ?? item.itemId]),
        );
        if (item.toolCallId) {
          preparedByCall.set(JSON.stringify([runId, item.toolCallId]), item);
        }
      }
      for (const [index, card] of extractToolCardsCached(entry.message).entries()) {
        cards.push(card);
        toolContexts.set(card, {
          messageKey: entry.key,
          sourceOrder,
          runId: card.runId ?? runId,
          disclosureId: `${entry.key}:toolcard:${index}`,
          onOpenWorkspaceFile: fileOptions.onOpenWorkspaceFile,
        });
        const local = card.callId ? localPrepared.get(card.callId) : undefined;
        if (local) {
          preparedByCard.set(card, local);
        } else if (Array.isArray(asNullableRecord(entry.message)?.activity)) {
          suppressedCards.add(card);
        }
      }
      return prepared;
    });
  });
  for (const card of cards) {
    const item = card.callId
      ? preparedByCall.get(JSON.stringify([toolContexts.get(card)!.runId, card.callId]))
      : undefined;
    if (item) {
      preparedByCard.set(card, item);
    }
  }
  // Successful waits are transport coordination, not completed narration. Per-ID
  // errors (not found, not owned) have no completion row, so their wait stays.
  const errorWaits = new Set<ReturnType<typeof readPreparedActivity>[number]>();
  for (const card of cards) {
    if (
      unwrapToolCallForDisplay(card).name.trim().toLowerCase() !== "agents_wait" ||
      resolveToolCardOutcome(card, opts.runActive) !== "succeeded"
    ) {
      continue;
    }
    // Live results carry the errors; persisted ones may keep only the compact count.
    const recorded = card.subagentCollectionErrors;
    const live = readCollectionErrorCount({
      ...safeParseJsonRecord(unwrapToolResultTextForDisplay(card.outputText ?? "")),
      ...asNullableRecord(card.details),
    });
    if (recorded || live) {
      const item = preparedByCard.get(card);
      if (item) {
        errorWaits.add(item);
      }
    } else {
      suppressedCards.add(card);
    }
  }
  const roots = groupToolCalls(cards);
  const projection = projectActivityOperations(roots, preparedByCard, suppressedCards);
  const hiddenActivity = new Set(
    [...(projection?.hidden ?? [])].flatMap((card) => {
      const item = preparedByCard.get(card);
      return item && item.status !== "failed" && item.status !== "blocked" ? [item] : [];
    }),
  );
  const visibleActivity = activity.filter(
    (item) =>
      !hiddenActivity.has(item) &&
      !item.hideFromChannelProgress &&
      !item.suppressChannelProgress &&
      !(item.name === "agents_wait" && item.status === "completed" && !errorWaits.has(item)),
  );
  const cardGroups = projection.groups;
  const order = new Map(cards.map((card, index) => [card, index]));
  cardGroups.sort((left, right) => order.get(left.card)! - order.get(right.card)!);
  const original = [...roots];
  for (const group of original) {
    original.push(...group.children);
  }
  original.sort((a, b) => order.get(a.card)! - order.get(b.card)!);
  const actionOrder = new Map(
    original
      .filter((group) => !(group.children.length && isInvocationContainer(group)))
      .map((group, index) => [group.card, index]),
  );
  const activityOrder = new Map(activity.map((item, index) => [item, index]));
  const representedActivity = new Set(
    [...preparedByCard.values()].map((item) => activityKeys.get(item)),
  );
  const toolCardOverrides = new Map<ToolCard, ActivityOperationProps | null>();
  for (const card of projection.hidden) {
    toolCardOverrides.set(card, null);
  }
  for (const group of cardGroups) {
    for (const card of descendantCards(group)) {
      toolCardOverrides.set(card, null);
    }
    if (group.children.length > 0 || group.executionCards?.length) {
      toolCardOverrides.set(group.card, { group, options: opts, contexts: toolContexts });
    }
  }
  const unmatchedActivity = [
    ...new Map(
      visibleActivity
        .filter((item) => !representedActivity.has(activityKeys.get(item)))
        .map((item) => [activityKeys.get(item), item]),
    ).values(),
  ];
  return {
    toolCardOverrides,
    unmatchedActivity,
    firstGroup,
    entries,
    cards,
    toolContexts,
    preparedByCard,
    currentRunActivity,
    activityKeys,
    visibleActivity,
    cardGroups,
    activityOrder,
    actionOrder,
  };
}

export type ActivityGroupData = NonNullable<ReturnType<typeof collectActivityGroup>>;

type ActivityEntry = { key: string } & (
  | { operation: ActivityOperationProps; activity?: never; message?: never }
  | {
      activity: ProjectedActivity;
      operation?: never;
      message?: never;
    }
  | {
      message: {
        group: MessageGroupData;
        overrides: ReadonlyMap<ToolCard, ActivityOperationProps | null>;
        operations: ActivityOperationGroup[];
      };
      operation?: never;
      activity?: never;
    }
);

type ActivityStructure = Pick<
  NonNullable<ReturnType<typeof collectActivityGroup>>,
  | "firstGroup"
  | "cardGroups"
  | "toolContexts"
  | "unmatchedActivity"
  | "activityKeys"
  | "actionOrder"
> & {
  toolCardOverrides: ReadonlyMap<ToolCard, ActivityOperationProps | null>;
};

export function segmentActivityGroup<State extends ActivityStructure>(
  groups: readonly MessageGroupData[],
  options: NativeMessageGroupOptions,
  state: State,
  inlineCommands = Boolean(options.inlineCommands),
) {
  // Keyed entries can still render the previous snapshot while their parent updates.
  // Operations and their object-keyed maps belong to the same projection.
  const context = { state, groups, options };
  const result: Array<{
    key: string;
    standalone: boolean;
    inline?: boolean;
    lifecycle?: "launch" | "stop";
    coalescible?: boolean;
    lastAction?: number;
    runId?: string;
    entries: ActivityEntry[];
    context: typeof context;
  }> = [];
  const append = (item: ActivityEntry, standalone: boolean, inline: boolean, key: string) => {
    const operation =
      item.operation?.group ??
      (item.message?.operations.length === 1 ? item.message.operations[0] : undefined);
    const outcome = operation && resolveToolCardOutcome(operation.card, options.runActive);
    const launch = operation && resolveSessionLaunchPresentation(operation.card, outcome);
    const permission =
      operation &&
      readNodePermissionRequest(asNullableRecord(operation.card.details)?.permissionMissing);
    const lifecycle = permission
      ? undefined
      : launch?.kind === "subagent"
        ? ("launch" as const)
        : operation && readSubagentCancellation(operation.card)
          ? ("stop" as const)
          : undefined;
    const previous = result.at(-1);
    const coalescible =
      (launch
        ? launch.phase === "running" || launch.phase === "succeeded"
        : outcome === "running") ||
      Boolean(operation && readSubagentCancellation(operation.card)?.stopped);
    const action = operation && state.actionOrder.get(operation.card);
    const runId = operation && state.toolContexts.get(operation.card)?.runId;
    if (
      lifecycle &&
      coalescible &&
      previous?.coalescible &&
      previous.lifecycle === lifecycle &&
      action !== undefined &&
      previous.lastAction === action - 1 &&
      previous.runId === runId
    ) {
      previous.entries.push(item);
      previous.lastAction = action;
      return;
    }
    if (!standalone && previous && !previous.standalone && previous.inline === inline) {
      previous.entries.push(item);
    } else {
      result.push({
        key,
        context,
        standalone,
        inline,
        lifecycle,
        coalescible,
        lastAction: action,
        runId,
        entries: [item],
      });
    }
  };
  const byMessage = new Map<string, ActivityOperationGroup[]>();
  for (const operation of context.state.cardGroups) {
    const key = context.state.toolContexts.get(operation.card)!.messageKey;
    const operations = byMessage.get(key) ?? [];
    operations.push(operation);
    byMessage.set(key, operations);
  }
  const unmatched = new Set(context.state.unmatchedActivity);
  for (const group of context.groups) {
    if (group.compaction) {
      const activity = context.state.unmatchedActivity.find(
        (item) => item.itemId === group.key && item.compaction,
      )!;
      append({ key: group.key, activity }, false, false, group.key);
      continue;
    }
    if (context.options.showToolCalls === false) {
      continue;
    }
    for (const entry of group.messages) {
      const operations = byMessage.get(entry.key) ?? [];
      if (
        !operations.length &&
        readPreparedActivity(entry.message).some((item) => item.name === "agents_wait")
      ) {
        const previous = result.at(-1);
        if (previous) {
          previous.coalescible = false;
        }
      }
      // A mixed command/edit envelope keeps its native inline presentation.
      const inline =
        inlineCommands && operations.some((operation) => isInlineCommandCard(operation.card));
      const nativeMessage =
        operations.length > 0 &&
        isStandaloneToolMessageForDisplay(entry.message) &&
        !operations.some(
          (operation) =>
            resolveSessionLaunchPresentation(operation.card) !== null ||
            readSubagentCancellation(operation.card) !== null,
        );
      if (nativeMessage) {
        const standalone = operations.some((operation) => isStandaloneActivity(operation.card));
        append(
          {
            key: entry.key,
            message: {
              group: { ...group, messages: [entry] },
              overrides: context.state.toolCardOverrides,
              operations,
            },
          },
          standalone,
          inline,
          standalone ? entry.key : activityEntryGroupKey(group, entry),
        );
      } else {
        for (const [index, operation] of operations.entries()) {
          const standalone = isStandaloneActivity(operation.card);
          const key = context.state.toolContexts.get(operation.card)!.disclosureId;
          append(
            {
              key,
              operation: {
                group: operation,
                options: context.options,
                contexts: context.state.toolContexts,
              },
            },
            standalone,
            inline,
            standalone || index > 0 ? key : activityEntryGroupKey(group, entry),
          );
        }
      }
      for (const activity of readPreparedActivity(entry.message).filter((item) =>
        unmatched.has(item),
      )) {
        append(
          { key: context.state.activityKeys.get(activity)!, activity },
          isStandaloneActivity({ id: activity.itemId, name: activity.name ?? "", activity }),
          false,
          `${entry.key}:activity`,
        );
      }
      const visibleContent = nativeMessage
        ? null
        : resolveMessageVisibleContent(entry.message, normalizeMessage(entry.message));
      if (
        !nativeMessage &&
        (visibleContent === "non-text" ||
          (visibleContent === "text" && !isStandaloneToolMessageForDisplay(entry.message)))
      ) {
        result.push({
          key: `${entry.key}:output`,
          context,
          standalone: true,
          entries: [
            {
              key: `${entry.key}:output`,
              message: {
                group: { ...group, messages: [entry] },
                overrides: new Map(
                  [...context.state.toolContexts.keys()].map((card) => [card, null]),
                ),
                operations: [],
              },
            },
          ],
        });
      }
    }
  }
  // Appending a lifecycle card must not close the activity the reader already opened.
  if (result[0] && !result[0].standalone) {
    result[0].key = context.state.firstGroup.key;
  }
  return result;
}

/** Expansion and rendering use the same visible segments, including lifecycle barriers. */
export function* activityDisclosureCalls(
  items: readonly SystemEventRenderItem[],
  bubbleMode = false,
  inlineCommands = false,
): Iterable<readonly [string, string]> {
  for (const item of items) {
    if (item.kind === "agent-run-frame") {
      yield* activityDisclosureCalls(item.parts, bubbleMode, inlineCommands);
      continue;
    }
    const activityGroups =
      item.kind === "activity-run"
        ? [item.groups]
        : (item.kind === "work-group" ? item.groups : item.kind === "group" ? [item] : [])
            .filter((group) => isActivityMessageGroup(group, bubbleMode))
            .map((group) => [group]);
    for (const groups of activityGroups) {
      const options = { showReasoning: false, bubbleMode };
      const state = collectActivityGroup(groups, options);
      if (!state) {
        continue;
      }
      for (const segment of segmentActivityGroup(groups, options, state, inlineCommands)) {
        if (segment.standalone && !segment.lifecycle) {
          continue;
        }
        const entry = segment.entries[0]!;
        const operation = entry.operation?.group ?? entry.message?.operations[0];
        // The first disclosure retains its original invocation when a wrapper gains children.
        const card =
          segment.key === state.firstGroup.key
            ? (operation?.executionCards?.[0] ?? operation?.card)
            : operation?.card;
        const prepared = entry.activity;
        const identity = card?.callId
          ? JSON.stringify([card.runId ?? state.toolContexts.get(card)?.runId, card.callId])
          : prepared?.toolCallId
            ? state.activityKeys.get(prepared)
            : undefined;
        if (identity) {
          const kind = segment.lifecycle ? "lifecycle" : "activity";
          yield [`${kind}:${segment.key}`, `${kind}:${identity}`];
        }
      }
    }
  }
}
