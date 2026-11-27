import { createMemo, createUniqueId, For, Show } from "solid-js";
import type { ControlUiLinkReaderDocument } from "../../../src/shared/control-ui-link-reader.js";
import { t } from "../lib/reactive/i18n.ts";
import { ReaderLink, documentUrl } from "./link-reader-markdown.tsx";
import { Icon, type IconName } from "./solid/icon.tsx";

type ReaderChecks = NonNullable<ControlUiLinkReaderDocument["checks"]>;
type ReaderCheck = ReaderChecks["items"][number];
const checkIcons: Record<ReaderChecks["state"], IconName> = {
  success: "circleCheck",
  failure: "circleX",
  pending: "clock",
  unavailable: "circleQuestionMark",
  neutral: "circleDashed",
};
// The ring already draws the circle; its center carries only the mark.
const ringIcons: Record<ReaderChecks["state"], IconName> = {
  success: "check",
  failure: "x",
  pending: "clock",
  unavailable: "moreHorizontal",
  neutral: "moreHorizontal",
};
const checkLabels = {
  success: "linkReader.checkSuccess",
  failure: "linkReader.checkFailure",
  pending: "linkReader.checkPending",
  neutral: "linkReader.checkNeutral",
} as const;
const checksLabels = {
  success: "linkReader.checksSuccess",
  failure: "linkReader.checksFailure",
  pending: "linkReader.checksPending",
  neutral: "linkReader.checksNeutral",
  unavailable: "linkReader.checksUnavailable",
} as const;
// Actionable groups stay open; passed and skipped runs are counted, not listed.
const checkGroups = [
  {
    state: "failure",
    label: checkLabels.failure,
    count: "linkReader.checksCountFailure",
    open: true,
  },
  {
    state: "pending",
    label: checkLabels.pending,
    count: "linkReader.checksCountPending",
    open: true,
  },
  {
    state: "success",
    label: checkLabels.success,
    count: "linkReader.checksCountSuccess",
    open: false,
  },
  {
    state: "neutral",
    label: "linkReader.checksGroupNeutral",
    count: "linkReader.checksCountNeutral",
    open: false,
  },
] as const;
// The collapsed summary names this many failed runs; the open list shows them all.
const CHECK_FAILING_NAMES = 2;
// Ring geometry in percent of the circumference: one failure among many must stay visible,
// and an incomplete list never closes the ring, even when its missing count is unknown.
const RING_MIN_SHARE = 5;
const RING_GAP = 2;
const RING_INCOMPLETE_MAX = 85;

function CheckRow(props: { item: ReaderCheck; base: string }) {
  const url = () => (props.item.url ? documentUrl(props.item.url, props.base)?.href : undefined);
  const content = () => (
    <>
      <span class="lr-check-symbol" role="img" aria-label={t(checkLabels[props.item.state])}>
        <Icon name={checkIcons[props.item.state]} />
      </span>
      <span class="lr-check-name">{props.item.name}</span>
      {/* The icon and group already name the state; keep only details that add to it. */}
      <Show when={props.item.detail !== t(checkLabels[props.item.state]) && props.item.detail}>
        {(detail) => <span class="lr-check-detail">{detail()}</span>}
      </Show>
      <Show when={url()}>
        <span class="lr-check-external" aria-hidden="true">
          <Icon name="externalLink" />
        </span>
      </Show>
    </>
  );
  return (
    <li class={["lr-check", `lr-check--${props.item.state}`]}>
      <Show when={url()} fallback={<span class="lr-check-row">{content()}</span>}>
        {(href) => (
          <ReaderLink class="lr-check-row" href={href()} data-link-reader-external="">
            {content()}
          </ReaderLink>
        )}
      </Show>
    </li>
  );
}

export function ChecksContent(props: {
  checks: ReaderChecks;
  base: string;
  provider: string;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
  refreshState?: "idle" | "loading" | "error";
  sectionRef: (element: HTMLElement) => void;
}) {
  const listId = createUniqueId();
  const source = () =>
    props.checks.url ? documentUrl(props.checks.url, props.base)?.href : undefined;
  const groups = createMemo(() =>
    checkGroups.flatMap((group) => {
      const items = props.checks.items.filter((item) => item.state === group.state);
      return items.length ? [{ ...group, items }] : [];
    }),
  );
  const failing = () => {
    const names = groups()
      .find((group) => group.state === "failure")
      ?.items.map((item) => item.name);
    return names && names.length > CHECK_FAILING_NAMES
      ? names.slice(0, CHECK_FAILING_NAMES).join(", ") + " +" + (names.length - CHECK_FAILING_NAMES)
      : names?.join(", ");
  };
  const total = () => Math.max(props.checks.total, props.checks.items.length);
  const missing = () => total() - props.checks.items.length;
  // Known runs share the ring; runs the source did not return stay as empty track.
  const ring = createMemo(() => {
    const listed = (props.checks.items.length / total()) * 100;
    const known = props.checks.truncated ? Math.min(listed, RING_INCOMPLETE_MAX) : listed;
    const shares = groups().map((group) =>
      Math.max((group.items.length / total()) * 100, RING_MIN_SHARE),
    );
    const scale = known / shares.reduce((sum, share) => sum + share, 0);
    const gap = shares.length > 1 || known < 100 ? RING_GAP : 0;
    let start = 0;
    return groups().map((group, index) => {
      const share = shares[index]! * scale;
      const segment = { state: group.state, start, length: Math.max(share - gap, 1) };
      start += share;
      return segment;
    });
  });
  // Known runs with an incomplete list are not "unavailable".
  const title = () =>
    props.checks.state === "unavailable" && props.checks.items.length
      ? t("linkReader.checksIncomplete")
      : t(checksLabels[props.checks.state]);
  return (
    <section
      ref={(element) => props.sectionRef(element)}
      class={[
        "lr-checks",
        `lr-checks--${props.checks.state}`,
        { "lr-checks--expanded": props.expanded },
      ]}
      data-reader-section="checks"
      tabindex={-1}
      aria-label={t("linkReader.checks")}
    >
      <button
        type="button"
        class="lr-checks-summary"
        aria-expanded={props.expanded ? "true" : "false"}
        aria-controls={listId}
        onClick={() => props.onExpandedChange(!props.expanded)}
      >
        <span class="lr-checks-emblem" aria-hidden="true">
          <Show when={props.checks.items.length}>
            <svg class="lr-checks-meter" viewBox="0 0 32 32">
              <circle class="lr-checks-track" cx="16" cy="16" r="13.5" />
              <For each={ring()}>
                {(segment) => (
                  <circle
                    class={["lr-check-segment", `lr-check-segment--${segment.state}`]}
                    cx="16"
                    cy="16"
                    r="13.5"
                    pathLength="100"
                    stroke-dasharray={`${segment.length} ${100 - segment.length}`}
                    stroke-dashoffset={-segment.start}
                  />
                )}
              </For>
            </svg>
          </Show>
          <span class="lr-checks-icon">
            <Icon name={ringIcons[props.checks.state]} />
          </span>
        </span>
        <span class="lr-checks-heading">
          <span class="lr-checks-title">
            <strong>{title()}</strong>
            <Show when={failing()}>{(names) => <span>{names()}</span>}</Show>
          </span>
          <Show
            when={!props.refreshState && props.checks.items.length}
            fallback={
              <Show
                when={props.refreshState}
                fallback={
                  <Show when={props.checks.summary !== t(checksLabels[props.checks.state])}>
                    <span class="lr-checks-legend">{props.checks.summary}</span>
                  </Show>
                }
              >
                {(state) => (
                  // These are the previous results: say so where their counts would be.
                  <span class="lr-checks-refresh" role="status">
                    {t(
                      state() === "error"
                        ? "linkReader.sectionRefreshFailed"
                        : "linkReader.sectionRefreshing",
                      { section: t("linkReader.checks") },
                    )}
                  </span>
                )}
              </Show>
            }
          >
            {/* The source's own wording stays reachable beside the counted states. */}
            <span class="lr-checks-legend" title={props.checks.summary}>
              <For each={groups()}>
                {(group) => (
                  <span class={["lr-checks-count", `lr-checks-count--${group.state}`]}>
                    {t(group.count, { count: String(group.items.length) })}
                  </span>
                )}
              </For>
              <Show when={missing() > 0}>
                <span class="lr-checks-count lr-checks-count--missing">
                  {t("linkReader.checksCountMissing", { count: String(missing()) })}
                </span>
              </Show>
            </span>
          </Show>
        </span>
        <span class="lr-checks-chevron" aria-hidden="true">
          <Icon name="chevronDown" />
        </span>
      </button>
      <div id={listId} class="lr-check-groups" hidden={!props.expanded}>
        <Show when={props.expanded}>
          <For each={groups()} keyed={(group) => group.state}>
            {(group) => (
              <details
                class={["lr-check-group", `lr-check-group--${group().state}`]}
                open={group().open}
              >
                <summary>
                  <span class="lr-check-group-chevron" aria-hidden="true">
                    <Icon name="chevronRight" />
                  </span>
                  <span>{t(group().label)}</span>
                  <span class="lr-count">{group().items.length}</span>
                </summary>
                <ul class="lr-check-list">
                  <For each={group().items}>
                    {(item) => <CheckRow item={item} base={props.base} />}
                  </For>
                </ul>
              </details>
            )}
          </For>
          <Show when={props.checks.truncated}>
            <p class="lr-note">
              {t("linkReader.checksTruncated")}
              <Show when={source()}>
                {(url) => (
                  <>
                    {" "}
                    <ReaderLink href={url()} data-link-reader-external="">
                      {t("linkReader.checksSourceExternal", { provider: props.provider })}
                      <Icon name="externalLink" />
                    </ReaderLink>
                  </>
                )}
              </Show>
            </p>
          </Show>
          <footer class="lr-checks-footer">
            <Show when={props.checks.commit}>
              {(commit) => (
                <code title={t("linkReader.checksCommit", { commit: commit() })}>
                  {commit().slice(0, 7)}
                </code>
              )}
            </Show>
            <Show when={source()}>
              {(url) => (
                <ReaderLink href={url()} data-link-reader-external="">
                  {t("linkReader.checksSource")}
                  <Icon name="externalLink" />
                </ReaderLink>
              )}
            </Show>
          </footer>
        </Show>
      </div>
    </section>
  );
}
