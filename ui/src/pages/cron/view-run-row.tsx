import { flattenMarkdownToPlainText } from "@openclaw/normalization-core/markdown-plain-text";
import type { JSX } from "@solidjs/web";
import { createMemo, createUniqueId, onSettled } from "solid-js";
import { cronRunEntryMatchesLink } from "../../../../src/cron/run-link.js";
import type { CronRunLogEntry } from "../../api/types.ts";
import { AgentRowChip } from "../../components/agent-row-chip.tsx";
import { toSanitizedMarkdownHtml } from "../../components/markdown.ts";
import { IconButton } from "../../components/solid/icon-button.tsx";
import { Icon } from "../../components/solid/icon.tsx";
import { Popover } from "../../components/solid/popover.tsx";
import { SanitizedHtml } from "../../components/solid/sanitized-html.tsx";
import { formatDurationCompact, formatDurationHuman } from "../../lib/format-duration.ts";
import { formatUiExternalText } from "../../lib/format-error.ts";
import {
  createCompactMsFormatter,
  formatCompactTokenCount,
  formatRelativeTimestamp,
} from "../../lib/format.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { RUN_DELIVERY_LABELS, runStatusLabel } from "./view-run-status.ts";
import type { CronProps } from "./view-types.ts";

export function CompactRun(
  props: Parameters<typeof LegacyRun>[0] & {
    agentId: string | null | undefined;
    showAgent?: boolean;
  },
) {
  const id = createUniqueId();
  const failed = () => props.entry.status === "error" || props.entry.completionStatus === "failed";
  const status = () =>
    runStatusLabel(props.entry.status ?? "unknown", props.entry.completionStatus);
  const error = () => formatUiExternalText(props.entry.error || props.entry.deliveryError);
  const summary = createMemo(() => {
    const value = props.entry.summary?.trim();
    if (!value || props.entry.status !== "ok" || failed()) {
      return "";
    }
    const normalize = (text: string) => text.replace(/\.$/, "").toLocaleLowerCase();
    return [t("cron.runEntry.noSummary"), t("cron.runs.deliveryNotRequested")].some(
      (placeholder) => normalize(placeholder) === normalize(value),
    )
      ? ""
      : flattenMarkdownToPlainText(value);
  });
  let row!: HTMLDivElement;
  const entry = createMemo(() => props.entry);
  onSettled(() => props.onRunMount?.(row, entry));
  return (
    <div
      ref={(element) => {
        row = element;
        props.rowRef?.(element);
      }}
      data-index={props.index}
      style={props.style}
      onFocusIn={() => props.onFocus?.()}
      class={[
        "cron-run-entry cron-run-entry--compact",
        {
          "cron-run-entry--highlighted": Boolean(
            props.highlightedRunId && cronRunEntryMatchesLink(props.highlightedRunId, props.entry),
          ),
        },
      ]}
    >
      <span
        class={[
          "cron-last-glyph cron-run-status",
          {
            "cron-last-glyph--ok": props.entry.status === "ok" && !failed(),
            "cron-last-glyph--error": failed(),
          },
        ]}
        role="img"
        aria-label={status()}
        title={status()}
      >
        <Icon name={failed() ? "x" : props.entry.status === "ok" ? "check" : "cornerDownRight"} />
      </span>
      <div class="cron-run-entry__main">
        <Popover
          id={`cron-run-details-${id}`}
          label={t("cron.runEntry.details")}
          triggerAriaLabel={null}
          triggerTitle={t("cron.runEntry.details")}
          triggerClass="cron-table__name cron-run-entry__title"
          trigger={props.entry.jobName ?? props.entry.jobId}
          class="cron-run-details"
          placement="bottom-start"
          lazy="while-open"
        >
          <LegacyRun
            entry={props.entry}
            formatTimestamp={props.formatTimestamp}
            onViewRunTranscript={props.onViewRunTranscript}
          />
        </Popover>
        <div class="cron-run-entry__secondary muted">
          {props.showAgent !== false && props.agentId !== null ? (
            <>
              <AgentRowChip agentId={props.agentId ?? undefined} />
              <span aria-hidden="true">·</span>
            </>
          ) : undefined}
          <span>{formatRelativeTimestamp(props.entry.runAtMs ?? props.entry.ts)}</span>
          {props.entry.durationMs !== undefined ? (
            <>
              <span aria-hidden="true">·</span>
              <span>
                {formatDurationCompact(props.entry.durationMs) ??
                  formatDurationHuman(props.entry.durationMs, t("common.na"))}
              </span>
            </>
          ) : undefined}
        </div>
        {error() ? (
          <div class="cron-run-entry__error" title={error()}>
            {error()}
          </div>
        ) : summary() ? (
          <div class="cron-run-entry__summary muted" title={summary()}>
            {summary()}
          </div>
        ) : undefined}
      </div>
      <div class="cron-run-entry__time muted">{props.formatTimestamp(props.entry.ts)}</div>
      <div class="cron-run-entry__actions">
        {props.entry.runId || props.entry.runAtMs !== undefined || props.entry.sessionKey ? (
          <IconButton
            size={28}
            glyph="row"
            icon="messageSquare"
            label={t("cron.runEntry.viewTranscript")}
            onClick={(event) => props.onViewRunTranscript?.(props.entry, event.currentTarget)}
          />
        ) : undefined}
      </div>
    </div>
  );
}

function RunError(props: { error: CronRunLogEntry["error"] }) {
  return <div class="muted">{formatUiExternalText(props.error)}</div>;
}
export function LegacyRun(props: {
  entry: CronRunLogEntry;
  rowRef?: (element: HTMLDivElement) => void;
  onFocus?: () => void;
  index?: number;
  style?: JSX.CSSProperties;
  formatTimestamp: ReturnType<typeof createCompactMsFormatter>;
  highlightedRunId?: string | null;
  onViewRunTranscript?: CronProps["onViewRunTranscript"];
  onRunMount?: (
    ...args: Parameters<NonNullable<CronProps["onRunMount"]>>
  ) => (() => void) | undefined;
}) {
  const status = () =>
    runStatusLabel(props.entry.status ?? "unknown", props.entry.completionStatus);
  const delivery = () =>
    t(
      RUN_DELIVERY_LABELS.get(props.entry.deliveryStatus ?? "not-requested") ??
        "cron.runs.deliveryUnknown",
    );
  const usageSummary = createMemo(() => {
    const usage = props.entry.usage;
    return usage?.total_tokens !== undefined
      ? t("cron.runEntry.tokens", { count: formatCompactTokenCount(usage.total_tokens) })
      : usage?.input_tokens !== undefined && usage.output_tokens !== undefined
        ? t("cron.runEntry.inputOutputTokens", {
            input: formatCompactTokenCount(usage.input_tokens),
            output: formatCompactTokenCount(usage.output_tokens),
          })
        : null;
  });
  const bodySource = () =>
    props.entry.summary || formatUiExternalText(props.entry.error) || t("cron.runEntry.noSummary");
  const showErrorInMeta = () => Boolean(props.entry.error) && Boolean(props.entry.summary);
  const suppressionReason = () => formatUiExternalText(props.entry.deliverySuppressionReason);
  const facts = createMemo(() =>
    [
      delivery(),
      suppressionReason()
        ? t("cron.runEntry.deliverySuppression", { reason: suppressionReason() })
        : null,
      props.entry.model,
      props.entry.provider,
      usageSummary(),
    ].filter(Boolean),
  );
  const highlighted = createMemo(() =>
    props.highlightedRunId && cronRunEntryMatchesLink(props.highlightedRunId, props.entry)
      ? props.highlightedRunId
      : null,
  );
  let row!: HTMLDivElement;
  const entry = createMemo(() => props.entry);
  onSettled(() => props.onRunMount?.(row, entry));
  return (
    <div
      ref={(element) => {
        row = element;
        props.rowRef?.(element);
      }}
      data-index={props.index}
      style={props.style}
      onFocusIn={() => props.onFocus?.()}
      class={["cron-run-entry", { "cron-run-entry--highlighted": Boolean(highlighted()) }]}
    >
      <div class="cron-run-entry__header">
        <div class="cron-run-entry__main">
          <div class="cron-run-entry__title">
            {props.entry.jobName ?? props.entry.jobId}
            <span class="muted"> · {status()}</span>
          </div>
          <div class="cron-run-entry__facts muted">{facts().join(" · ")}</div>
        </div>
        <div class="cron-run-entry__meta">
          <div>{props.formatTimestamp(props.entry.ts)}</div>
          {props.entry.runAtMs !== undefined ? (
            <div class="muted">
              {t("cron.runEntry.runAt")} {props.formatTimestamp(props.entry.runAtMs)}
            </div>
          ) : undefined}
          <div class="muted">
            {props.entry.durationMs !== undefined
              ? (formatDurationCompact(props.entry.durationMs) ??
                formatDurationHuman(props.entry.durationMs, t("common.na")))
              : t("common.na")}
          </div>
          {props.entry.nextRunAtMs !== undefined ? (
            <div class="muted">
              {t("cron.runEntry.next", { rel: props.formatTimestamp(props.entry.nextRunAtMs) })}
            </div>
          ) : undefined}
          {props.entry.runId || props.entry.runAtMs !== undefined || props.entry.sessionKey ? (
            <div>
              <button
                class="btn btn--sm"
                onClick={(event) => props.onViewRunTranscript?.(props.entry, event.currentTarget)}
              >
                {t("cron.runEntry.viewTranscript")}
              </button>
            </div>
          ) : undefined}
          {showErrorInMeta() ? <RunError error={props.entry.error} /> : undefined}
          {props.entry.deliveryError ? <RunError error={props.entry.deliveryError} /> : undefined}
        </div>
      </div>
      <SanitizedHtml
        tag="div"
        class="cron-run-entry__body chat-text"
        html={toSanitizedMarkdownHtml(bodySource())}
      />
    </div>
  );
}
