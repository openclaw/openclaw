// Focused runtime contract for memory CLI/UI helpers.

export { formatErrorMessage, withManager } from "../cli/cli-utils.js";
export { formatHelpExamples } from "../cli/help-format.js";
export { resolveCommandSecretRefsViaGateway } from "../cli/command-secret-gateway.js";
export { withProgress, withProgressTotals } from "../cli/progress.js";
export { defaultRuntime } from "../runtime.js";
export { formatDocsLink } from "../terminal/links.js";
export { colorize, isRich, theme } from "../terminal/theme.js";
export { isVerbose, setVerbose } from "../globals.js";
export { shortenHomeInString, shortenHomePath } from "../utils.js";
