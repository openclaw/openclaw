import { createMemo, createUniqueId, For, Show } from "solid-js";
import type { ControlUiLinkReaderDocument } from "../../../src/shared/control-ui-link-reader.js";
import { t } from "../lib/reactive/i18n.ts";
import { ReaderLink, documentUrl } from "./link-reader-markdown.tsx";
import { Icon, type IconName } from "./solid/icon.tsx";

type ReaderChecks = NonNullable<ControlUiLinkReaderDocument["checks"]>;
type ReaderCheck = ReaderChecks["items"][number];
const checkIcons: Record<ReaderChecks["state"], IconName> = {
  success: "check",
  failure: "circleX",
  pending: "clock",
  unavailable: "circleQuestionMark",
  neutral: "circle",
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
  { state: "failure", label: checkLabels.failure, open: true },
  { state: "pending", label: checkLabels.pending, open: true },
  { state: "success", label: checkLabels.success, open: false },
  { state: "neutral", label: "linkReader.checksGroupNeutral", open: false },
] as const;
// Failures stay visible while the full list is collapsed, up to this many rows.
const CHECK_ATTENTION_LIMIT = 3;

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
    checkGroups.flatMap(({ state, label, open }) => {
      const items = props.checks.items.filter((item) => item.state === state);
      return items.length ? [{ state, label, open, items }] : [];
    }),
  );
  const failures = createMemo(() => groups().find((group) => group.state === "failure")?.items);
  const complete = () =>
    !props.checks.truncated &&
    props.checks.state !== "unavailable" &&
    props.checks.items.length === props.checks.total &&
    props.checks.total > 0;
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
        <span class="lr-checks-icon" aria-hidden="true">
          <Icon name={checkIcons[props.checks.state]} />
        </span>
        <span class="lr-checks-heading">
          <strong>
            {props.refreshState
              ? t(
                  props.refreshState === "error"
                    ? "linkReader.sectionRefreshFailed"
                    : "linkReader.sectionRefreshing",
                  { section: t("linkReader.checks") },
                )
              : t(checksLabels[props.checks.state])}
          </strong>
          <Show when={props.checks.summary !== t(checksLabels[props.checks.state])}>
            <span class="lr-meta">{props.checks.summary}</span>
          </Show>
        </span>
        <Show when={complete()}>
          <span class="lr-checks-meter" aria-hidden="true">
            <For each={groups()}>
              {(group) => (
                <span
                  class={["lr-check-segment", `lr-check-segment--${group.state}`]}
                  style={{ "flex-grow": group.items.length }}
                />
              )}
            </For>
          </span>
        </Show>
        <span class="lr-checks-chevron" aria-hidden="true">
          <Icon name="chevronDown" />
        </span>
      </button>
      <Show when={!props.expanded && failures()}>
        {(items) => (
          <ul class="lr-check-list lr-check-list--attention">
            <For each={items().slice(0, CHECK_ATTENTION_LIMIT)}>
              {(item) => <CheckRow item={item} base={props.base} />}
            </For>
            <Show when={items().length > CHECK_ATTENTION_LIMIT}>
              <li class="lr-check lr-check--more">
                <button
                  type="button"
                  class="lr-check-row"
                  onClick={() => props.onExpandedChange(true)}
                >
                  {t("linkReader.checksMoreFailed", {
                    count: String(items().length - CHECK_ATTENTION_LIMIT),
                  })}
                </button>
              </li>
            </Show>
          </ul>
        )}
      </Show>
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
