import { css } from "lit";

export const filePreviewModalStyles = css`
  :host {
    display: contents;
  }

  .modal {
    width: 100%;
    height: min(780px, 86vh);
    background: var(--bg);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-lg);
    box-shadow: 0 24px 80px rgba(0, 0, 0, 0.6);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .head {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 16px 20px;
    border-bottom: 1px solid var(--border);
    background: var(--bg);
  }

  .search-icon {
    color: var(--muted);
    font-size: 18px;
  }

  .search {
    flex: 1;
    min-width: 0;
    background: transparent;
    border: none;
    outline: none;
    color: var(--text-strong);
    font: inherit;
    font-size: 18px;
    font-weight: 400;
    padding: 4px 0;
  }

  .search:focus,
  .search:focus-visible {
    outline: none;
    border: none;
    box-shadow: none;
  }

  .search::placeholder {
    color: var(--muted);
  }

  .state {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    color: var(--muted);
    padding: 5px 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg-elevated);
  }

  .body {
    flex: 1;
    display: grid;
    grid-template-columns: 360px 1fr;
    min-height: 0;
  }

  .list {
    border-right: 1px solid var(--border);
    padding: 14px 10px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .list-section {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--muted);
    padding: 4px 12px 8px;
  }

  .item {
    display: grid;
    grid-template-columns: 16px 1fr auto;
    gap: 12px;
    align-items: center;
    padding: 12px 14px;
    border-radius: var(--radius-md);
    border: none;
    background: transparent;
    color: var(--text);
    font: inherit;
    outline: none;
    text-align: left;
  }

  .item:focus-visible {
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 55%, transparent);
  }

  .item:hover {
    background: var(--bg-elevated);
  }

  .item.is-active {
    background: var(--accent-subtle);
  }

  .item.is-active .item-name {
    color: var(--text-strong);
  }

  .item-icon {
    width: 16px;
    height: 16px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--muted);
    opacity: 0.85;
  }

  .item.is-active .item-icon {
    color: var(--accent);
    opacity: 1;
  }

  .item-icon svg,
  .chat-copy-btn svg {
    width: 16px;
    height: 16px;
    stroke: currentColor;
    fill: none;
    stroke-width: 1.5px;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .item-name {
    font-family: var(--mono);
    font-size: 14px;
    color: var(--text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .item-meta {
    color: var(--muted);
    font-size: 12px;
  }

  .empty-list {
    color: var(--muted);
    font-size: 13px;
    padding: 12px;
  }

  .detail {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
  }

  .detail.empty {
    align-items: center;
    justify-content: center;
    text-align: center;
    padding: 24px;
  }

  .detail-head {
    padding: 20px 24px 14px;
    border-bottom: 1px solid var(--border);
  }

  .detail-title-row {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-bottom: 10px;
  }

  .title {
    flex: 1;
    min-width: 0;
    margin: 0;
    font-family: var(--mono);
    font-size: 22px;
    color: var(--text-strong);
    font-weight: 700;
    letter-spacing: -0.01em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .chat-copy-btn {
    width: 32px;
    height: 32px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: 0 0 auto;
    padding: 0;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg-elevated);
    color: var(--muted);
  }

  .chat-copy-btn:hover {
    border-color: var(--border-strong);
    color: var(--text-strong);
  }

  .chat-copy-btn:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  .chat-copy-btn__icon {
    display: inline-flex;
    width: 16px;
    height: 16px;
    position: relative;
  }

  .chat-copy-btn__icon-copy,
  .chat-copy-btn__icon-check {
    position: absolute;
    inset: 0;
    transition: opacity 150ms ease;
  }

  .chat-copy-btn__icon-check,
  .chat-copy-btn[data-copy-state="copied"] .chat-copy-btn__icon-copy {
    opacity: 0;
  }

  .chat-copy-btn[data-copy-state="copied"] .chat-copy-btn__icon-check {
    opacity: 1;
  }

  .chat-copy-btn[data-copy-state="copying"] {
    opacity: 0;
    pointer-events: none;
  }

  .chat-copy-btn[data-copy-state="error"] {
    border-color: var(--danger-subtle);
    background: var(--danger-subtle);
    color: var(--danger);
  }

  .chat-copy-btn[data-copy-state="copied"] {
    border-color: var(--ok-subtle);
    background: var(--ok-subtle);
    color: var(--ok);
  }

  .chips {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }

  .chip {
    display: inline-flex;
    align-items: center;
    padding: 3px 10px;
    border-radius: 999px;
    font-size: 11.5px;
    background: var(--bg-elevated);
    border: 1px solid var(--border);
    color: var(--muted);
  }

  .chip.accent {
    background: var(--accent-subtle);
    border-color: color-mix(in srgb, var(--accent) 30%, transparent);
    color: var(--accent);
  }

  .chip.ok {
    background: color-mix(in srgb, var(--ok) 12%, transparent);
    border-color: color-mix(in srgb, var(--ok) 30%, transparent);
    color: var(--ok);
  }

  .detail-body {
    flex: 1;
    overflow-x: auto;
    overflow-y: auto;
    padding: 20px 24px 24px;
  }

  .code-content {
    min-width: 0;
  }

  .full-content-hint {
    color: var(--muted);
    font-size: 12px;
    margin: 0 0 10px;
  }

  .code-full {
    margin: 0;
    font-family: var(--mono);
    font-size: 13px;
    line-height: 1.7;
    color: var(--text);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .code-chunk {
    margin: 0;
    min-width: 0;
    font-family: var(--mono);
    font-size: 13px;
    line-height: 1.7;
    color: var(--text);
    white-space: pre-wrap;
    word-break: break-word;
    content-visibility: auto;
    contain-intrinsic-block-size: auto 1414px;
  }

  /* Large code files use a fixed-height line window.  The scroll container
       still owns the full height through spacers, so switching files can
       reset one real scroll position instead of leaving a stale virtual slice. */
  .code-vscroll {
    min-width: max-content;
    font-family: var(--mono);
    font-size: 13px;
    line-height: 22px;
    color: var(--text);
  }

  .code-line {
    white-space: pre;
    min-height: 22px;
    line-height: 22px;
  }

  .code-spacer {
    height: 0;
    pointer-events: none;
  }

  .foot {
    display: flex;
    align-items: center;
    gap: 18px;
    padding: 12px 20px;
    border-top: 1px solid var(--border);
    background: var(--bg);
    font-size: 12px;
    color: var(--muted);
  }

  .foot-group {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }

  .kbd {
    font-family: var(--mono);
    font-size: 10.5px;
    padding: 2px 6px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--bg-elevated);
    color: var(--text);
  }

  .spacer {
    flex: 1;
  }

  .button {
    height: 36px;
    padding: 0 14px;
    border-radius: var(--radius-md);
    border: 1px solid var(--border);
    background: var(--bg-elevated);
    color: var(--text);
    font-weight: 600;
  }

  .button:hover {
    border-color: var(--border-strong);
    color: var(--text-strong);
  }

  .empty-title {
    font-size: 16px;
    font-weight: 600;
    color: var(--text-strong);
    margin: 0 0 8px;
  }

  .empty-subtitle {
    margin: 0;
    font-size: 13px;
    color: var(--muted);
    max-width: 380px;
  }

  @media (max-width: 640px) {
    .head {
      padding: 12px;
    }

    .body {
      grid-template-columns: minmax(0, 1fr);
      grid-template-rows: minmax(0, min(180px, 30dvh)) minmax(0, 1fr);
    }

    .list {
      min-width: 0;
      border-right: 0;
      border-bottom: 1px solid var(--border);
      padding: 10px 8px;
    }

    .item {
      min-width: 0;
    }

    .foot {
      gap: 8px;
      padding: 10px 12px;
    }
  }
`;
