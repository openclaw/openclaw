// Narrow agent-scope helpers for control-plane and migration paths.

export {
  listAgentIds,
  resolveAgentConfig,
  resolveAgentDir,
  resolveDefaultAgentId,
  resolveSessionAgentId,
  resolveSessionAgentIds,
  resolveSessionAgentIds as resolveSessionAgentIdsStrict,
  tryResolveDefaultAgentId,
} from "../agents/agent-scope.js";
