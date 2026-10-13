import { ensureAgentWorkspace } from "../../agents/workspace.js";

type PluginWorkspaceParams = Omit<
  NonNullable<Parameters<typeof ensureAgentWorkspace>[0]>,
  "guard"
> & {
  guard?: { assertHost?: () => void };
};

export function ensurePluginAgentWorkspace(params?: PluginWorkspaceParams) {
  return ensureAgentWorkspace(params);
}
