import { LitElement, html, nothing, css } from "lit";
import { customElement, property } from "lit/decorators.js";
import type { ExecApprovalRequest } from "../controllers/exec-approval.ts";

/**
 * Card for a single exec approval request (ConsentGuard HITL).
 * Displays command, meta, and actions; dispatches "resolve" with { id, decision }.
 */
@customElement("consent-request-card")
export class ConsentRequestCard extends LitElement {
  @property({ type: Object }) request: ExecApprovalRequest | null = null;
  @property({ type: Boolean }) disabled = false;

  static styles = css`
    :host {
      display: block;
      border: 1px solid var(--border, #444);
      border-radius: 8px;
      background: var(--surface, #1a1a1a);
      overflow: hidden;
    }
    .card-header {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 12px;
      padding: 12px 14px;
      border-bottom: 1px solid var(--border, #333);
    }
    .card-title {
      font-weight: 600;
      font-size: 0.95rem;
    }
    .card-sub {
      font-size: 0.8rem;
      color: var(--muted, #888);
      margin-top: 2px;
    }
    .card-command {
      font-family: var(--font-mono, ui-monospace, monospace);
      font-size: 0.85rem;
      padding: 10px 14px;
      background: var(--code-bg, #0d0d0d);
      border-radius: 4px;
      margin: 12px 14px;
      word-break: break-all;
      white-space: pre-wrap;
    }
    .card-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 12px 20px;
      padding: 0 14px 12px;
      font-size: 0.8rem;
      color: var(--muted, #888);
    }
    .card-meta span strong {
      color: var(--text, #e0e0e0);
      font-weight: 500;
    }
    .card-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      padding: 12px 14px;
      border-top: 1px solid var(--border, #333);
    }
    .card-actions .btn {
      padding: 6px 12px;
      border-radius: 6px;
      border: 1px solid var(--border, #444);
      background: var(--surface, #1a1a1a);
      color: inherit;
      cursor: pointer;
      font-size: 0.85rem;
    }
    .card-actions .btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .card-actions .btn.primary {
      background: var(--accent, #0066cc);
      border-color: var(--accent, #0066cc);
      color: #fff;
    }
    .card-actions .btn.danger {
      background: var(--danger-bg, #4a1515);
      border-color: var(--danger, #c33);
      color: var(--danger, #e66);
    }
  `;

  private dispatchResolve(decision: "allow-once" | "allow-always" | "deny") {
    if (!this.request || this.disabled) return;
    this.dispatchEvent(
      new CustomEvent("resolve", {
        bubbles: true,
        composed: true,
        detail: { id: this.request.id, decision },
      }),
    );
  }

  render() {
    const req = this.request;
    if (!req) {
      return nothing;
    }
    const { request: payload } = req;
    const remainingMs = req.expiresAtMs - Date.now();
    const expired = remainingMs <= 0;
    const remaining = expired
      ? "Expired"
      : `Expires in ${Math.max(0, Math.ceil(remainingMs / 1000))}s`;

    return html`
      <div class="card-header">
        <div>
          <div class="card-title">Exec approval required</div>
          <div class="card-sub">${remaining} · Agent: ${payload.agentId ?? "—"}</div>
        </div>
      </div>
      <div class="card-command" role="textbox" aria-readonly="true">${payload.command}</div>
      <div class="card-meta">
        ${payload.cwd ? html`<span><strong>CWD</strong> ${payload.cwd}</span>` : nothing}
        ${payload.host ? html`<span><strong>Host</strong> ${payload.host}</span>` : nothing}
        ${
          payload.sessionKey
            ? html`<span><strong>Session</strong> ${payload.sessionKey}</span>`
            : nothing
        }
        ${
          payload.resolvedPath
            ? html`<span><strong>Resolved</strong> ${payload.resolvedPath}</span>`
            : nothing
        }
        ${
          payload.security
            ? html`<span><strong>Security</strong> ${payload.security}</span>`
            : nothing
        }
      </div>
      <div class="card-actions">
        <button
          class="btn primary"
          ?disabled=${this.disabled || expired}
          @click=${() => this.dispatchResolve("allow-once")}
        >
          Allow once
        </button>
        <button
          class="btn"
          ?disabled=${this.disabled || expired}
          @click=${() => this.dispatchResolve("allow-always")}
        >
          Always allow
        </button>
        <button
          class="btn danger"
          ?disabled=${this.disabled || expired}
          @click=${() => this.dispatchResolve("deny")}
        >
          Deny
        </button>
      </div>
    `;
  }
}
