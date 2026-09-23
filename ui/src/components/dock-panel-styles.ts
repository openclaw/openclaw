import { css } from "lit";

export const dockPanelStyles = css`
  :host {
    position: fixed;
    z-index: 60;
    color: var(--text, #d7dae0);
    font-family: var(--font-body);
  }
  :host([embedded]) {
    position: static;
    z-index: auto;
    display: flex;
    width: 100%;
    min-width: 0;
    min-height: 0;
    flex: 1 1 0;
  }
  :is(.bp, .tp) {
    position: fixed;
    display: flex;
    flex-direction: column;
    background: var(--bg, #0e1015);
    overflow: hidden;
  }
  :is(.bp-resizer, .tp-resizer) {
    position: absolute;
    z-index: 2;
  }
  :is(.bp-resizer--bottom, .tp-resizer--bottom) {
    --resize-handle-line-block: 0;
    top: 0;
    left: 0;
    right: 0;
  }
  :is(.bp-resizer--right, .tp-resizer--right) {
    --resize-handle-line-inline: 0;
    top: 0;
    bottom: 0;
    left: 0;
  }
  .rail-header {
    box-sizing: border-box;
    display: flex;
    height: var(--rail-header-height, 48px);
    min-height: var(--rail-header-height, 48px);
    flex: 0 0 auto;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 0 var(--rail-header-padding-end, 8px) 0 var(--rail-header-padding-start, 12px);
    border-bottom: var(--rail-divider-size, 1px) solid
      var(--rail-divider-color, var(--border, #262b34));
    background: var(--rail-header-background, var(--bg, #0e1015));
  }
  .rail-header__actions {
    display: flex;
    flex: 0 0 auto;
    align-items: center;
    gap: var(--rail-header-action-gap, 2px);
  }
  .rail-header__copy {
    display: flex;
    min-width: 0;
    flex: 1 1 auto;
    flex-direction: column;
    justify-content: center;
    gap: var(--rail-header-copy-gap, 2px);
  }
  .rail-header__eyebrow {
    overflow: hidden;
    color: var(--muted, #8a919e);
    font-size: var(--rail-header-eyebrow-size, 10px);
    letter-spacing: var(--rail-header-eyebrow-letter-spacing, 0.04em);
    line-height: 1;
    text-overflow: ellipsis;
    text-transform: uppercase;
    white-space: nowrap;
  }
  .rail-header__title {
    overflow: hidden;
    color: var(--text, #d7dae0);
    font-size: var(--rail-header-title-size, 12px);
    font-weight: var(--rail-header-title-weight, 600);
    line-height: 1.2;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .rail-header__action {
    display: inline-flex;
    width: var(--rail-header-action-size, 28px);
    min-width: var(--rail-header-action-size, 28px);
    height: var(--rail-header-action-size, 28px);
    min-height: var(--rail-header-action-size, 28px);
    align-items: center;
    justify-content: center;
    padding: 0;
    border: 0;
    border-radius: 6px;
    background: transparent;
    box-shadow: none;
    color: var(--rail-header-action-color, var(--muted, #8a919e));
    font: inherit;
    opacity: 1;
  }
  .rail-header__action:hover,
  .rail-header__action:focus-visible {
    border: 0;
    background: transparent;
    box-shadow: none;
    color: var(--rail-header-action-hover-color, var(--text, #d7dae0));
  }
  .rail-header__action:focus-visible {
    outline: 2px solid var(--ring, var(--accent, #ff5c5c));
    outline-offset: -3px;
  }
  .rail-header__action.is-active,
  .rail-header__action[aria-pressed="true"] {
    background: transparent;
    color: var(--rail-header-action-active-color, var(--accent, #ff5c5c));
  }
  .rail-header__action:disabled,
  .rail-header__action[aria-disabled="true"] {
    opacity: var(--rail-header-action-disabled-opacity, 0.4);
  }
  [data-new-tab-action]:not(:disabled):not([disabled]):not([aria-disabled="true"]) {
    cursor: pointer;
  }
  .rail-header__action svg {
    width: var(--rail-header-action-glyph-size, 16px);
    height: var(--rail-header-action-glyph-size, 16px);
    fill: none;
    stroke: currentColor;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
`;
