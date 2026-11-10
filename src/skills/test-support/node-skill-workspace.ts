import { registerAgentWorkspaceAccess } from "../../agents/workspace-access.js";
import { readWorkspaceSkillSources } from "../loading/workspace-skill-source-reader.js";
import { resolveWorkspaceSkillSourcePlan } from "../loading/workspace-skill-sources.js";

/**
 * Simulates a paired node that serves `nodeWorkspace` for an agent whose Gateway-side
 * workspace path is `gatewayWorkspace`. The node reads only its own workspace and records
 * which execution root it was asked for; dispose to unregister it.
 */
export function registerNodeSkillWorkspace(gatewayWorkspace: string, nodeWorkspace: string) {
  const executionRoots: Array<string | undefined> = [];
  const release = registerAgentWorkspaceAccess(gatewayWorkspace, {
    bridge: {
      readFile: async () => Buffer.alloc(0),
      writeFile: async () => {},
      stat: async () => null,
    } as never,
    loadSkills: async (request) => {
      executionRoots.push(request.executionWorkspaceDir);
      return readWorkspaceSkillSources({
        ...request,
        executionWorkspaceDir: undefined,
        sourcePlan: resolveWorkspaceSkillSourcePlan(nodeWorkspace, { workspaceOnly: true }),
      });
    },
  });
  return { executionRoots, [Symbol.dispose]: release };
}
