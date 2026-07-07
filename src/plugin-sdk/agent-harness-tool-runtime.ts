/**
 * Focused runtime SDK subpath for native harness tool-surface routing.
 *
 * Keep tool-search and code-mode dependencies out of the lightweight harness
 * lifecycle facade used during plugin startup.
 */
export {
  createAgentHarnessToolSurfaceRuntime,
  type AgentHarnessToolSurfaceRuntime,
} from "../agents/harness/tool-surface-bridge.js";
