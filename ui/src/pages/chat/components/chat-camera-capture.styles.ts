import { css } from "lit";

export const cameraCaptureStyles = css`
  :host {
    display: contents;
  }
  openclaw-modal-dialog {
    --openclaw-modal-width: 640px;
  }
  .camera {
    box-sizing: border-box;
    max-height: var(--openclaw-modal-height-limit);
    overflow: auto;
    border: 1px solid var(--border);
    border-radius: var(--radius-xl);
    background: var(--bg);
    color: var(--text);
    box-shadow: var(--shadow-xl);
  }
  header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    padding: 20px;
  }
  h2 {
    margin: 0;
    font-size: 18px;
    font-weight: 600;
  }
  p {
    margin: 6px 0 0;
    color: var(--muted);
    font-size: 13px;
    line-height: 1.5;
  }
  .preview {
    position: relative;
    display: grid;
    place-items: center;
    aspect-ratio: 4 / 3;
    max-height: 55dvh;
    margin: 0 20px;
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg-elevated);
  }
  video,
  img {
    display: block;
    width: 100%;
    height: 100%;
    min-height: 0;
    object-fit: contain;
  }
  .notice {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    gap: 12px;
    padding: 24px;
    text-align: center;
    background: var(--bg-elevated);
  }
  .notice svg {
    width: 32px;
    height: 32px;
    color: var(--muted);
  }
  .notice p {
    max-width: 38ch;
    margin: 0;
  }
  .notice strong {
    font-size: 15px;
    font-weight: 600;
  }
  .camera-selector {
    display: flex;
    align-items: center;
    gap: 12px;
    margin: 16px 20px 0;
    font-size: 13px;
    color: var(--muted);
  }
  select {
    min-width: 0;
    flex: 1;
    padding: 8px;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg);
    color: var(--text);
    font: inherit;
  }
  footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 12px;
    padding: 20px;
  }
  .actions {
    display: flex;
    gap: 8px;
    margin-inline-start: auto;
  }
  button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    min-height: 38px;
    padding: 8px 14px;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg);
    color: var(--text);
    font: inherit;
    font-size: 13px;
    font-weight: 500;
    cursor: default;
  }
  button:hover:not(:disabled) {
    background: var(--bg-elevated);
  }
  button:focus-visible,
  select:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 3px;
  }
  button:disabled {
    opacity: 0.45;
  }
  button svg {
    width: 16px;
    height: 16px;
  }
  .primary {
    background: var(--primary);
    color: var(--primary-foreground);
    border-color: var(--primary);
  }
  .primary:hover:not(:disabled) {
    background: var(--primary-hover);
  }
  .icon-button {
    width: 32px;
    min-height: 32px;
    padding: 6px;
    border-color: transparent;
  }
  .upload {
    border-color: transparent;
    color: var(--muted);
    padding-inline: 0;
  }
  @media (max-width: 560px) {
    header,
    footer {
      padding: 16px;
    }
    .preview {
      margin-inline: 16px;
    }
    .camera-selector {
      margin-inline: 16px;
    }
  }
`;
