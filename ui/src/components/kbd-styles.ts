import { css } from "lit";

// Cap-trim letters to align visible ink; the strut retains context line height
// while numeric picker ::before content remains its own sizing owner.
export const kbdStyles = css`
  .shortcut-kbd:where(:not([hidden])) {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    vertical-align: middle;
  }

  .shortcut-kbd > span + span {
    margin-inline-start: 0.15em;
  }
  .kbd__text {
    text-box: trim-both cap alphabetic;
  }
  .shortcut-kbd::before {
    content: "";
    height: 1lh;
  }
`;
