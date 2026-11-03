import { createMemo, createSignal, For, onSettled, Show } from "solid-js";
import type {
  ControlUiSessionPullRequest,
  ControlUiSessionPullRequestSnapshot,
} from "../../../../../src/gateway/control-ui-contract.js";
import { fnv1aUtf16 } from "../../../../../src/shared/fnv1a.js";
import { observeScrollState } from "../../../components/scroll-state-observer.ts";
import { progressCardPresentation } from "../../../components/session-progress-card.ts";
import {
  ActivityPill,
  ActivityGlyph,
  type PillView,
} from "../../../components/solid/activity-pill.tsx";
import { Icon } from "../../../components/solid/icon.tsx";
import { registerChatGoalsEnglish } from "../../../i18n/locales/en-chat-goals.ts";
import { registerChatSessionOptionalEnglish } from "../../../i18n/locales/en-chat-session-optional.ts";
import { registerGitHubEnglish } from "../../../i18n/locales/en-github.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { listen } from "../../../lib/reactive/listener.ts";
import type { GitHubPublicationView } from "../../../lib/sessions/github-publication-owner.ts";
import { PluginContributions } from "../../../plugins/control-ui-contributions.solid.tsx";
import type { ChatActivityPillsProps } from "./chat-activity-pills-types.ts";
import { hasVisibleChatActivityPills } from "./chat-activity-pills-visibility.ts";
import { chatPullRequestId, publicationPullRequestTarget } from "./chat-pull-requests.ts";
import "./chat-activity-pills.css";

registerEnglishCatalog(registerChatSessionOptionalEnglish);

registerEnglishCatalog(registerChatGoalsEnglish);
registerEnglishCatalog(registerGitHubEnglish);

type Badge = NonNullable<PillView["badge"]>;

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
  let badge: Badge;
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

const prIcons = {
  open: "gitPullRequest",
  draft: "gitPullRequestDraft",
  merged: "gitMerge",
  closed: "gitPullRequestClosed",
} as const;
const prTones = { open: "ok", draft: "muted", merged: "purple", closed: "danger" } as const;

function pullRequestView(
  pr: ControlUiSessionPullRequest,
  status: ControlUiSessionPullRequestSnapshot["status"],
): PillView {
  const checks =
    (pr.state === "open" || pr.state === "draft") && status === "ready" ? pr.checks : undefined;
  const badge: Badge | undefined = checks
    ? {
        icon: checks.state === "pending" ? "spinner" : checks.state === "passing" ? "check" : "x",
        tone: checks.state === "passing" ? "ok" : checks.state === "failing" ? "danger" : "normal",
        label:
          checks.state === "passing"
            ? t("chat.activityPills.pullRequest.checksPassed")
            : checks.state === "failing"
              ? t("chat.activityPills.pullRequest.checksFailed")
              : t("chat.activityPills.pullRequest.checksRunning"),
      }
    : undefined;
  const query =
    status === "ready"
      ? ""
      : status === "rate-limited"
        ? t("chat.activityPills.pullRequest.rateLimitedSuffix")
        : t("chat.activityPills.pullRequest.unavailableSuffix");
  return {
    label: t("chat.activityPills.pullRequest.number", { number: String(pr.number) }),
    icon: prIcons[pr.state],
    tone: prTones[pr.state],
    badge,
    attention: status === "unavailable",
    description: t("chat.activityPills.pullRequest.description", {
      owner: pr.owner,
      repo: pr.repo,
      number: String(pr.number),
      title: pr.title,
      state: t(`chat.activityPills.pullRequest.states.${pr.state}`),
      checks: badge
        ? t("chat.activityPills.pullRequest.checksSuffix", { checks: badge.label })
        : "",
      query,
    }),
  };
}

function publicationView(view: GitHubPublicationView): PillView {
  if (view.activity !== null) {
    return {
      label:
        view.activity === "read"
          ? view.result || view.locked
            ? t("chat.activityPills.publication.verifying")
            : t("chat.activityPills.publication.checkingOptions")
          : t("chat.activityPills.publication.publishing"),
      icon: "gitPullRequest",
      badge: { icon: "spinner", tone: "normal", label: t("chat.activityPills.pending") },
    };
  }
  if (view.optionsUnavailable) {
    return {
      label: t("chat.activityPills.publication.unavailable"),
      icon: "gitPullRequest",
      badge: {
        icon: "alertTriangle",
        tone: "warn",
        label: t("chat.activityPills.publication.discoveryUnavailable"),
      },
      attention: true,
    };
  }
  // A failed verification must stay visible over the retained request/result.
  if (view.error || (view.locked && !view.result)) {
    return {
      label: t("chat.activityPills.publication.unconfirmed"),
      icon: "gitPullRequest",
      badge: {
        icon: "alertTriangle",
        tone: "warn",
        label: t("chat.activityPills.publication.verifyBeforeRetry"),
      },
      attention: true,
    };
  }
  if (view.result?.status === "published") {
    // Bridges the receipt until the PR snapshot lists it and the PR pill takes over.
    const target = publicationPullRequestTarget(view);
    return {
      label: target
        ? t("chat.activityPills.pullRequest.number", { number: String(target.number) })
        : t("chat.activityPills.publication.published"),
      icon: "gitPullRequest",
      badge: {
        icon: "check",
        tone: "ok",
        label: t("chat.activityPills.publication.publishedBadge"),
      },
    };
  }
  if (view.result?.status === "failed") {
    return {
      label: t("chat.activityPills.publication.failed"),
      icon: "gitPullRequest",
      tone: "danger",
      badge: { icon: "x", tone: "danger", label: t("githubPublication.statusFailed") },
      attention: true,
    };
  }
  if (view.result?.status === "needs_confirmation") {
    return {
      label: t("chat.activityPills.publication.confirm"),
      icon: "gitPullRequest",
      badge: { icon: "clock", tone: "warn", label: t("githubPublication.statusConfirm") },
    };
  }
  if (view.result?.status === "requested" || view.result?.status === "publishing") {
    return {
      label:
        view.result.status === "requested"
          ? t("githubPublication.statusRequested")
          : t("chat.activityPills.publication.publishing"),
      icon: "gitPullRequest",
      badge: {
        icon: view.result.status === "requested" ? "clock" : "spinner",
        tone: "warn",
        label: t(
          view.result.status === "requested"
            ? "chat.activityPills.publication.requestedBadge"
            : "chat.activityPills.publication.publishingBadge",
        ),
      },
    };
  }
  return {
    label: t("chat.pullRequests.publishPr"),
    icon: "github",
    description: t("chat.activityPills.publication.review"),
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
  let strip!: HTMLDivElement;
  let row!: HTMLDivElement;
  const buttons = new Set<HTMLButtonElement>();
  const sources = new Set<() => readonly HTMLElement[]>();
  const [contributionPresent, setContributionPresent] = createSignal(false, { ownedWrite: true });
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
      hidden={!hasVisibleChatActivityPills(props) && !contributionPresent()}
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
        <Show when={!props.approvalPending && props.contributions}>
          {(contributions) => (
            <PluginContributions
              kind="session-mobile-activity"
              sessionKey={contributions().sessionKey}
              agentId={contributions().agentId}
              facts={contributions().facts}
              presented={props.presented}
              onOpenDetailsPage={contributions().onOpenDetailsPage}
              onPresenceChange={setContributionPresent}
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
          )}
        </Show>
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
          <For each={props.pullRequests?.items ?? []} keyed={chatPullRequestId}>
            {(pr) => (
              <ActivityPill
                registerButton={registerButton}
                family="pull-request"
                view={pullRequestView(pr(), props.pullRequests!.status)}
                onOpen={(source) => props.pullRequests!.onOpen(pr(), source)}
                trailing={
                  <Show
                    when={props.pullRequests!.status !== "ready"}
                    fallback={
                      <Show when={props.pullRequests!.items.length === 1}>
                        <span class="activity-pill__diff">
                          <Show when={pr().additions !== undefined}>
                            <span class="activity-pill__additions">+{pr().additions}</span>
                          </Show>
                          <Show when={pr().deletions !== undefined}>
                            <span class="activity-pill__deletions">−{pr().deletions}</span>
                          </Show>
                        </span>
                      </Show>
                    }
                  >
                    <span class="activity-pill__problem" aria-hidden="true">
                      <Icon name="alertTriangle" />
                    </span>
                  </Show>
                }
              />
            )}
          </For>
          <Show when={props.publication}>
            <ActivityPill
              registerButton={registerButton}
              family="publication"
              view={publicationView(props.publication!.view)}
              onOpen={(source) => props.publication!.onOpen(source)}
            />
          </Show>
        </Show>
      </div>
    </div>
  );
}
