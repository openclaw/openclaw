import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { For, Show, createMemo, createSignal, onCleanup } from "solid-js";
import { formatApprovalDisplayPath } from "../../../src/infra/approval-display-paths.ts";
import { normalizeCommandSpans } from "../../../src/shared/exec-approval-command-spans.ts";
import type { GatewaySessionRow } from "../api/types.ts";
import {
  compactApprovalCommand,
  summarizeApprovalScopeLabel,
} from "../app/approval-presentation.ts";
import type {
  ExecApprovalDecision,
  ExecApprovalRequest,
  ExecApprovalRequestPayload,
} from "../app/exec-approval.ts";
import { formatCountdown } from "../lib/format.ts";
import { t } from "../lib/reactive/i18n.ts";
import { resolveSessionDisplayName } from "../lib/session-display.ts";
import { defineSolidBridge } from "../lit/solid-bridge.ts";
import type { JSX as SolidJSX } from "../types/solid-elements.d.ts";
import { Icon } from "./solid/icon.tsx";

declare module "@solidjs/web" {
  namespace JSX {
    interface IntrinsicElements {
      "openclaw-approval-countdown": HTMLAttributes<HTMLElement> &
        Properties<{ expiresAtMs: number; compact: boolean }>;
    }
  }
}

const DEFAULT_EXEC_APPROVAL_DECISIONS = [
  "allow-once",
  "allow-always",
  "deny",
] as const satisfies readonly ExecApprovalDecision[];

export type ExecApprovalCardProps = {
  approval: ExecApprovalRequest;
  sourceSession?: GatewaySessionRow;
  busy: boolean;
  canGrant: boolean;
  error: string | null;
  variant: "inline" | "modal";
  queueCount?: number;
  onDecision: (approvalId: string, decision: ExecApprovalDecision) => void | Promise<void>;
};

export type SidebarApprovalRowProps = {
  approval: ExecApprovalRequest;
  busy: boolean;
  canGrant: boolean;
  error: string | null;
  openSessionHref?: string;
  sessionTitle?: string | null;
  onDecision: (event: Event, approvalId: string, decision: ExecApprovalDecision) => void;
  onOpenSession?: (event: MouseEvent) => void;
};

export function approvalRemainingLabel(expiresAtMs: number, nowMs: number): string {
  return expiresAtMs > nowMs
    ? t("execApproval.expiresIn", { time: formatCountdown(expiresAtMs, nowMs, true) })
    : t("execApproval.expired");
}

function useApprovalClock(onTick?: (nowMs: number) => void) {
  const [now, setNow] = createSignal(Date.now());
  const timer = setInterval(() => {
    const time = Date.now();
    setNow(time);
    onTick?.(time);
  }, 1_000);
  onCleanup(() => clearInterval(timer));
  return now;
}

export const ApprovalCountdown = defineSolidBridge<{ expiresAtMs: number; compact: boolean }>(
  "openclaw-approval-countdown",
  (props, host) => {
    host.style.display = "contents";
    const now = useApprovalClock((time) => {
      if (!props.compact) {
        host
          .closest("openclaw-modal-dialog")
          ?.setAttribute("description", approvalRemainingLabel(props.expiresAtMs, time));
      }
    });
    return (
      <>
        {props.compact
          ? formatCountdown(props.expiresAtMs, now(), true)
          : approvalRemainingLabel(props.expiresAtMs, now())}
      </>
    );
  },
  {
    properties: {
      expiresAtMs: { default: 0, type: Number },
      compact: { default: false, type: Boolean },
    },
  },
);

function renderMetaRow(label: string, value?: string | null, opts?: { path?: boolean }) {
  if (!value) {
    return undefined;
  }
  return (
    <div class="exec-approval-meta-row">
      <span>{label}</span>
      <span>{opts?.path ? formatApprovalDisplayPath(value) : value}</span>
    </div>
  );
}

function renderCommandWithSpans(request: ExecApprovalRequestPayload) {
  const spans =
    normalizeCommandSpans([...(request.commandSpans ?? [])], request.command.length) ?? [];
  const parts = [];
  let cursor = 0;
  for (const span of spans) {
    if (span.startIndex > cursor) {
      parts.push(request.command.slice(cursor, span.startIndex));
    }
    parts.push(
      <mark class="exec-approval-command-span">
        {request.command.slice(span.startIndex, span.endIndex)}
      </mark>,
    );
    cursor = span.endIndex;
  }
  if (cursor < request.command.length) {
    parts.push(request.command.slice(cursor));
  }
  return <div class="exec-approval-command mono">{parts}</div>;
}

function renderDetails(content: SolidJSX.Element) {
  return (
    <details class="exec-approval-details">
      <summary>{t("execApproval.details")}</summary>
      <div class="exec-approval-meta">{content}</div>
    </details>
  );
}

function renderChip(kind: "plugin" | "agent", id?: string | null) {
  return id ? (
    <span class="exec-approval-chip mono" data-approval-chip={kind}>
      {id}
    </span>
  ) : undefined;
}

function renderExecBody(
  request: ExecApprovalRequestPayload,
  variant: ExecApprovalCardProps["variant"],
) {
  return (
    <>
      {" "}
      {renderCommandWithSpans(request)}
      {request.scope ? (
        <div class="exec-approval-scope">{summarizeApprovalScopeLabel(request.scope)}</div>
      ) : undefined}
      <div class="exec-approval-meta">
        {renderMetaRow(t("execApproval.labels.host"), request.host)}
        {renderMetaRow(t("execApproval.labels.cwd"), request.cwd, { path: true })}
      </div>
      {renderDetails(
        <>
          {renderMetaRow(t("execApproval.labels.resolved"), request.resolvedPath, { path: true })}
          {renderMetaRow(t("execApproval.labels.security"), request.security)}
          {renderMetaRow(t("execApproval.labels.ask"), request.ask)}
          {variant === "modal"
            ? renderMetaRow(t("execApproval.labels.session"), request.sessionKey)
            : undefined}
        </>,
      )}
    </>
  );
}

function renderPluginBody(active: ExecApprovalRequest, variant: ExecApprovalCardProps["variant"]) {
  return (
    <>
      {" "}
      {active.pluginDescription ? (
        <pre class="exec-approval-command mono">{active.pluginDescription}</pre>
      ) : undefined}
      {active.pluginDetail ? (
        <pre class="exec-approval-command mono" dir="ltr">
          {active.pluginDetail}
        </pre>
      ) : undefined}
      {variant === "modal" && active.request.sessionKey
        ? renderDetails(renderMetaRow(t("execApproval.labels.session"), active.request.sessionKey))
        : undefined}
    </>
  );
}

function approvalDecisionLabel(decision: ExecApprovalDecision, approval: ExecApprovalRequest) {
  if (approval.kind === "plugin" && Array.isArray(approval.pluginActions)) {
    for (const action of approval.pluginActions) {
      if (isRecord(action) && action.kind === "decision" && action.decision === decision) {
        const label = normalizeOptionalString(action.label);
        if (label) {
          return label;
        }
      }
    }
  }
  return t(
    decision === "allow-once"
      ? "execApproval.allowOnce"
      : decision === "allow-always"
        ? approval.kind === "exec"
          ? "execApproval.alwaysAllowHere"
          : "execApproval.alwaysAllow"
        : "execApproval.deny",
  );
}

function decisionClass(decision: ExecApprovalDecision) {
  return decision === "allow-once" ? "btn primary" : decision === "deny" ? "btn danger" : "btn";
}

function decisionShortcut(decision: ExecApprovalDecision) {
  return decision === "allow-once"
    ? "Ctrl/Cmd+Enter"
    : decision === "allow-always"
      ? "Ctrl/Cmd+Shift+Enter"
      : "Ctrl/Cmd+D";
}

export function resolveApprovalDecisions(
  active: ExecApprovalRequest,
): readonly ExecApprovalDecision[] {
  if (active.request.allowedDecisions?.length) {
    return active.request.allowedDecisions;
  }
  return active.kind === "exec" && active.request.ask === "always"
    ? ["allow-once", "deny"]
    : DEFAULT_EXEC_APPROVAL_DECISIONS;
}

export function approvalTitle(active: ExecApprovalRequest): string {
  return active.kind !== "exec"
    ? (active.pluginTitle ?? t("execApproval.pluginApprovalNeeded"))
    : t("execApproval.execApprovalNeeded");
}

function SidebarApprovalRowContent(props: SidebarApprovalRowProps) {
  const approval = createMemo(() => props.approval);
  const nowMs = useApprovalClock();
  const expired = createMemo(() => approval().expiresAtMs <= nowMs());
  const command = createMemo(() => compactApprovalCommand(approval().request.command));
  const sessionTitle = createMemo(() => {
    const sessionKey = approval().request.sessionKey?.trim();
    return (
      props.sessionTitle ??
      (sessionKey ? resolveSessionDisplayName(sessionKey) : approvalTitle(approval()))
    );
  });
  const expiryUrgent = createMemo(() => expired() || approval().expiresAtMs - nowMs() < 2 * 60_000);
  const expiryLabel = createMemo(() => approvalRemainingLabel(approval().expiresAtMs, nowMs()));
  const reviewOnlyMessage = createMemo(() => t("execApproval.reviewOnly"));
  const grantError = createMemo(() => !props.canGrant && props.error === reviewOnlyMessage());
  return (
    <article
      class="sidebar-approval-row sidebar-issues-panel__details--warning"
      data-attention-kind="pendingApproval"
      data-approval-id={approval().id}
    >
      <span class="sidebar-issues-panel__icon sidebar-approval-row__icon" aria-hidden="true">
        <Icon name="shieldQuestion" />
      </span>
      <div class="sidebar-approval-row__content">
        <div class="sidebar-approval-row__header" data-issue-row-focus tabindex="-1">
          <span class="sidebar-issues-panel__entity" title={sessionTitle()}>
            {sessionTitle()}
          </span>
          <openclaw-approval-countdown
            class={[
              "sidebar-approval-row__timer",
              { "sidebar-approval-row__timer--urgent": expiryUrgent() },
            ]}
            role="timer"
            aria-label={expiryLabel()}
            title={expiryLabel()}
            prop:expiresAtMs={approval().expiresAtMs}
            prop:compact={true}
          />
        </div>
        <div class="sidebar-approval-row__command mono" title={approval().request.command}>
          <span aria-hidden="true">$ </span>
          {command()}
        </div>
        <Show when={approval().request.scope}>
          {(scope) => <div class="exec-approval-scope">{summarizeApprovalScopeLabel(scope())}</div>}
        </Show>
        <div
          class="sidebar-approval-row__actions"
          role="group"
          aria-label={t("approvalPage.actionsLabel")}
        >
          <For each={resolveApprovalDecisions(approval())}>
            {(decision) => {
              const label = createMemo(() => approvalDecisionLabel(decision, approval()));
              return (
                <button
                  type="button"
                  class={[
                    "btn btn--xs sidebar-approval-row__action",
                    `sidebar-approval-row__action--${decision}`,
                    { "btn--ghost": decision === "deny" },
                  ]}
                  aria-label={t("execApproval.decisionRequest", {
                    decision: label(),
                    command: command(),
                  })}
                  disabled={props.busy || !props.canGrant || expired()}
                  onClick={(event: Event) => props.onDecision(event, approval().id, decision)}
                >
                  {label()}
                </button>
              );
            }}
          </For>
          {props.openSessionHref && props.onOpenSession ? (
            <a
              class="sidebar-approval-row__open-session"
              href={props.openSessionHref}
              aria-label={t("sessionsView.openSession")}
              title={t("sessionsView.openSession")}
              onClick={props.onOpenSession}
            >
              <Icon name="arrowUpRight" />
            </a>
          ) : undefined}
        </div>
        {!props.canGrant ? (
          <div class="sidebar-approval-row__message" role={grantError() ? "alert" : "note"}>
            {reviewOnlyMessage()}
          </div>
        ) : undefined}
        {props.error && !grantError() ? (
          <div
            class="sidebar-approval-row__message sidebar-approval-row__message--error"
            role="alert"
          >
            {props.error}
          </div>
        ) : undefined}
      </div>
    </article>
  );
}

function ExecApprovalCardContent(props: ExecApprovalCardProps) {
  const active = createMemo(() => props.approval);
  const decisions = createMemo(() => resolveApprovalDecisions(active()));
  const reviewOnlyMessage = createMemo(() => t("execApproval.reviewOnly"));
  const grantError = createMemo(() => !props.canGrant && props.error === reviewOnlyMessage());
  const rawSeverity = createMemo(() => active().pluginSeverity?.trim().toLowerCase());
  const severity = createMemo(() =>
    active().kind === "exec" || rawSeverity() === "warning" || rawSeverity() === "warn"
      ? "warning"
      : rawSeverity() === "danger" || rawSeverity() === "critical" || rawSeverity() === "error"
        ? "danger"
        : "info",
  );
  const pluginId = createMemo(() =>
    active().kind === "plugin" ? active().pluginId?.trim() : null,
  );
  const agentId = createMemo(() =>
    props.variant === "modal" ? active().request.agentId?.trim() : null,
  );
  return (
    <>
      {" "}
      <div
        class={[
          "exec-approval-card",
          `exec-approval-card--${props.variant}`,
          `exec-approval-card--severity-${severity()}`,
        ]}
        data-approval-id={active().id}
      >
        <div class="exec-approval-header">
          <div>
            <div class="exec-approval-title">{approvalTitle(active())}</div>
            {pluginId() || agentId() ? (
              <div class="exec-approval-chips">
                {renderChip("plugin", pluginId())} {renderChip("agent", agentId())}
              </div>
            ) : undefined}
            <openclaw-approval-countdown
              class="exec-approval-sub exec-approval-countdown"
              role="timer"
              prop:expiresAtMs={active().expiresAtMs}
            />
          </div>
          {(props.queueCount ?? 0) > 1 ? (
            <div class="exec-approval-queue">
              {t("execApproval.pending", { count: String(props.queueCount) })}
            </div>
          ) : undefined}
        </div>
        <Show when={props.variant === "inline" && active().sourceSessionKey}>
          {(sessionKey) => (
            <div class="exec-approval-warning" role="note">
              {t("execApproval.requestedBySession", {
                session: resolveSessionDisplayName(sessionKey(), props.sourceSession),
              })}
            </div>
          )}
        </Show>
        {active().kind === "exec"
          ? renderExecBody(active().request, props.variant)
          : renderPluginBody(active(), props.variant)}
        {active().kind === "exec" && !decisions().includes("allow-always") ? (
          <div class="exec-approval-warning">{t("execApproval.allowAlwaysUnavailable")}</div>
        ) : undefined}
        {!props.canGrant ? (
          <div
            class={grantError() ? "exec-approval-error" : "exec-approval-warning"}
            role={grantError() ? "alert" : "note"}
          >
            {reviewOnlyMessage()}
          </div>
        ) : undefined}
        {props.error && !grantError() ? (
          <div class="exec-approval-error" role="alert">
            {props.error}
          </div>
        ) : undefined}
        <div class="exec-approval-actions">
          <For each={decisions()}>
            {(decision) => {
              const label = createMemo(() => approvalDecisionLabel(decision, active()));
              return (
                <button
                  class={decisionClass(decision)}
                  type="button"
                  aria-label={label()}
                  disabled={props.busy || !props.canGrant}
                  title={
                    props.variant === "modal" && props.canGrant
                      ? `${label()} (${decisionShortcut(decision)})`
                      : label()
                  }
                  onClick={() => void props.onDecision(active().id, decision)}
                >
                  <span>{label()}</span>
                </button>
              );
            }}
          </For>
        </div>
      </div>
    </>
  );
}

export const ExecApprovalCard = defineSolidBridge<{ props?: ExecApprovalCardProps }>(
  "openclaw-exec-approval-card",
  (props, host) => {
    host.style.display = "contents";
    return <>{props.props && <ExecApprovalCardContent {...props.props} />}</>;
  },
  { properties: { props: { default: undefined, attribute: false } } },
);
export const SidebarApprovalRow = defineSolidBridge<{ props?: SidebarApprovalRowProps }>(
  "openclaw-sidebar-approval-row",
  (props, host) => {
    host.style.display = "contents";
    return <>{props.props && <SidebarApprovalRowContent {...props.props} />}</>;
  },
  { properties: { props: { default: undefined, attribute: false } } },
);
