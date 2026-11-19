import { createMemo, For, Show } from "solid-js";
import type { AgentActivityItem } from "../../../../../packages/gateway-protocol/src/schema/logs-chat.js";
import { Icon } from "../../../components/solid/icon.tsx";
import { registerChatToolLabelsEnglish } from "../../../i18n/locales/en-chat-tool-labels.ts";
import { resolveToolCardOutcome } from "../../../lib/chat/tool-cards.ts";
import { resolveToolDisplayIcon } from "../../../lib/chat/tool-display-icon.ts";
import { resolveToolDisplayIdentity } from "../../../lib/chat/tool-display-identity.ts";
import { t, getLocale, registerEnglishCatalog } from "../../../lib/reactive/i18n.ts";
import {
  addressedSession,
  resolveSessionLaunchPresentation,
  resolveSpawnedSubagent,
  readSubagentCancellation,
} from "../chat-spawned-subagent.ts";
import { descendantCards } from "./chat-activity-operations.ts";
import type { ActivityOperationProps } from "./chat-message-bubble-options.ts";
import { ChatToolIcon } from "./chat-tool-card-chrome.tsx";
import { ChatToolCard } from "./chat-tool-cards.solid.tsx";
import { ToolOutcomeSummary } from "./chat-tool-outcome-summary.solid.tsx";
import { resolveToolOperationLabel } from "./chat-tool-row-presentation.ts";

registerEnglishCatalog(registerChatToolLabelsEnglish);

function operationRunInterrupted(operation: ActivityOperationProps): boolean {
  const runId = operation.contexts.get(operation.group.card)?.runId;
  return Boolean(runId && operation.options.interruptedRunIds?.has(runId));
}

export function ActivityOperation(props: ActivityOperationProps & { hideSummary?: boolean }) {
  const context = () => props.contexts.get(props.group.card)!;
  const expanded = createMemo(
    () =>
      props.hideSummary ||
      (props.options.isToolExpanded?.(context().disclosureId, props.group.card) ?? false),
  );
  return (
    <ChatToolCard
      card={props.group.card}
      options={{
        ...props.options,
        messageKey: context().messageKey,
        interrupted: operationRunInterrupted(props),
        onOpenWorkspaceFile: context().onOpenWorkspaceFile,
        expanded: expanded(),
        hideSummary: props.hideSummary,
        onToggleExpanded: () =>
          props.options.onToggleToolExpanded?.(context().disclosureId, expanded()),
        activityCards: [props.group.card, ...descendantCards(props.group)],
        executionCards: props.group.executionCards,
      }}
      hasChildren={props.group.children.length > 0}
    >
      <Show when={expanded()}>
        <For
          each={props.group.children}
          keyed={(group) => group.card.callId ?? props.contexts.get(group.card)!.disclosureId}
        >
          {(group) => (
            <ActivityOperation group={group()} options={props.options} contexts={props.contexts} />
          )}
        </For>
      </Show>
    </ChatToolCard>
  );
}

/** A recorded outcome can survive without its raw call in the loaded history page. */
export function PreparedActivityRow(props: {
  activity: AgentActivityItem;
  options: Pick<ActivityOperationProps["options"], "pluginToolIcons">;
}) {
  const detail = () =>
    props.activity.error || props.activity.summary || props.activity.progressText;
  return (
    <div class="chat-tool-msg-collapse">
      <div class="chat-tool-msg-summary chat-tool-row">
        <span class="chat-tool-msg-summary__icon" aria-hidden="true">
          <ChatToolIcon
            name={
              props.activity.commandBearing
                ? "squareTerminal"
                : resolveToolDisplayIcon(props.activity.name ?? "")
            }
            tool={{
              toolName: props.activity.name ?? "",
              pluginToolIcons: props.options.pluginToolIcons,
            }}
            style={{ display: "contents" }}
          />
        </span>
        <span class="chat-tool-disclosure__content">
          <span class="chat-tool-row__title">
            {props.activity.title || resolveToolDisplayIdentity(props.activity.name ?? "").label}
          </span>
        </span>
        <span
          class={{
            "chat-tool-failure": props.activity.status === "failed",
            "chat-tool-skipped": props.activity.status === "skipped",
            muted: props.activity.status !== "failed" && props.activity.status !== "skipped",
          }}
        >
          {t(`chat.toolCards.${!props.activity.status ? "outcomeUnknown" : props.activity.status}`)}
        </span>
      </div>
      <Show when={detail()}>{(text) => <div class="chat-tool-msg-body">{text()}</div>}</Show>
    </div>
  );
}

/** Adjacent historical events share a line; its first call retains disclosure ownership. */
export function LifecycleOperations(props: {
  operations: ActivityOperationProps[];
  kind: "launch" | "stop";
}) {
  const first = () => props.operations[0]!;
  const context = () => first().contexts.get(first().group.card)!;
  const disclosureId = () => `lifecycle:${context().disclosureId}`;
  const expanded = () =>
    first().options.isToolExpanded?.(disclosureId(), first().group.card) ?? false;
  const entries = () =>
    props.operations.map((operation) => {
      const card = operation.group.card;
      const subagents = operation.options.subagents;
      const launch = resolveSessionLaunchPresentation(
        card,
        resolveToolCardOutcome(card, operation.options.runActive),
        subagents?.subagentSessions,
      );
      const child = resolveSpawnedSubagent(card, subagents?.subagentSessions);
      return {
        name:
          props.kind === "launch"
            ? launch?.label
            : addressedSession(card, subagents?.subagentSessions, subagents?.recordedStopNames)
                ?.name,
        // A stop receipt names the stopped child's session, so its name opens it too.
        key:
          props.kind === "launch" ? launch?.childKey : readSubagentCancellation(card)?.sessionKey,
        open: (child?.session?.listed && subagents?.onOpenSubagent) || subagents?.onOpenSession,
      };
    });
  const firstOutcome = () => resolveToolCardOutcome(first().group.card, first().options.runActive);
  const running = () =>
    props.operations.some(
      (operation) =>
        resolveToolCardOutcome(operation.group.card, operation.options.runActive) === "running",
    );
  const verb = () => {
    const card = first().group.card;
    if (running()) {
      return t(
        props.kind === "launch"
          ? "chat.toolCards.launch.subagent.running"
          : "chat.toolCards.stoppingSubagent",
      );
    }
    return props.kind === "launch"
      ? t(
          "chat.toolCards.launch.subagent." +
            resolveSessionLaunchPresentation(card, firstOutcome())!.phase,
        )
      : t(
          "chat.toolCards." +
            (readSubagentCancellation(card)?.stopped ? "stoppedSubagent" : "stopSubagent"),
        );
  };
  const unnamedLabel = () => {
    if (entries().every((entry) => entry.name)) {
      return undefined;
    }
    if (running()) {
      return t(
        `chat.toolCards.${props.kind === "launch" ? "launching" : "stopping"}${props.operations.length === 1 ? "Agent" : "Agents"}`,
        { count: String(props.operations.length) },
      );
    }
    const card = first().group.card;
    const confirmed =
      props.kind === "launch"
        ? resolveSessionLaunchPresentation(card, firstOutcome())?.phase === "succeeded"
        : readSubagentCancellation(card)?.stopped;
    return confirmed
      ? t(
          `chat.toolCards.${props.kind === "launch" ? "launched" : "stopped"}${props.operations.length === 1 ? "Agent" : "Agents"}`,
          { count: String(props.operations.length) },
        )
      : verb();
  };
  const parts = () => {
    const count = entries().length;
    const names = entries()
      .slice(0, 2)
      .flatMap((entry, index) => (entry.name ? [String(index)] : []));
    if (count > 2) {
      names.push("more");
    }
    return new Intl.ListFormat(getLocale(), { type: "conjunction" }).formatToParts(names);
  };
  const label = () =>
    unnamedLabel() ??
    (props.operations.length === 1
      ? resolveToolOperationLabel(
          first().group.card,
          firstOutcome(),
          addressedSession(
            first().group.card,
            first().options.subagents?.subagentSessions,
            first().options.subagents?.recordedStopNames,
          ),
        )
      : [verb(), ...entries().map((entry) => entry.name)].filter(Boolean).join(" "));
  return (
    <div class="chat-tool-msg-collapse chat-tool-msg-collapse--lifecycle">
      <div class="chat-inline-disclosure chat-tool-msg-summary chat-tool-row chat-tool-row--subagent">
        <button
          class="chat-tool-row__toggle"
          type="button"
          aria-expanded={expanded() ? "true" : "false"}
          aria-label={label()}
          onClick={() => first().options.onToggleToolExpanded?.(disclosureId(), expanded())}
        />
        <span class="chat-tool-msg-summary__icon" aria-hidden="true">
          <Icon name="bot" />
        </span>
        <span class="chat-tool-disclosure__content">
          <Show
            when={!unnamedLabel()}
            fallback={<span class="chat-tool-row__title">{unnamedLabel()}</span>}
          >
            <span class="chat-tool-row__title">
              <span class="chat-tool-row__verb">{verb()}</span>{" "}
              <span class="chat-tool-row__subagent-name">
                <For each={parts()} keyed={(part) => part.type + part.value}>
                  {(part) => (
                    <Show when={part().type === "element"} fallback={part().value}>
                      <Show
                        when={part().value !== "more"}
                        fallback={t("chat.toolCards.lifecycleMoreCount", {
                          count: String(entries().length - 2),
                        })}
                      >
                        <Show
                          when={
                            entries()[Number(part().value)]?.key &&
                            entries()[Number(part().value)]?.open
                          }
                          fallback={entries()[Number(part().value)]?.name}
                        >
                          <button
                            type="button"
                            class="chat-tool-row__subagent-link"
                            onClick={() => {
                              const entry = entries()[Number(part().value)]!;
                              entry.open?.(entry.key!);
                            }}
                          >
                            {entries()[Number(part().value)]?.name}
                          </button>
                        </Show>
                      </Show>
                    </Show>
                  )}
                </For>
              </span>
            </span>
          </Show>
        </span>
        <Show when={operationRunInterrupted(first()) && firstOutcome() === "unrecorded"}>
          <span class="muted">{t("chat.toolCards.interrupted")}</span>
        </Show>
        <Show
          when={
            props.kind === "stop" &&
            props.operations.length === 1 &&
            ["failed", "skipped"].includes(firstOutcome())
          }
        >
          <ToolOutcomeSummary card={first().group.card} />
        </Show>
        <span class="chat-tool-row__chevron" aria-hidden="true">
          <Icon name="chevronRight" />
        </span>
      </div>
      <Show when={expanded()}>
        <Show
          when={props.operations.length > 1}
          fallback={<ActivityOperation {...first()} hideSummary />}
        >
          <For
            each={props.operations}
            keyed={(operation) => operation.contexts.get(operation.group.card)!.disclosureId}
          >
            {(operation) => <ActivityOperation {...operation()} />}
          </For>
        </Show>
      </Show>
    </div>
  );
}
