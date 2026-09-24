import { css } from "lit";

export const linkReaderContentStyles = css`
  .lr-document {
    max-width: 920px;
    margin-inline: auto;
    min-width: 0;
  }
  .lr-eyebrow {
    color: var(--muted);
    font-size: 12px;
    font-weight: 500;
  }
  .lr-metadata {
    display: flex;
    flex-wrap: wrap;
    gap: 14px 24px;
    margin: 16px 0 0;
    padding: 12px 0 16px;
    border-top: 1px solid var(--border);
  }
  .lr-metric {
    min-width: 0;
  }
  .lr-metric dt {
    color: var(--muted);
    font-size: 11px;
    margin-bottom: 2px;
  }
  .lr-metric dd {
    margin: 0;
    font-size: 13px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .lr-metric--positive dd {
    color: var(--ok);
  }
  .lr-metric--negative dd {
    color: var(--danger);
  }
  .lr-section-nav {
    position: sticky;
    /* Offset the reader padding so the bar sticks flush with its scrollport. */
    top: -24px;
    z-index: 1;
    display: flex;
    gap: 4px;
    overflow-x: auto;
    padding: 8px 0;
    margin-bottom: 16px;
    background: var(--bg);
    border-block: 1px solid var(--border);
  }
  .lr-section-nav button {
    display: inline-flex;
    flex: none;
    white-space: nowrap;
    align-items: center;
    gap: 6px;
    min-height: 32px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--muted);
    padding: 6px 9px;
    font: inherit;
    font-size: 12px;
    font-weight: 550;
    cursor: default;
  }
  .lr-section-nav button:hover {
    color: var(--text);
    background: color-mix(in srgb, var(--text) 6%, transparent);
  }
  .lr-count {
    display: inline-block;
    border-radius: 5px;
    padding: 0 5px;
    color: var(--muted);
    background: color-mix(in srgb, var(--text) 7%, transparent);
    font-size: 11px;
    font-weight: 500;
    font-variant-numeric: tabular-nums;
  }
  .lr-document section > h2 {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  [data-reader-section],
  .lr-comment {
    scroll-margin-top: 64px;
  }
  [data-reader-section]:focus {
    outline: none;
  }
  .lr-checks {
    --check-color: var(--muted);
    border: 1px solid var(--border);
    border-radius: 10px;
    overflow: hidden;
    margin: 20px 0 24px;
    background: color-mix(in srgb, var(--check-color) 3%, transparent);
  }
  .lr-checks--success,
  .lr-check--success {
    --check-color: var(--ok);
  }
  .lr-checks--failure,
  .lr-check--failure {
    --check-color: var(--danger);
  }
  .lr-checks--pending,
  .lr-check--pending {
    --check-color: var(--warn);
  }
  .lr-check--neutral {
    --check-color: var(--muted);
  }
  .lr-checks > summary {
    display: grid;
    grid-template-columns: 32px minmax(0, 1fr) 16px;
    align-items: center;
    column-gap: 12px;
    padding: 16px;
    list-style: none;
    cursor: default;
  }
  .lr-checks > summary::-webkit-details-marker {
    display: none;
  }
  .lr-checks-icon {
    display: grid;
    place-items: center;
    width: 32px;
    height: 32px;
    border-radius: 50%;
    color: var(--check-color);
    background: color-mix(in srgb, var(--check-color) 12%, transparent);
  }
  .lr-checks-icon svg {
    width: 17px;
    height: 17px;
  }
  .lr-checks-heading {
    display: grid;
    gap: 2px;
  }
  .lr-checks-heading strong {
    font-size: 13px;
    font-weight: 650;
  }
  .lr-checks-chevron {
    display: flex;
    color: var(--muted);
  }
  .lr-checks-chevron svg {
    width: 16px;
    height: 16px;
  }
  .lr-checks[open] .lr-checks-chevron {
    transform: rotate(180deg);
  }
  .lr-checks-meter {
    display: flex;
    gap: 3px;
    grid-column: 2;
    margin-top: 10px;
    height: 4px;
    overflow: hidden;
    border-radius: 2px;
  }
  .lr-check-segment {
    flex: 1;
    background: var(--muted);
  }
  .lr-check-segment--success {
    background: var(--ok);
  }
  .lr-check-segment--failure {
    background: var(--danger);
  }
  .lr-check-segment--pending {
    background: var(--warn);
  }
  .lr-check-list {
    max-height: 360px;
    overflow: auto;
    list-style: none;
    padding: 0;
    margin: 0;
  }
  .lr-check {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 16px;
    border-top: 1px solid var(--border);
  }
  .lr-check-symbol {
    display: flex;
    color: var(--check-color);
  }
  .lr-check-symbol svg {
    width: 16px;
    height: 16px;
  }
  .lr-check-copy {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    min-width: 0;
    flex: 1;
    gap: 4px 12px;
  }
  .lr-check-copy > a {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    color: var(--text);
    text-decoration: none;
  }
  .lr-check-copy > a:hover {
    text-decoration: underline;
  }
  .lr-check-copy > a svg {
    flex: none;
    width: 12px;
    height: 12px;
    color: var(--muted);
  }
  .lr-checks-footer {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    border-top: 1px solid var(--border);
    padding: 12px 16px;
    font-size: 11px;
    color: var(--muted);
  }
  .lr-checks-footer a {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    color: var(--muted);
  }
  .lr-checks-footer svg {
    width: 12px;
    height: 12px;
  }
  .lr-checks-footer code {
    font-family: var(--mono);
  }
  @media (max-width: 768px) {
    .lr-section-nav {
      top: -16px;
      gap: 0;
    }
    .lr-section-nav button {
      padding-inline: 7px;
    }
  }
  .lr-image {
    display: block;
    margin: 12px 0;
    max-width: 100%;
  }
  .lr-image img {
    display: block;
    max-width: 100%;
    max-height: 480px;
    height: auto;
    object-fit: contain;
    border-radius: 6px;
  }
  .lr-image img[hidden] {
    display: none;
  }
  .lr-image-caption {
    display: block;
    margin-top: 5px;
    color: var(--muted);
    font-size: 11px;
    overflow-wrap: anywhere;
  }
  .lr-image > a {
    display: inline-block;
    max-width: 100%;
  }
  .lr-comment-kind {
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 0 7px;
    font-size: 11px;
  }
  .lr-review-location {
    margin: 8px 0;
    color: var(--muted);
    font-size: 11px;
  }
  .lr-review-location a {
    font-family: var(--mono);
  }
  .lr-review-diff {
    margin-top: 8px;
  }
`;
