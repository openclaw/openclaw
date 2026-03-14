import { resolveAgentNarrativeDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { readModeState, writeModeState } from "../../plugins/mind-memory/intensive-mode.js";
import type { CommandHandler } from "./commands-types.js";

export const handleHyperfocusCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }

  const body = params.command.commandBodyNormalized.trim();
  if (!body.startsWith("/hyperfocus")) {
    return null;
  }

  const arg = body
    .replace(/^\/hyperfocus\b/, "")
    .trim()
    .toLowerCase();
  const wantsOff = arg === "off" || arg === "disable" || arg === "deactivate";
  const wantsOn = !arg || arg === "on" || arg === "enable" || arg === "activate";

  if (!wantsOff && !wantsOn) {
    return null;
  }

  try {
    const agentId = params.agentId ?? resolveDefaultAgentId(params.cfg);
    const narrativeDir = resolveAgentNarrativeDir(params.cfg, agentId);

    const current = await readModeState(narrativeDir);

    if (wantsOff) {
      if (current.mode === "normal") {
        return { reply: { text: "Already in normal mode." }, shouldContinue: false };
      }
      await writeModeState(narrativeDir, { mode: "normal" });
      return {
        reply: {
          text: "Normal mode restored. Full STORY.md + flashbacks will be active on the next message.",
        },
        shouldContinue: false,
      };
    }

    // wantsOn
    if (current.mode === "intensive") {
      return { reply: { text: "Hyperfocus mode is already active." }, shouldContinue: false };
    }
    await writeModeState(narrativeDir, {
      mode: "intensive",
      activatedAt: new Date().toISOString(),
    });
    return {
      reply: {
        text: [
          "Hyperfocus mode activated.",
          "Next message will use SUMMARY.md (compact narrative) + no flashbacks.",
          "SOUL.md, USER.md, MEMORY.md are suppressed for this session.",
          "Use /hyperfocus off to return to normal mode.",
        ].join("\n"),
      },
      shouldContinue: false,
    };
  } catch (err: unknown) {
    return {
      reply: {
        text: `Error toggling hyperfocus mode: ${err instanceof Error ? err.message : String(err)}`,
      },
      shouldContinue: false,
    };
  }
};
