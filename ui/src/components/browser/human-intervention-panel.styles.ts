import { css } from "lit";

export const humanInterventionStyles = css`
  :host {
    display: block;
    min-height: 100dvh;
    color: var(--text);
    background: var(--bg);
  }

  * {
    box-sizing: border-box;
  }

  .page {
    width: min(100%, 920px);
    min-height: 100dvh;
    margin: 0 auto;
    padding: max(20px, var(--safe-area-top, 0px)) max(16px, var(--safe-area-right, 0px))
      max(24px, var(--safe-area-bottom, 0px)) max(16px, var(--safe-area-left, 0px));
    display: grid;
    align-content: start;
    gap: 16px;
  }

  header {
    display: grid;
    gap: 6px;
  }
  h1 {
    margin: 0;
    font-size: clamp(22px, 5vw, 32px);
    line-height: 1.15;
  }
  .host {
    font:
      600 14px/1.4 ui-monospace,
      SFMono-Regular,
      Menlo,
      monospace;
    color: var(--muted);
  }
  .reason,
  .status,
  .error {
    margin: 0;
    line-height: 1.45;
  }
  .status {
    color: var(--muted);
  }
  .error {
    color: var(--danger);
  }

  .viewer {
    overflow: auto;
    overscroll-behavior: contain;
    border: 1px solid var(--border);
    border-radius: 14px;
    background: var(--bg-accent);
    min-height: min(62dvh, 620px);
    max-height: 68dvh;
    touch-action: pan-x pan-y;
  }

  .frame {
    display: block;
    width: calc(100% * var(--human-browser-zoom));
    height: auto;
    min-height: 240px;
    object-fit: contain;
    object-position: top left;
    user-select: none;
    -webkit-user-drag: none;
    touch-action: none;
  }

  .viewer-empty {
    min-height: min(62dvh, 620px);
    display: grid;
    place-items: center;
    padding: 24px;
    color: var(--text-strong);
    text-align: center;
  }

  .toolbar,
  .actions,
  .text-entry {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .toolbar {
    justify-content: flex-end;
  }
  .actions {
    padding-top: 4px;
  }
  .text-entry input {
    flex: 1 1 230px;
    min-width: 0;
  }

  button,
  input {
    min-height: 44px;
    border-radius: 10px;
    border: 1px solid var(--border);
    font: inherit;
  }
  button {
    padding: 0 14px;
    background: var(--bg-elevated);
    color: inherit;
    font-weight: 600;
  }
  button.primary {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--accent-foreground);
  }
  button.danger {
    color: var(--danger);
  }
  button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  input {
    padding: 0 12px;
    background: var(--bg-elevated);
    color: inherit;
  }

  @media (max-width: 640px) {
    .page {
      padding-inline: 12px;
      gap: 12px;
    }
    .viewer,
    .viewer-empty {
      min-height: 54dvh;
      max-height: 60dvh;
    }
    .actions button {
      flex: 1 1 auto;
    }
  }
`;
