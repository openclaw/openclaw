// Private official-plugin runtime helpers, backed by canonical terminal sanitization.
// Avoid loading Markdown rendering or channel/runtime helpers in parser workers.
export {
  hasTerminalControl,
  sanitizeTerminalText,
  terminalText,
} from "../../packages/terminal-core/src/safe-text.js";
