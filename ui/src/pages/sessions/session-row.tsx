import {
  normalizeFastMode,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { createMemo, For, Show } from "solid-js";
import { formatAgentRuntimeLabel } from "../../../../src/shared/agent-runtime-display.js";
import { formatFastModeValue } from "../../../../src/shared/fast-mode.js";
import type { AgentIdentityResult, GatewaySessionRow } from "../../api/types.ts";
import { Icon, type IconName } from "../../components/solid/icon.tsx";
import { SettingsStatus } from "../../components/solid/settings-ui.tsx";
import {
  formatThinkingOverrideLabel,
  normalizeThinkingOptionValue,
  resolveChatThinkingSelectState,
} from "../../lib/chat/thinking.ts";
import { formatDurationCompact } from "../../lib/format-duration.ts";
import { formatRelativeTimestamp, formatCompactTokenCount } from "../../lib/format.ts";
import { handleContextMenuEvent } from "../../lib/keyboard-shortcuts.ts";
import { shouldHandleNavigationClick } from "../../lib/navigation-click.ts";
import { formatSessionTokens } from "../../lib/presenter.ts";
import { t } from "../../lib/reactive/i18n.ts";
import { resolveSessionDisplayKind } from "../../lib/session-display.ts";
import { formatGoalDetail, formatGoalSummary } from "../../lib/session-goal.ts";
import { isSessionRunActive } from "../../lib/session-run-state.ts";
import { resolveSessionContextLimit } from "../../lib/sessions/context-budget.ts";
import { SESSION_DRAG_MIME } from "../../lib/sessions/drag.ts";
import {
  resolveSessionPreferredFace,
  sessionNavigationTarget,
} from "../../lib/sessions/route-navigation.ts";
import { formatSessionArchiveReason } from "../../lib/sessions/session-archive-reason.ts";
import { parseAgentSessionKey, parseSessionKeyParts } from "../../lib/sessions/session-key.ts";
import type { JSX as SolidJSX } from "../../types/solid-elements.js";
import { CategoryCell } from "./category-cell.tsx";
import { SessionStatusBadge } from "./session-status.tsx";
import { categoryDropHandlers } from "./sessions-filters.tsx";
import type { SessionsProps } from "./view-types.ts";
import "../../components/agent-row-chip.ts";
import "../../components/tooltip.ts";
import "../../components/web-awesome.ts";
import "../../styles/capacity-meter.css";

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

const SESSION_KIND_ICONS = {
  cron: "clock",
  direct: "messageSquare",
  group: "users",
  global: "globe",
  unknown: "circle",
} satisfies Record<GatewaySessionRow["kind"] | "cron", IconName>;

// Kind glyph anchors each row; the dot mirrors isSessionRunActive so run
// state also reads at the identity anchor while scanning the key column.
function renderSessionAvatar(row: GatewaySessionRow) {
  const displayKind = resolveSessionDisplayKind(row);
  return (
    <span class={`session-avatar session-avatar--${displayKind}`} aria-hidden="true">
      <Icon name={SESSION_KIND_ICONS[displayKind]} />
      {isSessionRunActive(row) ? <span class="session-avatar__status" /> : undefined}
    </span>
  );
}

const CONTEXT_METER_WARN_PERCENT = 65;
const CONTEXT_METER_DANGER_PERCENT = 85;

function renderTokensCell(row: GatewaySessionRow) {
  const total = row.totalTokens;
  if (typeof total !== "number" || !Number.isFinite(total)) {
    return <span class="muted">{t("common.na")}</span>;
  }
  // Stale snapshots (post-compaction, incomplete usage reporting) stay visible
  // as "~" orientation but must not drive warn/danger tones; mirrors the chat
  // composer's context-usage convention.
  const fresh = row.totalTokensFresh !== false;
  const totalLabel = `${fresh ? "" : "~"}${formatCompactTokenCount(total)}`;
  const limit = resolveSessionContextLimit(row);
  const context = limit.tokens > 0 ? limit.tokens : null;
  if (!context) {
    return <span class="session-tokens__value">{totalLabel}</span>;
  }
  const percent = Math.min(100, Math.round((total / context) * 100));
  const tone = !fresh
    ? "stale"
    : percent >= CONTEXT_METER_DANGER_PERCENT
      ? "danger"
      : percent >= CONTEXT_METER_WARN_PERCENT
        ? "warn"
        : "ok";
  const titleKey = limit.fromLastPrompt ? "promptBudgetUsage" : "contextUsage";
  const title = t(`sessionsView.${titleKey}${fresh ? "" : "Approx"}`, {
    percent: String(percent),
    used: total.toLocaleString(),
    context: context.toLocaleString(),
  });
  return (
    <openclaw-tooltip prop:content={title}>
      <div class="session-tokens">
        <span class="session-tokens__value">
          {totalLabel} / {formatCompactTokenCount(context)}
        </span>
        <span
          class={`session-context-meter session-context-meter--${tone}`}
          role="img"
          aria-label={title}
        >
          <span class="session-context-meter__fill" style={{ width: `${percent}%` }} />
        </span>
      </div>
    </openclaw-tooltip>
  );
}

function formatRuntimeMs(runtimeMs: number | undefined): string | null {
  if (typeof runtimeMs !== "number" || !Number.isFinite(runtimeMs) || runtimeMs < 0) {
    return null;
  }
  return formatDurationCompact(runtimeMs) ?? "0ms";
}

function SessionGoalStatus(props: { goal: GatewaySessionRow["goal"] }) {
  const kind = createMemo(() =>
    props.goal?.status === "active" || props.goal?.status === "complete" ? "ok" : "warn",
  );
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
): Array<{ label: string; value: string }> {
  const details: Array<{ label: string; value: string }> = [
    { label: t("sessionsView.key"), value: row.key },
    { label: t("sessionsView.kind"), value: resolveSessionDisplayKind(row) },
    { label: t("sessionsView.updated"), value: updated },
    { label: t("sessionsView.tokens"), value: formatSessionTokens(row) },
  ];
  const add = (label: string, value: string | null | undefined) => {
    const normalized = normalizeOptionalString(value);
    if (normalized) {
      details.push({ label, value: normalized });
    }
  };
  add(t("sessionsView.group"), row.category);
  add(t("sessionsView.status"), row.status);
  if (row.goal) {
    details.push({ label: t("sessionsView.goal"), value: formatGoalDetail(row.goal) });
  }
  add(t("sessionsView.goalNote"), row.goal?.lastStatusNote);
  add(t("sessionsView.model"), row.model);
  add(t("sessionsView.provider"), row.modelProvider);
  add(t("sessionsView.runtime"), formatAgentRuntimeLabel(row.agentRuntime));
  add(t("sessionsView.runDuration"), formatRuntimeMs(row.runtimeMs));
  add(t("sessionsView.surface"), row.surface);
  add(t("sessionsView.subject"), row.subject);
  add(t("sessionsView.room"), row.room);
  add(t("sessionsView.space"), row.space);
  add(t("sessionsView.sessionId"), row.sessionId);
  if (row.archiveReason) {
    details.push({
      label: t("sessionsView.archiveReason"),
      value: formatSessionArchiveReason(row.archiveReason),
    });
  }
  for (const [label, value] of [
    [t("sessionsView.activeRun"), row.hasActiveRun],
    [t("sessionsView.archived"), row.archived],
    [t("sessionsView.pinned"), row.pinned],
  ] as const) {
    if (typeof value === "boolean") {
      details.push({ label, value: value ? t("common.yes") : t("common.no") });
    }
  }
  return details;
}

export function sessionsTableColumnCount(options: SessionsProps): number {
  return options.groupBy === "category" ? 8 : 7;
}

function isRowControlTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    Boolean(target.closest("a, button, input, label, select, textarea"))
  );
}

export function SessionRows(props: SessionsProps & { row: GatewaySessionRow }) {
  const row = createMemo(() => props.row);
  const updated = createMemo(() =>
    row().updatedAt ? formatRelativeTimestamp(row().updatedAt) : t("common.na"),
  );
  const isExpanded = createMemo(() => props.expandedSessionKey === row().key);
  const detailsId = createMemo(() => `session-details-${encodeURIComponent(row().key)}`);
  const displayName = createMemo(() => normalizeOptionalString(row().displayName) ?? null);
  const trimmedLabel = createMemo(() => normalizeOptionalString(row().label) ?? "");
  const showDisplayName = createMemo(() =>
    Boolean(displayName() && displayName() !== row().key && displayName() !== trimmedLabel()),
  );
  const keyParts = createMemo(() => parseSessionKeyParts(row().key));
  const agentIdentity = createMemo(() =>
    keyParts() ? getAgentIdentity(props.agentIdentityById, keyParts()!.agentId) : null,
  );
  const identityEmoji = createMemo(() => normalizeOptionalString(agentIdentity()?.emoji) ?? "");
  const identityName = createMemo(() => normalizeOptionalString(agentIdentity()?.name) ?? "");
  const friendlyKeyLabel = createMemo(() =>
    identityName() && keyParts()
      ? `${identityEmoji() ? `${identityEmoji()} ` : ""}${identityName()} (${keyParts()!.channel})`
      : null,
  );
  const keyCellTitle = createMemo(() => friendlyKeyLabel() ?? row().key);
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
  const kindClass = createMemo(() => `session-kind session-kind--${displayKind()}`);
  const rowClass = createMemo(() =>
    [
      "session-data-row",
      "session-data-row--expandable",
      props.statusFilter === "all" && row().archived === true ? "session-data-row--archived" : "",
      isExpanded() ? "session-data-row--expanded" : "",
      props.sessionMenu?.key === row().key ? "session-data-row--menu-open" : "",
    ]
      .filter(Boolean)
      .join(" "),
  );
  // The {count} placeholder predates the drawer redesign; it carries the session title.
  const detailsToggleLabel = createMemo(() =>
    isExpanded()
      ? t("sessionsView.hideSessionDetails", { count: keyCellTitle() })
      : t("sessionsView.showSessionDetails", { count: keyCellTitle() }),
  );
  const categoryMode = createMemo(() => props.groupBy === "category");
  // Dropping on a row targets that row's group so the whole section area accepts drops.
  const rowDrop = createMemo(() =>
    categoryDropHandlers(props, normalizeOptionalString(row().category) ?? null),
  );
  const openMenuFromEvent: SolidJSX.EventHandler<
    HTMLTableRowElement,
    MouseEvent | KeyboardEvent
  > = (event) => {
    const currentRow = row();
    const onOpenSessionMenu = props.onOpenSessionMenu;
    return handleContextMenuEvent(
      event,
      event instanceof KeyboardEvent
        ? event.currentTarget.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')
        : null,
      (trigger, x, y) => onOpenSessionMenu(currentRow, { x, y }, trigger),
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
          <openclaw-tooltip prop:content={keyCellTitle()}>
            <div class={friendlyKeyLabel() ? "session-key-cell" : "mono session-key-cell"}>
              {renderSessionAvatar(row())}
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
                      href={chatUrl()}
                      class="session-link"
                      onClick={(e: MouseEvent) => {
                        if (!shouldHandleNavigationClick(e)) {
                          return;
                        }
                        e.preventDefault();
                        props.onNavigateToChat(row().key);
                      }}
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
                {row().kind === "global" && !row().agentId ? undefined : (
                  <openclaw-agent-row-chip
                    prop:agentId={parseAgentSessionKey(row().key)?.agentId ?? row().agentId}
                  />
                )}
                {showDisplayName() ? (
                  <span class="muted session-key-display-name">{displayName()}</span>
                ) : undefined}
              </div>
            </div>
          </openclaw-tooltip>
        </td>
        {categoryMode() ? <CategoryCell {...props} row={row()} /> : undefined}
        <td>
          <span class={kindClass()}>{displayKind()}</span>
        </td>
        <td class="session-status-col">
          <div class="session-status-stack">
            <SessionStatusBadge row={row()} /> <SessionGoalStatus goal={row().goal} />
            {props.statusFilter === "all" && row().archived === true ? (
              <SettingsStatus kind="muted" label={t("sessionsView.archived")} />
            ) : undefined}
          </div>
        </td>
        <td>{updated()}</td>
        <td class="session-token-cell">{renderTokensCell(row())}</td>
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
              class="icon-btn"
              type="button"
              title={t("chat.sidebar.openSessionMenu")}
              aria-label={t("chat.sidebar.openSessionMenu")}
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

            <div class="session-details-section">
              <div class="session-details-panel__eyebrow">{t("sessionsView.overrides")}</div>
              <div class="session-overrides-grid">
                <label class="session-override-field">
                  <span class="session-override-field__label">{t("sessionsView.label")}</span>
                  <input
                    class="settings-input"
                    value={labelValue()}
                    disabled={props.loading || Boolean(labelDisabledReason())}
                    title={labelDisabledReason() ?? undefined}
                    placeholder={t("sessionsView.optionalPlaceholder")}
                    onChange={(e) => {
                      const value = normalizeOptionalString(e.currentTarget.value) ?? null;
                      props.onPatch(row().key, { label: value }, { sessionScope: true });
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
                          disabled={props.loading || Boolean(props.patchAdminDisabledReason)}
                          title={props.patchAdminDisabledReason ?? undefined}
                          onChange={(event) => override().onChange(event.currentTarget.value)}
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
              <For each={sessionDetailItems(row(), updated())}>
                {(item) => (
                  <div class="session-detail-stat">
                    <div class="session-detail-stat__label">{item.label}</div>
                    <openclaw-tooltip prop:content={item.value}>
                      <div class="session-detail-stat__value">{item.value}</div>
                    </openclaw-tooltip>
                  </div>
                )}
              </For>
            </div>
          </div>
        </td>
      </tr>
    );
  }
}
