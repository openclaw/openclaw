import { css } from "lit";

export const linkReaderContentStyles = css`
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
  .lr-comment {
    scroll-margin-top: 12px;
  }
`;
