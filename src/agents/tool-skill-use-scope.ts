import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { SkillTelemetrySource } from "../skills/types.js";
import type { SkillUsageMatch } from "./agent-tools.before-tool-call.diagnostics.js";
import { canonicalizePath } from "./utils/paths.js";

/** One demonstrated skill read by the tool call that owns this scope. */
export type ToolSkillUse = {
  skillFile: string;
  skillName: string;
  skillSource?: SkillTelemetrySource;
};

type ToolSkillUseRecorder = (use: ToolSkillUse) => boolean;

// Process-wide: plugin runtime facades and agent tool wrappers may load separate module
// instances, and attribution must come from the executing tool call, never caller input.
const toolSkillUseScope = resolveGlobalSingleton(
  Symbol.for("openclaw.agentToolSkillUseScope"),
  () => new AsyncLocalStorage<ToolSkillUseRecorder>(),
);

/** Recorder bound to one tool call's run facts; closed once that call settles. */
export function createToolSkillUseRecorder(record: (match: SkillUsageMatch) => void) {
  let recordMatch: typeof record | undefined = record;
  const recorder: ToolSkillUseRecorder = (use) => {
    if (!recordMatch) {
      return false;
    }
    const skillFile = path.isAbsolute(use.skillFile)
      ? canonicalizePath(path.resolve(use.skillFile))
      : undefined;
    if (!skillFile || path.basename(skillFile) !== "SKILL.md") {
      throw new Error(`Skill usage needs an absolute SKILL.md path: ${use.skillFile}`);
    }
    recordMatch({
      skillFile,
      skillName: use.skillName,
      skillSource: use.skillSource ?? "unknown",
      activation: "read",
    });
    return true;
  };
  return {
    run: <T>(run: () => T): T => toolSkillUseScope.run(recorder, run),
    close: () => {
      // Detached resources can retain this scope after the tool call settles.
      recordMatch = undefined;
    },
  };
}

/** Records a skill use for the executing tool call; false outside a live tool execution. */
export function recordToolSkillUse(use: ToolSkillUse): boolean {
  return toolSkillUseScope.getStore()?.(use) ?? false;
}
