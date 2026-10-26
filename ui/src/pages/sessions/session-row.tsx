import {
  normalizeFastMode,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { createMemo, Errored, For, isPending, latest, Loading, Show } from "solid-js";
import { formatAgentRuntimeLabel } from "../../../../src/shared/agent-runtime-display.js";
import { formatFastModeValue } from "../../../../src/shared/fast-mode.js";
import {
  formatGoalDetail,
  formatGoalSummary,
} from "../../../../src/shared/session-goal-display.js";
import type { AgentIdentityResult, GatewaySessionRow, SessionRunStatus } from "../../api/types.ts";
import { AgentRowChip } from "../../components/agent-row-chip.tsx";
import { Icon } from "../../components/solid/icon.tsx";
import { SettingsStatus } from "../../components/solid/settings-ui.tsx";
import {
  formatThinkingOverrideLabel,
  normalizeThinkingOptionValue,
  resolveChatThinkingSelectState,
} from "../../lib/chat/thinking.ts";
import { formatDurationCompact } from "../../lib/format-duration.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { formatRelativeTimestamp } from "../../lib/format.ts";
import { handleContextMenuEvent } from "../../lib/keyboard-shortcuts.ts";
import { handleNavigationClick } from "../../lib/navigation-click.ts";
import { formatSessionTokens } from "../../lib/presenter.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { liveValue as createLiveValue } from "../../lib/reactive/live-value.ts";
import { resolveSessionDisplayKind } from "../../lib/session-display.ts";
import { isSessionRunStateActive } from "../../lib/session-run-state.ts";
import { SESSION_DRAG_MIME } from "../../lib/sessions/drag.ts";
import {
  resolveSessionPreferredFace,
  sessionNavigationTarget,
} from "../../lib/sessions/route-navigation.ts";
import { formatSessionArchiveReason } from "../../lib/sessions/session-archive-reason.ts";
import { parseAgentSessionKey, parseSessionKeyParts } from "../../lib/sessions/session-key.ts";
import type { JSX as SolidJSX } from "../../types/solid-elements.js";
import { CategoryCell } from "./category-cell.tsx";
import { categoryDropHandlers } from "./sessions-filters.tsx";
import type { SessionsProps } from "./view-types.ts";
import "../../components/tooltip.ts";

const SESSION_RUN_STATUS_LABELS = {
  queued: "sessionsView.statusQueued",
  running: "sessionsView.statusRunning",
  done: "sessionsView.statusDone",
  failed: "sessionsView.statusFailed",
  interrupted: "sessionsView.statusInterrupted",
  killed: "sessionsView.statusKilled",
  timeout: "sessionsView.statusTimeout",
} as const satisfies Record<SessionRunStatus, string>;

function SessionStatusBadge(props: { row: GatewaySessionRow }) {
  const active = () => isSessionRunStateActive(props.row);
  const idle = () =>
    props.row.hasActiveRun === false && (!props.row.status || props.row.status === "running");
  const label = () =>
    t(
      props.row.status === "queued"
        ? "sessionsView.statusQueued"
        : active()
          ? "sessionsView.statusLive"
          : idle()
            ? "sessionsView.statusIdle"
            : (props.row.status && SESSION_RUN_STATUS_LABELS[props.row.status]) ||
              "sessionsView.statusUnknown",
    );
  const kind = (): "ok" | "warn" | "muted" | "danger" =>
    props.row.status === "queued"
      ? "warn"
      : active() || props.row.status === "done"
        ? "ok"
        : idle() || !props.row.status || props.row.status === "interrupted"
          ? "muted"
          : "danger";
  const detail = () => `${t("sessionsView.status")}: ${label()}`;
  // The tooltip needs a focusable trigger for keyboard access.
  return (
    <openclaw-tooltip prop:content={detail()}>
      <span tabindex="0" aria-label={detail()}>
        <SettingsStatus kind={kind()} label={label()} />
      </span>
    </openclaw-tooltip>
  );
}

const VERBOSE_LEVEL_VALUES = ["", "off", "on", "full"] as const;
const FAST_LEVEL_VALUES = ["", "auto", "on", "off"] as const;
const REASONING_LEVELS = ["", "off", "on", "stream"] as const;
export function getAgentIdentity(
  agentIdentityById: Record<string, AgentIdentityResult>,
  agentId: string,
): AgentIdentityResult | null {
  return Object.hasOwn(agentIdentityById, agentId) ? (agentIdentityById[agentId] ?? null) : null;
}

function buildSessionLevelOptions(
  values: readonly string[],
  explicitOff = false,
): Array<{ value: string; label: string }> {
  return values.map((value) => ({
    value,
    label:
      value === ""
        ? t("sessionsView.inherit")
        : explicitOff && value === "off"
          ? t("sessionsView.offExplicit")
          : t(`sessionsView.${value}`),
  }));
}

function formatRuntimeMs(runtimeMs: number | undefined): string | null {
  if (typeof runtimeMs !== "number" || !Number.isFinite(runtimeMs) || runtimeMs < 0) {
    return null;
  }
  return formatDurationCompact(runtimeMs) ?? "0ms";
}

function SessionGoalStatus(props: { goal: GatewaySessionRow["goal"] }) {
  const kind = (): "ok" | "warn" =>
    props.goal?.status === "active" || props.goal?.status === "complete" ? "ok" : "warn";
  const detail = createMemo(() => {
    const goal = props.goal;
    return goal ? formatGoalDetail(goal) : "";
  });
  const summary = createMemo(() => {
    const goal = props.goal;
    return goal ? formatGoalSummary(goal) : "";
  });
  // tabindex lets keyboard users trigger the tooltip; aria-label exposes the
  // full objective detail that sighted users only get on hover.
  return (
    <Show when={props.goal}>
      <openclaw-tooltip prop:content={detail()}>
        <span tabindex="0" aria-label={detail()}>
          <SettingsStatus kind={kind()} label={summary()} />
        </span>
      </openclaw-tooltip>
    </Show>
  );
}

function sessionDetailItems(
  row: GatewaySessionRow,
  updated: string,
): Array<{ key: string; value: string }> {
  const details: Array<{ key: string; value: string }> = [
    { key: "sessionsView.key", value: row.key },
    { key: "sessionsView.kind", value: resolveSessionDisplayKind(row) },
    { key: "sessionsView.updated", value: updated },
    { key: "sessionsView.tokens", value: formatSessionTokens(row) },
  ];
  const add = (key: string, value: string | null | undefined) => {
    const normalized = normalizeOptionalString(value);
    if (normalized) {
      details.push({ key, value: normalized });
    }
  };
  add("sessionsView.group", row.category);
  add("sessionsView.status", row.status);
  if (row.goal) {
    details.push({ key: "sessionsView.goal", value: formatGoalDetail(row.goal) });
  }
  add("sessionsView.goalNote", row.goal?.lastStatusNote);
  add("sessionsView.model", row.model);
  add("sessionsView.provider", row.modelProvider);
  add("sessionsView.runtime", formatAgentRuntimeLabel(row.agentRuntime));
  add("sessionsView.runDuration", formatRuntimeMs(row.runtimeMs));
  add("sessionsView.surface", row.surface);
  add("sessionsView.subject", row.subject);
  add("sessionsView.room", row.room);
  add("sessionsView.space", row.space);
  add("sessionsView.sessionId", row.sessionId);
  if (row.archiveReason) {
    details.push({
      key: "sessionsView.archiveReason",
      value: formatSessionArchiveReason(row.archiveReason),
    });
  }
  for (const [key, value] of [
    ["sessionsView.activeRun", row.hasActiveRun],
    ["sessionsView.archived", row.archived],
    ["sessionsView.pinned", row.pinned],
  ] as const) {
    if (typeof value === "boolean") {
      details.push({ key, value: value ? t("common.yes") : t("common.no") });
    }
  }
  return details;
}

export function sessionsTableColumnCount(options: SessionsProps): number {
  return 4 + Number(options.allAgentsScope) + Number(options.groupBy === "category");
}

function isRowControlTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    Boolean(target.closest("a, button, input, label, select, textarea"))
  );
}

export function SessionRows(props: SessionsProps & { row: GatewaySessionRow }) {
  let menuTrigger: HTMLButtonElement | null = null;
  let sessionLink: HTMLAnchorElement | undefined;
  const row = createMemo(() => props.row);
  const updated = createMemo(() =>
    row().updatedAt ? formatRelativeTimestamp(row().updatedAt) : t("common.na"),
  );
  const isExpanded = () => props.expandedSessionKey === row().key;
  const detailsId = () => `session-details-${encodeURIComponent(row().key)}`;
  const displayName = () => normalizeOptionalString(row().displayName) ?? null;
  const trimmedLabel = () => normalizeOptionalString(row().label) ?? "";
  const showDisplayName = () =>
    Boolean(displayName() && displayName() !== row().key && displayName() !== trimmedLabel());
  const keyParts = createMemo(() => parseSessionKeyParts(row().key));
  const agentIdentity = createMemo(() =>
    keyParts() ? getAgentIdentity(props.agentIdentityById, keyParts()!.agentId) : null,
  );
  const identityEmoji = () => normalizeOptionalString(agentIdentity()?.emoji) ?? "";
  const identityName = () => normalizeOptionalString(agentIdentity()?.name) ?? "";
  const friendlyKeyLabel = () =>
    identityName() && keyParts()
      ? `${identityEmoji() ? `${identityEmoji()} ` : ""}${identityName()} (${keyParts()!.channel})`
      : null;
  const keyCellTitle = () => friendlyKeyLabel() ?? row().key;
  const canLink = createMemo(() => row().kind !== "global");
  const chatUrl = createMemo(() =>
    canLink()
      ? sessionNavigationTarget({
          face: resolveSessionPreferredFace(row()),
          sessionKey: row().key,
          fallbackAgentId: props.agentId,
          basePath: props.basePath,
          row: row(),
          mainKey: props.mainKey,
        }).href
      : undefined,
  );
  const displayKind = createMemo(() => resolveSessionDisplayKind(row()));
  const kindClass = () => ["session-kind", `session-kind--${displayKind()}`];
  const rowClass = () => [
    "session-data-row session-data-row--expandable",
    {
      "session-data-row--archived": props.statusFilter === "all" && row().archived === true,
      "session-data-row--expanded": isExpanded(),
      "session-data-row--menu-open": props.sessionMenu?.key === row().key,
    },
  ];
  // The {count} placeholder predates the drawer redesign; it carries the session title.
  const detailsToggleLabel = () =>
    isExpanded()
      ? t("sessionsView.hideSessionDetails", { count: keyCellTitle() })
      : t("sessionsView.showSessionDetails", { count: keyCellTitle() });
  const categoryMode = () => props.groupBy === "category";
  // Dropping on a row targets that row's group so the whole section area accepts drops.
  const rowDrop = createMemo(() =>
    categoryDropHandlers(props, normalizeOptionalString(row().category) ?? null),
  );
  const openMenuFromEvent: SolidJSX.EventHandler<
    HTMLTableRowElement,
    MouseEvent | KeyboardEvent
  > = (event) => {
    return handleContextMenuEvent(
      event,
      event instanceof KeyboardEvent ? menuTrigger : null,
      (trigger, x, y) => props.onOpenSessionMenu(row(), { x, y }, trigger),
    );
  };

  return (
    <>
      <tr
        class={rowClass()}
        tabindex="0"
        aria-controls={isExpanded() ? detailsId() : undefined}
        draggable={categoryMode() ? "true" : undefined}
        aria-description={categoryMode() ? t("sessionsView.dragSessionHint") : undefined}
        onDragStart={(event: DragEvent) => {
          if (!categoryMode()) {
            return;
          }
          event.dataTransfer?.setData(SESSION_DRAG_MIME, row().key);
          if (event.dataTransfer) {
            event.dataTransfer.effectAllowed = "move";
          }
        }}
        onDragOver={(event: DragEvent) => rowDrop().dragover?.(event)}
        onDragLeave={(event: DragEvent) => rowDrop().dragleave?.(event)}
        onDrop={(event: DragEvent) => rowDrop().drop?.(event)}
        onContextMenu={openMenuFromEvent}
        onClick={(e: MouseEvent) => {
          if (isRowControlTarget(e.target)) {
            return;
          }
          props.onToggleDetails(row().key);
        }}
        onKeyDown={(e) => {
          openMenuFromEvent(e);
          if (e.defaultPrevented || isRowControlTarget(e.target)) {
            return;
          }
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            props.onToggleDetails(row().key);
          }
        }}
      >
        <td class="data-table-checkbox-col">
          <input
            type="checkbox"
            checked={props.selectedKeys.has(row().key)}
            onChange={() => props.onToggleSelect(row().key)}
            aria-label={`${t("sessionsView.selectSession")}: ${row().key}`}
          />
        </td>
        <td class="data-table-key-col">
          <openclaw-tooltip
            prop:content={keyCellTitle()}
            prop:descriptionTarget={canLink() ? () => sessionLink ?? null : undefined}
          >
            <div class={["session-key-cell", { mono: !friendlyKeyLabel() }]}>
              <div class="session-key-cell__text">
                <span class="session-key-cell__primary">
                  {row().unread === true ? (
                    <span
                      class="session-unread-dot"
                      role="img"
                      aria-label={t("sessionsView.unread")}
                    />
                  ) : undefined}
                  {canLink() ? (
                    <a
                      ref={(element) => (sessionLink = element)}
                      href={chatUrl()}
                      class="session-link"
                      onClick={(e: MouseEvent) =>
                        handleNavigationClick(e, () => props.onNavigateToChat(row().key))
                      }
                    >
                      {friendlyKeyLabel() ?? row().key}
                    </a>
                  ) : (
                    <span>{friendlyKeyLabel() ?? row().key}</span>
                  )}
                  {trimmedLabel() ? (
                    <span class="session-label-chip" title={trimmedLabel()}>
                      {trimmedLabel()}
                    </span>
                  ) : undefined}
                </span>
                {showDisplayName() ? (
                  <span class="muted session-key-display-name">{displayName()}</span>
                ) : undefined}
              </div>
            </div>
          </openclaw-tooltip>
        </td>
        {props.allAgentsScope ? (
          <td class="session-agent-col">
            {row().kind === "global" && !row().agentId ? undefined : (
              <AgentRowChip agentId={parseAgentSessionKey(row().key)?.agentId ?? row().agentId} />
            )}
          </td>
        ) : undefined}
        {categoryMode() ? <CategoryCell {...props} row={row()} /> : undefined}
        <td>{updated()}</td>
        <td class="session-actions-cell">
          <div class="session-actions">
            <button
              class="session-details-toggle"
              type="button"
              aria-expanded={isExpanded() ? "true" : "false"}
              aria-controls={isExpanded() ? detailsId() : undefined}
              aria-label={detailsToggleLabel()}
              onClick={(e: MouseEvent) => {
                e.stopPropagation();
                props.onToggleDetails(row().key);
              }}
            >
              <Icon name="chevronDown" />
            </button>
            <button
              ref={(element) => (menuTrigger = element)}
              class="icon-btn"
              type="button"
              title={t("chat.sidebar.openSessionMenu")}
              aria-label={`${t("chat.sidebar.openSessionMenu")}: ${row().key}`}
              aria-haspopup="menu"
              aria-expanded={props.sessionMenu?.key === row().key ? "true" : "false"}
              onClick={(event) => {
                event.stopPropagation();
                const trigger = event.currentTarget;
                const rect = trigger.getBoundingClientRect();
                props.onOpenSessionMenu(row(), { x: rect.right, y: rect.bottom + 4 }, trigger);
              }}
            >
              <Icon name="moreHorizontal" />
            </button>
          </div>
        </td>
      </tr>
      {isExpanded() ? <SessionDetails /> : undefined}
    </>
  );

  function SessionDetails() {
    const readKey = createMemo(() => props.detailsReadKey());
    const labelDisabledReason = createMemo(() => props.labelDisabledReason?.(row()));
    const labelValue = createMemo(() => row().label ?? "");
    const rawThinking = createMemo(() => row().thinkingLevel ?? "");
    const thinking = createMemo(() =>
      rawThinking() ? normalizeThinkingOptionValue(rawThinking()) : "",
    );
    const fastMode = createMemo(() =>
      row().fastMode === undefined ? "" : formatFastModeValue(row().fastMode),
    );
    const thinkingState = createMemo(() =>
      resolveChatThinkingSelectState({
        catalog: [],
        session: row(),
        defaults: props.result?.defaults,
        sessionKey: row().key,
        sessionsResult: null,
      }),
    );
    const overrides = createMemo(() => [
      {
        id: "thinking",
        label: t("sessionsView.thinking"),
        current: thinking(),
        options: [
          { value: "", label: thinkingState().inherited.displayLabel },
          ...thinkingState().options,
        ],
        onChange: (value: string) => props.onPatch(row().key, { thinkingLevel: value || null }),
      },
      {
        id: "fast",
        label: t("sessionsView.fast"),
        current: fastMode(),
        options: buildSessionLevelOptions(FAST_LEVEL_VALUES),
        onChange: (value: string) =>
          props.onPatch(row().key, {
            fastMode: normalizeFastMode(value) ?? null,
          }),
      },
      {
        id: "verbose",
        label: t("sessionsView.verbose"),
        current: row().verboseLevel ?? "",
        options: buildSessionLevelOptions(VERBOSE_LEVEL_VALUES, true),
        onChange: (value: string) => props.onPatch(row().key, { verboseLevel: value || null }),
      },
      {
        id: "reasoning",
        label: t("sessionsView.reasoning"),
        current: row().reasoningLevel ?? "",
        options: buildSessionLevelOptions(REASONING_LEVELS),
        onChange: (value: string) => props.onPatch(row().key, { reasoningLevel: value || null }),
      },
    ]);

    function ReadDetails() {
      return <>{(latest(props.detailsRead), null)}</>;
    }

    function DetailFields(fields: { pending: boolean }) {
      // Each pending/ready slot retains its own native draft binding.
      const labelRef = createLiveValue(labelValue);
      return (
        <>
          <div class="session-details-section">
            <div class="session-details-panel__eyebrow">{t("sessionsView.overrides")}</div>
            <div class="session-overrides-grid">
              <label class="session-override-field">
                <span class="session-override-field__label">{t("sessionsView.label")}</span>
                <input
                  class="settings-input"
                  ref={labelRef}
                  disabled={props.loading || fields.pending || Boolean(labelDisabledReason())}
                  title={labelDisabledReason() ?? undefined}
                  placeholder={t("sessionsView.optionalPlaceholder")}
                  onChange={(e) => {
                    const value = normalizeOptionalString(e.currentTarget.value) ?? null;
                    void props.onPatch(row().key, { label: value }, { sessionScope: true });
                  }}
                />
              </label>
              <For each={overrides()} keyed={(override) => override.id}>
                {(override) => {
                  const current = createMemo(() => override().current);
                  const choices = createMemo(() => {
                    const options = override().options;
                    const value = current();
                    return !value || options.some((option) => option.value === value)
                      ? options
                      : [...options, { value, label: formatThinkingOverrideLabel(value) }];
                  });
                  return (
                    <label class="session-override-field">
                      <span class="session-override-field__label">{override().label}</span>
                      <select
                        class="settings-select"
                        disabled={
                          props.loading || fields.pending || Boolean(props.patchAdminDisabledReason)
                        }
                        title={props.patchAdminDisabledReason ?? undefined}
                        onChange={(event) => {
                          void override().onChange(event.currentTarget.value);
                        }}
                      >
                        <For each={choices()} keyed={(option) => option.value}>
                          {(option) => {
                            const value = createMemo(() => option().value);
                            const selected = createMemo(() => current() === value());
                            return (
                              <option value={value()} selected={selected()}>
                                {option().label}
                              </option>
                            );
                          }}
                        </For>
                      </select>
                    </label>
                  );
                }}
              </For>
            </div>
          </div>

          <div class="session-details-grid">
            <For each={sessionDetailItems(row(), updated())} keyed={(item) => item.key}>
              {(item) => (
                <div class="session-detail-stat">
                  <div class="session-detail-stat__label">{t(item().key)}</div>
                  {/* Values clip at the column width, so the tooltip is the only full value: it needs a focusable trigger carrying the value it names. */}
                  <openclaw-tooltip prop:content={item().value}>
                    <div
                      class="session-detail-stat__value"
                      tabindex="0"
                      aria-label={`${t(item().key)}: ${item().value}`}
                    >
                      {item().value}
                    </div>
                  </openclaw-tooltip>
                </div>
              )}
            </For>
          </div>
        </>
      );
    }

    return (
      <tr id={detailsId()} class="session-details-row">
        <td colspan={sessionsTableColumnCount(props)}>
          <div class="session-details-panel">
            <div class="session-details-panel__hero">
              <div>
                <div class="session-details-panel__eyebrow">{t("sessionsView.sessionDetails")}</div>
                <div class="session-details-panel__title">{friendlyKeyLabel() ?? row().key}</div>
                {showDisplayName() ? (
                  <div class="muted session-details-panel__subtitle">{displayName()}</div>
                ) : undefined}
              </div>
              <div class="session-details-panel__badges">
                <SessionStatusBadge row={row()} /> <SessionGoalStatus goal={row().goal} />
                <span class={kindClass()}>{resolveSessionDisplayKind(row())}</span>
              </div>
            </div>

            <Loading on={readKey()} fallback={<DetailFields pending />}>
              <Show when={readKey()} keyed>
                <Errored
                  fallback={(error) => (
                    <>
                      <div class="sessions-error" role="alert">
                        {formatUiError(error())}
                      </div>
                      <button class="chip" onClick={() => props.onRetryDetails()}>
                        {t("common.retry")}
                      </button>
                    </>
                  )}
                >
                  <ReadDetails />
                </Errored>
              </Show>
              <DetailFields pending={isPending(props.detailsRead)} />
            </Loading>
          </div>
        </td>
      </tr>
    );
  }
}
