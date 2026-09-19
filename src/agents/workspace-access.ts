import path from "node:path";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.types.js";

/** Host-owned workspace files; callers keep their existing allowlists. */
export type AgentWorkspaceAccess = {
  bridge: Pick<
    SandboxFsBridge,
    "readFile" | "readFileWithSource" | "readDirectory" | "writeFile" | "stat"
  >;
};

const bindings = new Map<string, { access?: AgentWorkspaceAccess; active: boolean }>();

/** Declare ownership during plugin registration so startup cannot fall back to a local copy. */
export function declareAgentWorkspaceAccess(workspaceDir: string): void {
  const key = path.resolve(workspaceDir);
  if (!bindings.has(key)) {
    bindings.set(key, { active: false });
  }
}

/**
 * Bind host access independently of an active harness turn. Releasing rejects
 * subsequent calls and stale results; it cannot undo an already dispatched write.
 */
export function registerAgentWorkspaceAccess(
  workspaceDir: string,
  access: AgentWorkspaceAccess,
): () => void {
  const key = path.resolve(workspaceDir);
  if (bindings.get(key)?.active) {
    throw new Error(`Workspace access is already registered: ${key}`);
  }
  const binding: { access?: AgentWorkspaceAccess; active: boolean } = { active: true };
  const assertCurrent = () => {
    if (!binding.active || bindings.get(key) !== binding) {
      throw new Error("Workspace access is stopped or not ready");
    }
  };
  // Retained methods must stop working when their service stops or is replaced.
  const bridge: AgentWorkspaceAccess["bridge"] = {
    async readFile(params) {
      assertCurrent();
      const result = await access.bridge.readFile(params);
      assertCurrent();
      return result;
    },
    async writeFile(params) {
      assertCurrent();
      await access.bridge.writeFile(params);
      assertCurrent();
    },
    async stat(params) {
      assertCurrent();
      const result = await access.bridge.stat(params);
      assertCurrent();
      return result;
    },
  };
  const readFileWithSource = access.bridge.readFileWithSource?.bind(access.bridge);
  if (readFileWithSource) {
    bridge.readFileWithSource = async (params) => {
      assertCurrent();
      const result = await readFileWithSource(params);
      assertCurrent();
      return result;
    };
  }
  const readDirectory = access.bridge.readDirectory?.bind(access.bridge);
  if (readDirectory) {
    bridge.readDirectory = async (params) => {
      assertCurrent();
      const result = await readDirectory(params);
      assertCurrent();
      return result;
    };
  }
  const boundAccess: AgentWorkspaceAccess = { bridge: Object.freeze(bridge) };
  binding.access = Object.freeze(boundAccess);
  bindings.set(key, binding);
  return () => {
    // A stopped remote workspace remains remote; never expose stale local files.
    binding.active = false;
  };
}

export function getAgentWorkspaceAccess(workspaceDir: string): AgentWorkspaceAccess | undefined {
  const binding = bindings.get(path.resolve(workspaceDir));
  if (binding && !binding.active) {
    throw new Error("Workspace access is stopped or not ready");
  }
  return binding?.access;
}
