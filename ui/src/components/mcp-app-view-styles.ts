import { css } from "lit";

export const mcpAppBannerStyles = css`
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px;
  background: var(--bg-accent);
  color: var(--text);
  font-size: 13px;
`;

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
  :host([fill-container]) {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }
  :host([fill-container]) .mount,
  :host([display-mode="fullscreen"]) .mount {
    flex: 1;
    min-height: 0;
  }
  iframe {
    display: block;
    width: 100%;
    border: 0;
    background: var(--board-surface, transparent);
  }
  :host([display-mode="fullscreen"]) {
    display: flex;
    flex-direction: column;
    height: 100dvh;
    position: fixed;
    inset: 0;
    z-index: 1000;
    background: var(--bg);
    padding-top: 40px;
    margin: 0;
    border: 0;
    box-sizing: border-box;
  }
  .exit-fullscreen {
    position: absolute;
    top: 4px;
    right: 8px;
  }
  .inactive {
    ${mcpAppBannerStyles}
    justify-content: space-between;
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
