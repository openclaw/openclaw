import { html, nothing } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import type { NodePermissionRequest } from "../../../../../packages/gateway-protocol/src/node-permissions.js";
import type { GatewaySessionRow } from "../../../api/types.ts";
import { toolIcons } from "../../../components/icons-tools.ts";
import { icons } from "../../../components/icons.ts";
import { toSanitizedMarkdownHtml } from "../../../components/markdown.ts";
import { t } from "../../../i18n/index.ts";
import type { ChatItem } from "../../../lib/chat/chat-types.ts";
import { formatSessionArchiveReason } from "../../../lib/sessions/session-archive-reason.ts";
import { detectTextDirection } from "../../../lib/text-direction.ts";
import "./chat-skill-learned-notice.tsx";
import "./chat-permission-card.tsx";
import "./chat-run-failure-notice.tsx";
import type { ChatThreadProps } from "./chat-thread-interactions.ts";

export function renderChatPermissionCard(
  request: NodePermissionRequest,
  onRetry?: (message: string) => void,
) {
  // Some transcript leaves mount independent Solid roots. The bridge recovers the app's DOM context.
  return html`<openclaw-chat-permission-card
    .request=${request}
    .onRetry=${onRetry}
  ></openclaw-chat-permission-card>`;
}

export function buildChatArchiveNotice(activeSession: GatewaySessionRow | null | undefined) {
  const archiveActor = activeSession?.archivedBy;
  const archiveLabel = archiveActor?.id
    ? t("sessionsView.archivedBy", { name: archiveActor.label ?? archiveActor.id })
    : activeSession?.archiveReason
      ? formatSessionArchiveReason(activeSession.archiveReason)
      : undefined;
  return activeSession?.archived && activeSession.archivedAt !== undefined && archiveLabel
    ? ({
        kind: "notice",
        key: `archive:${activeSession.sessionId ?? activeSession.key}:${activeSession.archivedAt}`,
        label: archiveLabel,
        text: "",
        timestamp: activeSession.archivedAt,
      } satisfies Extract<ChatItem, { kind: "notice" }>)
    : undefined;
}

function renderSystemLine(params: {
  icon?: keyof typeof toolIcons;
  label: string;
  metric?: string;
  compaction?: "active" | "complete";
}) {
  return html`
    <div
      class="chat-divider__rule"
      role=${params.compaction ? "status" : "separator"}
      aria-live=${params.compaction ? "polite" : nothing}
      aria-label=${params.metric ? `${params.label}, ${params.metric}` : params.label}
    >
      <span class="chat-divider__line"></span>
      <span class="chat-divider__label">
        ${
          params.compaction
            ? html`<span class="chat-compaction__glyph" aria-hidden="true">
                <span class="chat-compaction__line"></span>
                <span class="chat-compaction__line"></span>
                <span class="chat-compaction__line"></span>
                <span class="chat-compaction__line"></span>
                <span class="chat-compaction__line"></span>
                ${icons.check}
              </span>`
            : params.icon
              ? html`<span class="chat-divider__icon" aria-hidden="true"
                  >${toolIcons[params.icon]}</span
                >`
              : nothing
        }
        <span class="chat-divider__title">${params.label}</span>
        ${
          params.metric
            ? html`
                <span class="chat-divider__separator" aria-hidden="true">·</span>
                <span class="chat-divider__metric">${params.metric}</span>
              `
            : nothing
        }
      </span>
      <span class="chat-divider__line"></span>
    </div>
  `;
}

export function renderChatDivider(item: Extract<ChatItem, { kind: "divider" }>) {
  return html`
    <div
      class="chat-divider ${
        item.compaction ? `chat-compaction chat-compaction--${item.compaction}` : ""
      }"
      data-chat-row-key=${item.key}
      data-ts=${String(item.timestamp)}
    >
      ${renderSystemLine(item)}
      ${
        item.description
          ? html`
              <div class="chat-divider__details">
                <span class="chat-divider__description">${item.description}</span>
              </div>
            `
          : nothing
      }
    </div>
  `;
}

export function renderChatNotice(
  item: Extract<ChatItem, { kind: "notice" }>,
  onPermissionRetry?: (message: string) => void,
  recovery?: Pick<
    ChatThreadProps,
    "failureActionsRunId" | "runActive" | "runWorking" | "onRetryRun" | "onChangeFailureModel"
  >,
) {
  if (item.runError) {
    const runId = item.runError.runId;
    const canRecover =
      recovery &&
      runId === recovery.failureActionsRunId &&
      !recovery.runActive &&
      !recovery.runWorking;
    const failureActions = canRecover
      ? {
          onRetry: recovery.onRetryRun ? () => recovery.onRetryRun?.(runId) : undefined,
          onChangeModel: recovery.onChangeFailureModel
            ? () => recovery.onChangeFailureModel?.(runId)
            : undefined,
        }
      : undefined;
    return html`<div
      data-chat-row-key=${item.key}
      data-ts=${String(item.timestamp)}
      data-run-failure=${item.runError.runId}
    >
      <openclaw-chat-run-failure-notice
        .summary=${item.runError.summary}
        .onRetry=${failureActions?.onRetry}
        .onChangeModel=${failureActions?.onChangeModel}
      ></openclaw-chat-run-failure-notice>
    </div>`;
  }
  if (item.permissionMissing) {
    return html`<div data-chat-row-key=${item.key} data-ts=${String(item.timestamp)}>
      ${renderChatPermissionCard(item.permissionMissing, onPermissionRetry)}
    </div>`;
  }
  if (item.skillChanges) {
    return html`
      <div data-chat-row-key=${item.key} data-ts=${String(item.timestamp)}>
        <openclaw-chat-skill-learned-notice
          .notice=${item.skillChanges}
        ></openclaw-chat-skill-learned-notice>
      </div>
    `;
  }
  const body = item.text
    ? html`
        <div class="chat-text chat-notice__body" dir=${detectTextDirection(item.text)}>
          ${unsafeHTML(toSanitizedMarkdownHtml(item.text, { codeBlockChrome: "none" }))}
        </div>
      `
    : nothing;
  return html`
    <div
      class="chat-notice ${item.tone === "danger" ? "chat-notice--danger callout danger" : ""}"
      data-chat-row-key=${item.key}
      data-ts=${String(item.timestamp)}
      role=${item.tone === "danger" ? "alert" : nothing}
    >
      ${item.label ? renderSystemLine({ icon: item.icon, label: item.label }) : nothing}
      ${
        item.collapsedBody && item.text
          ? html`
              <details class="chat-notice__collapse">
                <summary class="chat-notice__toggle">${t("chat.systemNotice.showContent")}</summary>
                ${body}
              </details>
            `
          : body
      }
    </div>
  `;
}
