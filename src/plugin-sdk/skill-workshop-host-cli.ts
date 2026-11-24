// Bundled-only CLI host helpers for the Skill Workshop plugin's `openclaw skills workshop`
// group, in the memory-core-host-runtime-cli pattern. Re-exports existing core behavior: the
// skills CLI's agent resolution and Gateway-first routing, and the shared CLI formatting.
export {
  resolveSkillsWorkspace,
  routeSkillsCliRequest,
  type ResolvedSkillsWorkspace,
} from "../cli/skills-cli-gateway.js";
export { runCommandWithRuntime } from "../cli/cli-utils.js";
export { formatCliCommand } from "../cli/command-format.js";
export { applyParentDefaultHelpAction } from "../cli/program/parent-default-help.js";
export { formatTimeAgo } from "../infra/format-time/format-relative.ts";
export { terminalText } from "../../packages/terminal-core/src/safe-text.js";
export { theme } from "../../packages/terminal-core/src/theme.js";
