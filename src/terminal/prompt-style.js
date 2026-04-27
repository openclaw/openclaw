import { isRich, theme } from "./theme.js";
export const stylePromptMessage = (message) => isRich() ? theme.accent(message) : message;
export const stylePromptTitle = (title) => title && isRich() ? theme.heading(title) : title;
export const stylePromptHint = (hint) => hint && isRich() ? theme.muted(hint) : hint;
