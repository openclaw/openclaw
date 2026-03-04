import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveStorePath } from "../../config/sessions/paths.js";
import { updateSessionStore } from "../../config/sessions/store.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { resolveAgentIdFromSessionKey } from "../../routing/session-key.js";
import { loadWorkspaceSkillEntries } from "../skills.js";
import type { AnyAgentTool } from "./common.js";

const LoadSkillSchema = Type.Object({
  skillName: Type.String({ description: "The name of the skill to load ex: 'github'" }),
});

export function createLoadSkillTool(params: {
  workspaceDir: string;
  sessionKey?: string;
  config?: OpenClawConfig;
  sessionStorePath?: string;
  currentSnapshot?: SessionEntry["skillsSnapshot"];
}): AnyAgentTool {
  return {
    name: "load_skill",
    label: "Load Skill",
    description: "Load a lazy skill into the current session to make its tools available.",
    parameters: LoadSkillSchema,
    execute: async (_id, { skillName }) => {
      const { workspaceDir, config } = params;
      let { sessionStorePath, sessionKey } = params;

      if (!sessionKey) {
        return {
          content: [{ type: "text", text: "Session context not available (no sessionKey)." }],
          isError: true,
          details: null,
        };
      }

      // Resolve store path if not provided
      if (!sessionStorePath) {
        const agentId = resolveAgentIdFromSessionKey(sessionKey);
        sessionStorePath = resolveStorePath(config?.session?.store, { agentId });
      }

      if (!sessionStorePath) {
        return {
          content: [{ type: "text", text: "Session store path could not be resolved." }],
          isError: true,
          details: null,
        };
      }

      // 1. Load all skills to find the target
      const allSkills = loadWorkspaceSkillEntries(workspaceDir, { config });
      const targetSkill = allSkills.find((s) => s.skill.name === skillName);

      if (!targetSkill) {
        return {
          content: [{ type: "text", text: `Skill '${skillName}' not found in workspace.` }],
          isError: true,
          details: null,
        };
      }

      // 2. Update snapshot
      let updated = false;
      let alreadyLoaded = false;

      await updateSessionStore(sessionStorePath, (store) => {
        const session = store[sessionKey];
        if (!session) {
          return;
        }

        const snapshot = session.skillsSnapshot || { prompt: "", skills: [], version: 0 };

        const skillRefIndex = snapshot.skills.findIndex((s) => s.name === skillName);
        if (skillRefIndex >= 0) {
          // Already present.
          alreadyLoaded = true;
        } else {
          // Add it to the snapshot skills list.
          // We need to match the type: { name: string; primaryEnv?: string; requiredEnv?: string[] }
          snapshot.skills.push({
            name: skillName,
            primaryEnv: targetSkill.metadata?.primaryEnv,
            requiredEnv: targetSkill.metadata?.requires?.env,
          });
          updated = true;
        }

        if (updated) {
          // Force regeneration of snapshot prompt/resolvedSkills in the next turn
          snapshot.resolvedSkills = undefined;
          session.skillsSnapshot = snapshot;
        }
      });

      if (updated) {
        return {
          content: [
            {
              type: "text",
              text: `Skill '${skillName}' has been loaded. Its tools will be available in the next turn.`,
            },
          ],
          details: null,
        };
      }
      if (alreadyLoaded) {
        return {
          content: [{ type: "text", text: `Skill '${skillName}' is already loaded.` }],
          details: null,
        };
      }
      return {
        content: [{ type: "text", text: "Failed to update session with new skill." }],
        isError: true,
        details: null,
      };
    },
  };
}
