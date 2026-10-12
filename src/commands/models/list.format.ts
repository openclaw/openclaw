import { truncateToVisibleWidth, visibleWidth } from "../../../packages/terminal-core/src/ansi.js";
import { sanitizeTerminalText } from "../../../packages/terminal-core/src/safe-text.js";
import { isRich as isRichTerminal, theme } from "../../../packages/terminal-core/src/theme.js";

const TRUNCATED_SUFFIX = "...";

export const formatTokenK = (value?: number | null) => {
  if (!value || !Number.isFinite(value)) {
    return "-";
  }
  // Provider context windows use decimal K, so 200000 must stay "200k".
  if (value < 1000) {
    return `${Math.round(value)}`;
  }
  return `${Math.round(value / 1000)}k`;
};

export const isRich = (opts?: { json?: boolean; plain?: boolean }) =>
  isRichTerminal() && !opts?.json && !opts?.plain;

export const padTerminalCell = (value: string, size: number) => {
  const remaining = size - visibleWidth(value);
  return remaining > 0 ? `${value}${" ".repeat(remaining)}` : value;
};

export const formatTag = (tag: string) => {
  switch (tag) {
    case "default":
      return theme.success(tag);
    case "image":
      return theme.accentBright(tag);
    case "configured":
      return theme.accent(tag);
    case "missing":
      return theme.error(tag);
  }
  if (tag.startsWith("fallback#") || tag.startsWith("img-fallback#")) {
    return theme.warn(tag);
  }
  if (tag.startsWith("alias:")) {
    return theme.accentDim(tag);
  }
  return theme.muted(tag);
};

export const truncate = (value: string, max: number) => {
  const sanitized = sanitizeTerminalText(value);
  if (visibleWidth(sanitized) <= max) {
    return sanitized;
  }
  if (max <= TRUNCATED_SUFFIX.length) {
    return truncateToVisibleWidth(sanitized, max);
  }
  return `${truncateToVisibleWidth(sanitized, max - TRUNCATED_SUFFIX.length)}${TRUNCATED_SUFFIX}`;
};
