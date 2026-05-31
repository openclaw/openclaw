import { isRich as isRichTerminal, theme } from "../../../packages/terminal-core/src/theme.js";
export { maskApiKey } from "../../utils/mask-api-key.js";

/** Enables rich terminal styling unless machine-readable/plain output was requested. */
export const isRich = (opts?: { json?: boolean; plain?: boolean }) =>
  isRichTerminal() && !opts?.json && !opts?.plain;

/** Pads table cells without hiding the plain text content from tests/JSON fallbacks. */
export const pad = (value: string, size: number) => value.padEnd(size);

/** Applies consistent color classes to model-list tag labels. */
export const formatTag = (tag: string, rich: boolean) => {
  if (!rich) {
    return tag;
  }
  if (tag === "default") {
    return theme.success(tag);
  }
  if (tag === "image") {
    return theme.accentBright(tag);
  }
  if (tag === "configured") {
    return theme.accent(tag);
  }
  if (tag === "missing") {
    return theme.error(tag);
  }
  if (tag.startsWith("fallback#")) {
    return theme.warn(tag);
  }
  if (tag.startsWith("img-fallback#")) {
    return theme.warn(tag);
  }
  if (tag.startsWith("alias:")) {
    return theme.accentDim(tag);
  }
  return theme.muted(tag);
};

/** Truncates model-list cells with an ASCII ellipsis for stable terminal width. */
export const truncate = (value: string, max: number) => {
  if (value.length <= max) {
    return value;
  }
  if (max <= 3) {
    return value.slice(0, max);
  }
  return `${value.slice(0, max - 3)}...`;
};
