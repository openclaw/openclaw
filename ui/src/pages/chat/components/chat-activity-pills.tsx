import { createMemo, createSignal, For, onSettled, Show } from "solid-js";
import { fnv1aUtf16 } from "../../../../../src/shared/fnv1a.js";
import { observeScrollState } from "../../../components/scroll-state-observer.ts";
import { progressCardPresentation } from "../../../components/session-progress-card.ts";
import {
  ActivityPill,
  ActivityGlyph,
  type PillView,
} from "../../../components/solid/activity-pill.tsx";
import { registerChatGoalsEnglish } from "../../../i18n/locales/en-chat-goals.ts";
import { registerChatSessionOptionalEnglish } from "../../../i18n/locales/en-chat-session-optional.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { listen } from "../../../lib/reactive/listener.ts";
import { PluginContributions } from "../../../plugins/control-ui-contributions.solid.tsx";
import type { ChatActivityPillsProps } from "./chat-activity-pills-types.ts";
import { hasVisibleChatActivityPills } from "./chat-activity-pills-visibility.ts";
import "./chat-activity-pills.css";

registerEnglishCatalog(registerChatSessionOptionalEnglish);

registerEnglishCatalog(registerChatGoalsEnglish);

function goalView(input: NonNullable<ChatActivityPillsProps["goal"]>): PillView {
  const goal = input.value;
  const recovery = input.recovery;
  if (recovery?.goalId === goal.id && recovery.action === "resume" && !recovery.retired) {
    return recovery.pending
      ? { label: t("chat.goals.resuming"), icon: "spinner" }
      : {
          label: t("chat.activityPills.goal.resumeUnconfirmed"),
          icon: "alertTriangle",
          tone: "warn",
          attention: true,
        };
  }
  switch (goal.status) {
    case "active":
      return {
        label: input.executionConfirmed
          ? t("chat.activityPills.goal.pursuing")
          : t("chat.activityPills.goal.active"),
        icon: "goal",
        tone: "ok",
        shine: input.executionConfirmed,
      };
    case "paused":
      return { label: t("chat.activityPills.goal.paused"), icon: "pause", tone: "muted" };
    case "complete":
      return { label: t("chat.activityPills.goal.achieved"), icon: "check", tone: "ok" };
    default:
      return {
        label:
          goal.status === "blocked"
            ? t("chat.activityPills.goal.blocked")
            : goal.status === "usage_limited"
              ? t("chat.activityPills.goal.usageLimit")
              : t("chat.activityPills.goal.budgetReached"),
        icon: "alertTriangle",
        tone: "warn",
        attention: true,
      };
  }
}

function progressView(input: NonNullable<ChatActivityPillsProps["progress"]>): PillView {
  const view = progressCardPresentation(
    input.card,
    input.sessionStatus,
    input.startedAt,
    input.endedAt,
    input.hasActiveRun,
    input.runtime,
  );
  let badge: NonNullable<PillView["badge"]>;
  if (input.refresh === "pending") {
    badge = { icon: "spinner", tone: "normal", label: t("chat.activityPills.progress.updating") };
  } else if (input.refresh === "failed" || input.refresh === "timeout") {
    badge = {
      icon: "alertTriangle",
      tone: "warn",
      label: t("chat.activityPills.progress.updateUnavailable"),
    };
  } else if (input.runtime?.connected === false || input.runtime?.known === false) {
    badge = {
      icon: "alertTriangle",
      tone: "warn",
      label: t(
        input.runtime.connected === false
          ? "sessionProgressCard.runtime.offline"
          : "sessionProgressCard.runtime.unknown",
      ),
    };
  } else if (input.runtime?.children?.failed) {
    badge = {
      icon: "x",
      tone: "danger",
      label: t("sessionProgressCard.runtime.failed", {
        count: String(input.runtime.children.failed),
      }),
    };
  } else if (!view.counts) {
    return { label: t("sessionProgressCard.composerTitle"), icon: "listChecks" };
  } else if (view.hasCurrentRunActivity) {
    badge = { icon: "spinner", tone: "normal", label: t("common.running") };
  } else if (view.complete) {
    badge = { icon: "check", tone: "ok", label: t("common.completed") };
  } else if (view.effectiveSessionStatus === "timeout") {
    badge = {
      icon: "alertTriangle",
      tone: "warn",
      label: t("chat.activityPills.progress.timedOut"),
    };
  } else if (view.terminalOutcome === "failed") {
    badge = { icon: "x", tone: "danger", label: t("chat.activityPills.progress.failed") };
  } else if (view.terminalOutcome === "stopped") {
    badge = { icon: "filledStop", tone: "danger", label: t("chat.activityPills.progress.stopped") };
  } else if (view.presentedCurrentStatus === "paused") {
    badge = { icon: "pause", tone: "warn", label: t("chat.activityPills.paused") };
  } else {
    badge = { icon: "clock", tone: "warn", label: t("chat.activityPills.pending") };
  }
  if (!view.counts) {
    return {
      label: t("sessionProgressCard.composerTitle"),
      icon: "listChecks",
      badge,
      attention: input.refresh === "failed" || input.refresh === "timeout",
    };
  }
  return {
    label: view.stepLabel,
    icon: "listChecks",
    count: t("chat.activityPills.progress.count", {
      completed: String(view.counts.completed),
      total: String(view.counts.total),
    }),
    description: t("chat.activityPills.progress.description", {
      step: view.stepLabel,
      completed: String(view.counts.completed),
      total: String(view.counts.total),
      status: badge.label,
    }),
    badge,
    attention:
      input.refresh === "failed" ||
      input.refresh === "timeout" ||
      (!view.complete && view.terminalOutcome === "failed"),
  };
}

// Identity determines artwork colors, not current position or execution status.
const avatarPalette = [
  ["#34383b", "#bdc3c7"],
  ["#34414b", "#afc4d4"],
  ["#38353e", "#beb6ca"],
  ["#30383c", "#acbec5"],
  ["#3c363a", "#c6b9c1"],
  ["#3a3832", "#c3beae"],
] as const;
function avatarColors(key: string) {
  let hash = 0;
  for (const character of key) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  return avatarPalette[hash % avatarPalette.length]!;
}

/** Controlled mobile leaf. No navigation, queries, mutations, timers or persisted state. */
export function ChatActivityPills(props: ChatActivityPillsProps) {
  // Contributed mounts report presence from their own renderer lifecycle.
  const [pluginPresent, setPluginPresent] = createSignal(false, { ownedWrite: true });
  let strip!: HTMLDivElement;
  let row!: HTMLDivElement;
  const buttons = new Set<HTMLButtonElement>();
  const sources = new Set<() => readonly HTMLElement[]>();
  const currentButtons = () =>
    new Set([
      ...buttons,
      ...[...sources]
        .flatMap((read) => read())
        .filter((control): control is HTMLButtonElement => control instanceof HTMLButtonElement),
    ]);
  let resize: ResizeObserver | undefined;
  let scheduleLayout: (() => void) | undefined;
  const registerButton = (button: HTMLButtonElement) => {
    buttons.add(button);
    resize?.observe(button);
    scheduleLayout?.();
    return () => {
      buttons.delete(button);
      resize?.unobserve(button);
      scheduleLayout?.();
    };
  };
  const working = createMemo(
    () =>
      props.subagents?.activities.filter(
        (agent) => agent.status === "running" || agent.status === "waiting",
      ) ?? [],
  );
  const hasGoal = () => Boolean(props.goal);
  onSettled(() => {
    const scroll = observeScrollState(
      strip,
      (state) => {
        strip.toggleAttribute("data-fade-left", !state.atStart);
        strip.toggleAttribute("data-fade-right", !state.atEnd);
        props.onLayout?.({ strip, pills: currentButtons() });
      },
      true,
    );
    scheduleLayout = scroll.schedule;
    resize = new ResizeObserver(scroll.schedule);
    resize.observe(row);
    buttons.forEach((button) => resize?.observe(button));
    const visibility = () => strip.toggleAttribute("data-document-hidden", document.hidden);
    const stopVisibility = listen(document, "visibilitychange", visibility);
    visibility();
    return () => {
      scroll.disconnect();
      resize?.disconnect();
      resize = undefined;
      scheduleLayout = undefined;
      props.onLayout?.({ strip, pills: currentButtons() }, true);
      stopVisibility();
    };
  });
  function navigate(event: KeyboardEvent) {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
      return;
    }
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
      return;
    }
    const orderedButtons = [...currentButtons()]
      .filter((button) => button.isConnected)
      .toSorted((left, right) =>
        left === right
          ? 0
          : left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING
            ? -1
            : 1,
      );
    const index = orderedButtons.findIndex((button) => button === event.target);
    if (index < 0) {
      return;
    }
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? orderedButtons.length - 1
          : Math.max(
              0,
              Math.min(orderedButtons.length - 1, index + (event.key === "ArrowRight" ? 1 : -1)),
            );
    event.preventDefault();
    const target = orderedButtons[next];
    if (!target) {
      return;
    }
    target.focus({ preventScroll: true });
    // Reveal only this strip; opening a pill must not move the transcript underneath it.
    const bounds = strip.getBoundingClientRect();
    const item = target.getBoundingClientRect();
    if (item.left < bounds.left + 20) {
      strip.scrollLeft -= bounds.left + 20 - item.left;
    } else if (item.right > bounds.right - 20) {
      strip.scrollLeft += item.right - bounds.right + 20;
    }
  }
  return (
    <div
      ref={(element) => {
        strip = element;
      }}
      class="chat-activity-pills"
      hidden={!hasVisibleChatActivityPills(props) && !(!props.approvalPending && pluginPresent())}
      data-presented={props.presented ? "true" : "false"}
      role="group"
      aria-label={t("chat.activityPills.label")}
      onKeyDown={navigate}
    >
      <div
        ref={(element) => {
          row = element;
        }}
        class="chat-activity-pills__row"
      >
        <Show when={!props.approvalPending && working().length > 0}>
          <ActivityPill
            registerButton={registerButton}
            family="subagents"
            view={{
              label: t("chat.activityPills.working", { count: String(working().length) }),
              icon: "bot",
              shine: true,
            }}
            onOpen={(source) => props.subagents!.onOpen(source)}
            flow={working().length >= 10}
            leading={
              <span class="activity-pill__avatars" aria-hidden="true">
                <For each={working().slice(0, 3)} keyed={(agent) => agent.key}>
                  {(agent, index) => (
                    <span
                      class="activity-pill__avatar"
                      style={{
                        "--subagent-avatar-hue": fnv1aUtf16(agent().key) % 360,
                        "--avatar-bg": avatarColors(agent().key)[0],
                        "--avatar-ink": avatarColors(agent().key)[1],
                        "--wave-delay": `${index() * 120}ms`,
                      }}
                    >
                      <ActivityGlyph name="bot" />
                    </span>
                  )}
                </For>
              </span>
            }
          />
        </Show>
        <Show when={hasGoal()}>
          <ActivityPill
            registerButton={registerButton}
            family="goal"
            view={{
              ...goalView(props.goal!),
              description: t("chat.activityPills.goal.description", {
                status: goalView(props.goal!).label,
                objective: props.goal!.value.objective,
              }),
            }}
            onOpen={(source) => props.goal!.onOpen(source)}
          />
        </Show>
        <Show when={!props.approvalPending && props.progress}>
          <ActivityPill
            registerButton={registerButton}
            family="progress"
            view={progressView(props.progress!)}
            onOpen={(source) => props.progress!.onOpen(source)}
          />
        </Show>
        <Show when={!props.approvalPending}>
          <Show when={props.contributions}>
            <PluginContributions
              kind="session-mobile-activity"
              sessionKey={props.contributions!.sessionKey}
              agentId={props.contributions!.agentId}
              facts={props.contributions!.facts}
              presented={props.presented}
              onOpenDetailsPage={props.contributions!.onOpenDetailsPage}
              onPresenceChange={setPluginPresent}
              onContentChange={(phase) => {
                if (phase === "after") {
                  scheduleLayout?.();
                }
              }}
              registerControls={(read) => {
                sources.add(read);
                scheduleLayout?.();
                return () => {
                  sources.delete(read);
                  scheduleLayout?.();
                };
              }}
            />
          </Show>
        </Show>
      </div>
    </div>
  );
}
