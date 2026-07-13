// Pending custom-widget approvals only. The source is derived from the trusted
// workspace registry; decisions reuse the existing operator-only approval RPC.

import { html, nothing, type TemplateResult } from "lit";
import { t } from "../../../i18n/index.ts";
import { workspaceAgentProvenance } from "../types.ts";
import type { WorkspaceDocument, WorkspaceWidget } from "../types.ts";
import {
  toFiniteNumber,
  widgetProps,
  type ApprovalDecision,
  type ApprovalsWidgetSource,
  type BuiltinWidgetContext,
  type PendingApprovalItem,
} from "./types.ts";

const DEFAULT_LIMIT = 8;

export type ApprovalsModel = { items: PendingApprovalItem[]; total: number };

export function toWidgetApprovalDecision(decision: ApprovalDecision): "approved" | "rejected" {
  return decision === "approve" ? "approved" : "rejected";
}

export function buildWidgetApprovalsSource(
  workspace: WorkspaceDocument,
  resolve: (name: string, decision: "approved" | "rejected") => void,
): ApprovalsWidgetSource {
  const pending = Object.entries(workspace.widgetsRegistry)
    .filter(([, entry]) => entry.status === "pending")
    .map(([name, entry]) => ({
      id: name,
      kind: "widget" as const,
      title: name,
      requestedBy: workspaceAgentProvenance(entry.createdBy),
    }));
  return {
    pending,
    onDecide: (item, decision) => resolve(item.id, toWidgetApprovalDecision(decision)),
  };
}

export function mapApprovals(
  widget: WorkspaceWidget,
  source: ApprovalsWidgetSource | undefined,
): ApprovalsModel {
  const pending = source?.pending.filter((item) => item.id) ?? [];
  const limitProp = toFiniteNumber(widgetProps(widget).limit);
  const limit = limitProp && limitProp > 0 ? Math.trunc(limitProp) : DEFAULT_LIMIT;
  return { items: pending.slice(0, limit), total: pending.length };
}

export function renderApprovals(
  widget: WorkspaceWidget,
  _value: unknown,
  ctx: BuiltinWidgetContext,
): TemplateResult {
  const source = ctx.approvals;
  const model = mapApprovals(widget, source);
  if (model.items.length === 0) {
    return html`<div class="workspace-widget__placeholder">
      ${t("workspaces.widget.approvals.empty")}
    </div>`;
  }
  return html`
    <ul class="workspace-list workspace-approvals" data-test-id="workspace-approvals">
      ${model.items.map(
        (item) => html`
          <li class="workspace-list__row">
            <span class="workspace-badge workspace-badge--muted"
              >${t("workspaces.widget.approvals.kind.widget")}</span
            >
            <span class="workspace-list__label">${item.title}</span>
            ${item.requestedBy
              ? html`<span class="workspace-list__meta"
                  >${t("workspaces.widget.approvals.requestedBy", {
                    agent: item.requestedBy,
                  })}</span
                >`
              : nothing}
            <span class="workspace-approvals__actions">
              <button
                class="btn btn--small btn--primary"
                type="button"
                @click=${() => source?.onDecide(item, "approve")}
              >
                ${t("workspaces.widget.approvals.approve")}
              </button>
              <button
                class="btn btn--small"
                type="button"
                @click=${() => source?.onDecide(item, "reject")}
              >
                ${t("workspaces.widget.approvals.reject")}
              </button>
            </span>
          </li>
        `,
      )}
    </ul>
  `;
}
