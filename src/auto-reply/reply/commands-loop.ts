import { resolveAgentNarrativeDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { readModeState, writeModeState } from "../../plugins/mind-memory/intensive-mode.js";
import type { CommandHandler } from "./commands-types.js";

const LOOP_MAX_ITERATIONS_CAP = 100;
const LOOP_DEFAULT_ITERATIONS = 50;

/**
 * Parses the body after "/loop":
 *   ""            → { wantsOff: false, maxIterations: undefined, goal: undefined }
 *   "off"         → { wantsOff: true }
 *   "20"          → { maxIterations: 20, goal: undefined }
 *   "do the thing" → { maxIterations: undefined, goal: "do the thing" }
 *   "20 do the thing" → { maxIterations: 20, goal: "do the thing" }
 */
function parseLoopArgs(arg: string): {
  wantsOff: boolean;
  maxIterations?: number;
  goal?: string;
} {
  const lower = arg.toLowerCase();
  if (lower === "off" || lower === "disable" || lower === "deactivate") {
    return { wantsOff: true };
  }

  const firstToken = arg.split(/\s+/)[0] ?? "";
  const parsed = parseInt(firstToken, 10);
  const firstIsNumber = /^\d+$/.test(firstToken) && !isNaN(parsed) && parsed > 0;

  if (firstIsNumber) {
    const rest = arg.slice(firstToken.length).trim();
    return {
      wantsOff: false,
      maxIterations: Math.min(parsed, LOOP_MAX_ITERATIONS_CAP),
      goal: rest || undefined,
    };
  }

  return {
    wantsOff: false,
    maxIterations: undefined,
    goal: arg || undefined,
  };
}

export const handleLoopCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }

  const body = params.command.commandBodyNormalized.trim();
  if (!body.startsWith("/loop")) {
    return null;
  }

  const arg = body.replace(/^\/loop\b/, "").trim();

  const parsed = parseLoopArgs(arg);

  try {
    const agentId = params.agentId ?? resolveDefaultAgentId(params.cfg);
    const narrativeDir = resolveAgentNarrativeDir(params.cfg, agentId);
    const current = await readModeState(narrativeDir);

    if (parsed.wantsOff) {
      if (current.mode === "normal") {
        return { reply: { text: "Already in normal mode." }, shouldContinue: false };
      }
      await writeModeState(narrativeDir, { mode: "normal" });
      const wasLoop = current.mode === "loop";
      return {
        reply: {
          text: wasLoop
            ? "Loop mode deactivated. Full STORY.md + flashbacks will be active on the next message."
            : "Normal mode restored. Full STORY.md + flashbacks will be active on the next message.",
        },
        shouldContinue: false,
      };
    }

    // Activation
    if (current.mode === "loop") {
      return { reply: { text: "Loop mode is already active." }, shouldContinue: false };
    }

    const maxIterations = parsed.maxIterations ?? LOOP_DEFAULT_ITERATIONS;

    // When activated via user command, keep current session model (useDefaultModel: false / omitted).
    await writeModeState(narrativeDir, {
      mode: "loop",
      activatedAt: new Date().toISOString(),
      goal: parsed.goal,
      maxIterations,
      loopIteration: 0,
      useDefaultModel: false,
    });

    const goalLine = parsed.goal ? `\nGoal: ${parsed.goal}` : "";
    const limitLine = `\nMax iterations: ${maxIterations}`;
    return {
      reply: {
        text: [
          "Loop mode activated.",
          `Next message will start autonomous operation (SUMMARY.md context, no flashbacks).${goalLine}${limitLine}`,
          "The agent will continue working until it calls deactivate_loop_mode with a summary.",
          "Use /loop off to force-stop.",
        ].join("\n"),
      },
      shouldContinue: false,
    };
  } catch (err: unknown) {
    return {
      reply: {
        text: `Error toggling loop mode: ${err instanceof Error ? err.message : String(err)}`,
      },
      shouldContinue: false,
    };
  }
};
