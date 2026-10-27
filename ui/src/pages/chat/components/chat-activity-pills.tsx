import type { JSX } from "@solidjs/web";
import { children, createMemo, For, onSettled, Show } from "solid-js";
import type {
  ControlUiSessionPullRequest,
  ControlUiSessionPullRequestSnapshot,
} from "../../../../../src/gateway/control-ui-contract.js";
import { observeScrollState } from "../../../components/scroll-state-observer.ts";
import { progressCardPresentation } from "../../../components/session-progress-card.ts";
import { BrandIcon, Icon, type IconName } from "../../../components/solid/icon.tsx";
import { registerChatGoalsEnglish } from "../../../i18n/locales/en-chat-goals.ts";
import { registerChatSessionOptionalEnglish } from "../../../i18n/locales/en-chat-session-optional.ts";
import { registerGitHubEnglish } from "../../../i18n/locales/en-github.ts";
import { fnv1aUtf16 } from "../../../lib/fnv1a.ts";
import { elementRef } from "../../../lib/reactive/element-ref.ts";
import { registerEnglishCatalog, t } from "../../../lib/reactive/i18n.ts";
import { listen } from "../../../lib/reactive/listener.ts";
import { observeIntersection } from "../../../lib/reactive/observers.ts";
import { createScrollStateRef } from "../../../lib/reactive/scroll-state.ts";
import type { GitHubPublicationView } from "../../../lib/sessions/github-publication-owner.ts";
import type { ChatActivityPillsProps } from "./chat-activity-pills-types.ts";
import { hasVisibleChatActivityPills } from "./chat-activity-pills-visibility.ts";
import { chatPullRequestId } from "./chat-pull-requests.ts";
import "./chat-activity-pills.css";

registerEnglishCatalog(registerChatSessionOptionalEnglish);

registerEnglishCatalog(registerChatGoalsEnglish);
registerEnglishCatalog(registerGitHubEnglish);

type OpenActivity = NonNullable<ChatActivityPillsProps["subagents"]>["onOpen"];

type Tone = "normal" | "muted" | "ok" | "warn" | "danger" | "purple";
type Glyph = IconName | "goal" | "bot" | "filledStop" | "spinner" | "github";
type Badge = { icon: Glyph; tone: Tone; label: string };
type PillView = {
  label: string;
  icon: Glyph;
  tone?: Tone;
  badge?: Badge;
  attention?: boolean;
  shine?: boolean;
  count?: string;
  description?: string;
};

function ActivityGlyph(props: { name: Glyph }) {
  const nativeName = () => {
    const name = props.name;
    return name === "goal" ||
      name === "pause" ||
      name === "bot" ||
      name === "filledStop" ||
      name === "spinner" ||
      name === "github"
      ? undefined
      : name;
  };
  return (
    <Show when={props.name !== "spinner"} fallback={<span class="activity-pill__spinner" />}>
      <Show when={props.name !== "github"} fallback={<BrandIcon name="github" />}>
        <Show
          when={
            props.name === "goal" ||
            props.name === "pause" ||
            props.name === "bot" ||
            props.name === "filledStop"
          }
          fallback={<Show when={nativeName()}>{(name) => <Icon name={name()} />}</Show>}
        >
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="1.7"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <Show when={props.name === "goal"}>
              <path d="M12 13V2l8 4-8 4M20.561 10.222a9 9 0 1 1-12.55-5.29M8.002 9.997a5 5 0 1 0 8.9 2.02" />
            </Show>
            <Show when={props.name === "pause"}>
              <path d="M9 5v14M15 5v14" />
            </Show>
            <Show when={props.name === "bot"}>
              <rect x="4" y="7" width="16" height="13" rx="2" />
              <path d="M12 3v4M9 12v3m6-3v3M1 11v5m22-5v5" />
            </Show>
            <Show when={props.name === "filledStop"}>
              <rect x="4" y="4" width="16" height="16" rx="2" fill="currentColor" stroke="none" />
            </Show>
          </svg>
        </Show>
      </Show>
    </Show>
  );
}

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
    return {
      label: t("chat.activityPills.publication.published"),
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

function ActivityPill(props: {
  family: "subagents" | "goal" | "progress" | "pull-request" | "publication";
  view: PillView;
  onOpen: OpenActivity;
  registerButton: (button: HTMLButtonElement) => () => void;
  leading?: JSX.Element;
  trailing?: JSX.Element;
  flow?: boolean;
}) {
  const leading = children(() => props.leading);
  let button!: HTMLButtonElement;
  const labelRef = createScrollStateRef(
    (element, state) => element.toggleAttribute("data-overflow", state.scrollable),
    { horizontal: true, trackScroll: false, content: () => props.view.label },
  );
  const accessibleLabel = () =>
    props.view.description ??
    (props.view.badge
      ? t("chat.activityPills.withBadge", {
          label: props.view.label,
          badge: props.view.badge.label,
        })
      : props.view.label);
  onSettled(() =>
    observeIntersection([button], ([entry]) =>
      button.toggleAttribute("data-out-of-view", !entry?.isIntersecting),
    ),
  );
  return (
    <button
      ref={[
        (element) => {
          button = element;
        },
        elementRef<HTMLButtonElement>((element) => props.registerButton(element)),
      ]}
      class={[
        "activity-pill",
        { "activity-pill--attention": props.view.attention, "activity-pill--flow": props.flow },
      ]}
      data-family={props.family}
      data-tone={props.view.tone ?? "normal"}
      data-counted={props.view.count ? "true" : "false"}
      type="button"
      aria-haspopup="dialog"
      aria-label={accessibleLabel()}
      title={accessibleLabel()}
      onClick={(event) => props.onOpen(event.currentTarget)}
    >
      <Show when={props.flow}>
        <span class="activity-pill__flow" aria-hidden="true">
          <span class="activity-pill__atlas" />
        </span>
      </Show>
      <Show
        when={leading()}
        fallback={
          <span class="activity-pill__leading" aria-hidden="true">
            <span class="activity-pill__composite">
              <ActivityGlyph name={props.view.icon} />
              <Show when={props.view.badge}>
                {(badge) => (
                  <span class="activity-pill__badge" data-tone={badge().tone}>
                    <ActivityGlyph name={badge().icon} />
                  </span>
                )}
              </Show>
            </span>
          </span>
        }
      >
        {leading()}
      </Show>
      <span
        ref={labelRef}
        class={["activity-pill__label", { "activity-pill__label--shine": props.view.shine }]}
      >
        {props.view.label}
        <Show when={props.view.shine}>
          <span class="activity-pill__shimmer" aria-hidden="true">
            {props.view.label}
          </span>
        </Show>
      </span>
      <Show when={props.view.count}>
        {(count) => <span class="activity-pill__count">{count()}</span>}
      </Show>
      {props.trailing}
    </button>
  );
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
        props.onLayout?.({ strip, pills: buttons });
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
      props.onLayout?.({ strip, pills: buttons }, true);
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
    const orderedButtons = [...buttons]
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
      hidden={!hasVisibleChatActivityPills(props)}
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
