// Routes the first-class /dashboard command through the canonical Control UI skill.
import {
  expandExplicitSkillReferences,
  skillCommandsToExplicitSelections,
} from "../../skills/discovery/chat-command-invocation.js";
import { applyCommandTextToParams } from "./command-context-rewrite.js";
import { commandReply, defineAuthorizedTextCommand, matchCommandPrefix } from "./command-gates.js";
import type { CommandHandler } from "./commands-types.js";

const DASHBOARD_COMMAND = "/dashboard";
const CONTROL_UI_SKILL = "control-ui";
const DEFAULT_DASHBOARD_REQUEST = "Create a dashboard for this session.";

/** Built-in command handler that guarantees the dashboard operating skill is selected. */
export const handleDashboardCommand: CommandHandler = defineAuthorizedTextCommand(
  {
    label: DASHBOARD_COMMAND,
    match: (body) => matchCommandPrefix(body, DASHBOARD_COMMAND),
  },
  async (params, requirements) => {
    const loaded = (await params.loadSkillCommands?.()) ?? params.skillCommands ?? [];
    const controlUi =
      (await params.loadBundledSkillCommand?.(CONTROL_UI_SKILL)) ??
      loaded.find(
        (skill) =>
          skill.skillSource === "bundled" &&
          skill.skillName.trim().toLowerCase() === CONTROL_UI_SKILL,
      );
    if (!controlUi) {
      return commandReply(
        "Dashboard support is unavailable because the control-ui skill is unavailable for this agent.",
      );
    }
    const trimmed = requirements.trim();
    const request = trimmed
      ? `${DEFAULT_DASHBOARD_REQUEST}\n\nDashboard requirements:\n${trimmed}`
      : DEFAULT_DASHBOARD_REQUEST;
    const expanded = expandExplicitSkillReferences({
      text: `$${controlUi.name} ${request}`,
      skillCommands: [
        controlUi,
        ...loaded.filter((skill) => skill.skillFile !== controlUi.skillFile),
      ],
    });
    if (expanded.error || expanded.skills.length === 0) {
      return commandReply(expanded.error ?? "The control-ui skill could not be selected.");
    }
    const explicitSkillSelections = skillCommandsToExplicitSelections(expanded.skills);
    if (explicitSkillSelections.length === 0) {
      return commandReply("The control-ui skill file could not be resolved.");
    }
    applyCommandTextToParams(params, expanded.body);
    return { shouldContinue: true, explicitSkillSelections };
  },
);
