// Workspace access registration without loading agent execution runtime.
export {
  isWorkspaceAccessUnavailableError,
  WorkspaceAccessUnavailableError,
  declareAgentWorkspaceAccess,
  registerAgentWorkspaceAccess,
  getAgentWorkspaceAccess,
  type AgentWorkspaceAccess,
} from "../agents/workspace-access.js";
export { createWorkspaceBootstrapFilePolicy } from "../agents/workspace-bootstrap-policy.js";
