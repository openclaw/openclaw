import { css } from "lit";

export const mcpAppViewStyles = css`
  :host {
    display: block;
    width: 100%;
  }
  .mount {
    width: 100%;
    min-height: 160px;
  }
  .mount:empty {
    min-height: 0;
  }
  :host([fill-container]),
  :host([fill-container]) .mount {
    height: 100%;
    min-height: 0;
  }
  iframe {
    display: block;
    width: 100%;
    border: 0;
    background: var(--board-surface, transparent);
  }
  :host([display-mode="fullscreen"]) {
    position: fixed;
    inset: 0;
    z-index: 1000;
    background: var(--bg);
    padding-top: 40px;
    margin: 0;
    border: 0;
    box-sizing: border-box;
  }
  :host([display-mode="fullscreen"]) .mount {
    height: calc(100dvh - 40px);
  }
  .exit-fullscreen {
    position: absolute;
    top: 4px;
    right: 8px;
  }
  .inactive {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 14px;
    background: var(--bg-accent);
    color: var(--text);
    font-size: 13px;
  }
  .inactive button {
    flex-shrink: 0;
  }
  .error {
    padding: 14px;
    color: var(--danger, #dc2626);
    font-size: 13px;
  }
`;
