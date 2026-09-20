import { css } from "lit";

export const linkReaderPanelStyles = css`
  .bp--right {
    top: var(--shell-topbar-height, 0);
    right: calc(
      var(--oc-terminal-reserve-right, 0px) + var(--oc-browser-reserve-right, 0px) +
        var(--oc-desktop-reserve-right, 0px)
    );
    bottom: calc(
      var(--oc-terminal-reserve-bottom, 0px) + var(--oc-browser-reserve-bottom, 0px) +
        var(--oc-desktop-reserve-bottom, 0px)
    );
    max-width: 100vw;
  }
  .bp-header {
    flex: none;
  }
  .bp--embedded {
    position: relative;
    inset: auto;
    width: 100%;
    height: 100%;
    min-width: 0;
    min-height: 0;
    flex: 1;
  }
  .bp-actions {
    padding-left: 0;
  }
  .bp-icon {
    cursor: default;
    flex: none;
    text-decoration: none;
  }
  .bp-icon svg {
    width: 15px;
    height: 15px;
  }
  .bp-icon:disabled,
  .lr-retry:disabled {
    opacity: 0.4;
    cursor: default;
  }
  :is(button, a, summary, pre):focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .lr-tab-header .tabstrip {
    flex: 1;
  }
  .tabstrip-tab__label {
    max-width: 150px;
  }
  .lr-toolbar {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 5px 8px;
    border-bottom: 1px solid var(--border);
  }
  .lr-url {
    flex: 1;
    min-width: 0;
    height: 30px;
    box-sizing: border-box;
    border: 1px solid transparent;
    border-radius: 14px;
    padding: 3px 10px;
    color: var(--text);
    background: color-mix(in srgb, var(--text) 8%, transparent);
    font: inherit;
    font-size: 12px;
  }
  .lr-url:focus {
    border-color: var(--accent);
    outline: none;
  }
  .lr-external {
    display: inline-flex;
    flex: none;
    align-items: center;
    gap: 5px;
    padding: 4px;
    color: var(--text);
    font-size: 12px;
    text-decoration: none;
    white-space: nowrap;
  }
  .lr-external:hover {
    text-decoration: underline;
  }
  .lr-external svg {
    width: 15px;
    height: 15px;
  }
  .lr-panels {
    display: flex;
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }
  .lr-content[hidden] {
    display: none;
  }
  .lr-content {
    flex: 1;
    min-height: 0;
    overflow: auto;
    padding: 20px;
    font-size: 13px;
    line-height: 1.6;
    overflow-wrap: anywhere;
  }
  .lr-content:focus {
    outline: none;
  }
  h1 {
    margin: 8px 0 12px;
    font-size: 21px;
    line-height: 1.3;
    font-weight: 650;
  }
  h2 {
    margin: 20px 0 10px;
    font-size: 14px;
  }
  a {
    color: var(--accent);
  }
  .lr-meta {
    color: var(--muted);
    font-size: 12px;
  }
  .lr-item-meta {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
  }
  .lr-state {
    padding: 2px 9px;
    border-radius: 12px;
    background: color-mix(in srgb, currentColor 12%, transparent);
    font-weight: 600;
  }
  .lr-state--positive {
    color: var(--ok);
  }
  .lr-state--accent {
    color: var(--pr-merged);
  }
  .lr-state--negative {
    color: var(--danger);
  }
  .lr-state--attention {
    color: var(--warn);
  }
  .lr-description {
    margin-top: 20px;
  }
  .lr-note {
    padding: 9px 12px;
    border-left: 2px solid var(--warn);
    background: color-mix(in srgb, var(--warn) 8%, transparent);
    font-size: 12px;
  }
  .lr-comment {
    border-top: 1px solid var(--border);
    padding: 14px 0;
  }
  .lr-comment header {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .lr-comment strong {
    color: var(--text);
  }
  .lr-file {
    border: 1px solid var(--border);
    border-radius: 6px;
    margin-bottom: 8px;
    overflow: hidden;
  }
  .lr-file summary {
    cursor: default;
    padding: 8px 10px;
    background: color-mix(in srgb, var(--text) 4%, transparent);
  }
  .lr-filename {
    font-family: var(--mono);
    font-size: 12px;
  }
  .lr-stats {
    white-space: nowrap;
    margin-left: 10px;
    font-size: 11px;
  }
  .lr-add,
  .lr-item-meta [data-tone="positive"] {
    color: var(--ok);
  }
  .lr-delete,
  .lr-item-meta [data-tone="negative"] {
    color: var(--danger);
  }
  .lr-file > p {
    margin: 10px;
  }
  .lr-diff {
    margin: 0;
    overflow: auto;
    font-family: var(--mono);
    font-size: 11px;
    line-height: 1.7;
    tab-size: 2;
  }
  .lr-diff code {
    display: block;
    min-width: max-content;
  }
  .lr-diff-line {
    display: block;
    min-height: 1.7em;
    padding: 0 10px;
    white-space: pre;
  }
  .lr-diff-line--add {
    background: color-mix(in srgb, var(--ok) 14%, transparent);
  }
  .lr-diff-line--delete {
    background: color-mix(in srgb, var(--danger) 14%, transparent);
  }
  .lr-diff-line--hunk {
    color: var(--muted);
    background: color-mix(in srgb, var(--accent) 9%, transparent);
  }
  .lr-status {
    padding: 24px 0;
    color: var(--muted);
  }
  .lr-status h2 {
    color: var(--text);
  }
  .lr-status a {
    margin-left: 12px;
  }
  .lr-retry {
    font: inherit;
    color: var(--text);
    background: transparent;
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 4px 12px;
    cursor: default;
  }
  .lr-markdown :first-child {
    margin-top: 10px;
  }
  .lr-markdown p {
    margin: 10px 0;
  }
  .lr-markdown pre {
    white-space: pre;
    overflow: auto;
    padding: 10px;
    border-radius: 6px;
    background: color-mix(in srgb, var(--text) 5%, transparent);
  }
  .lr-markdown code {
    font-family: var(--mono);
    font-size: 0.9em;
  }
  .lr-markdown :not(pre) > code {
    padding: 2px 4px;
    border-radius: 3px;
    background: color-mix(in srgb, var(--text) 7%, transparent);
  }
  .lr-markdown blockquote {
    margin: 10px 0;
    padding-left: 12px;
    border-left: 3px solid var(--border);
    color: var(--muted);
  }
  .lr-markdown table {
    display: block;
    overflow: auto;
    border-collapse: collapse;
  }
  .lr-markdown :is(td, th) {
    border: 1px solid var(--border);
    padding: 5px 9px;
  }
  .lr-markdown img {
    max-width: 100%;
  }
  .lr-markdown .markdown-link-github__icon {
    display: inline-block;
    width: 12px;
    height: 12px;
  }
  .lr-markdown .markdown-code-block__lang {
    color: var(--muted);
    font-size: 11px;
  }
  @media (max-width: 768px) {
    .bp--right {
      inset: 0;
      width: 100% !important;
      max-width: none;
      border: 0;
    }
    .bp-resizer {
      display: none;
    }
    .bp-header {
      min-height: 44px;
      padding: env(safe-area-inset-top, 0px) 6px 0;
    }
    .bp-icon {
      width: 34px;
      height: 34px;
    }
    .lr-toolbar {
      flex-wrap: wrap;
    }
    .lr-url {
      order: -1;
      flex-basis: 100%;
      font-size: 16px;
      height: 36px;
    }
    .lr-external {
      margin-left: auto;
    }
    .lr-content {
      padding: 16px 16px calc(16px + env(safe-area-inset-bottom, 0px));
    }
  }
`;
