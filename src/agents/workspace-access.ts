import path from "node:path";
import {
  collectErrorGraphCandidates,
  extractErrorCode,
} from "@openclaw/normalization-core/error-coercion";
import type { MemoryWorkspaceFiles } from "../../packages/memory-host-sdk/src/host/workspace-files.js";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.types.js";

/** Host-owned workspace files; callers keep their existing allowlists. */
export type AgentWorkspaceAccess = {
  /** Native Memory file operations; indexing and session state remain on Gateway. */
  memoryFiles?: MemoryWorkspaceFiles;
  bridge: Pick<
    SandboxFsBridge,
    "readFile" | "readFileWithSource" | "readDirectory" | "writeFile" | "stat"
  >;
};

const bindings = new Map<string, { access?: AgentWorkspaceAccess; active: boolean }>();

const WORKSPACE_ACCESS_UNAVAILABLE_CODE = "WORKSPACE_ACCESS_UNAVAILABLE";

/** The configured workspace host cannot currently provide the requested data. */
export class WorkspaceAccessUnavailableError extends Error {
  readonly code = WORKSPACE_ACCESS_UNAVAILABLE_CODE;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkspaceAccessUnavailableError";
  }
}

/** Match wrapped errors and separate SDK module instances without parsing messages. */
export function isWorkspaceAccessUnavailableError(error: unknown): boolean {
  return collectErrorGraphCandidates(error, (current) => [current.cause]).some(
    (candidate) => extractErrorCode(candidate) === WORKSPACE_ACCESS_UNAVAILABLE_CODE,
  );
}

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
  const lifetime = new AbortController();
  const assertCurrent = () => {
    if (!binding.active || bindings.get(key) !== binding) {
      throw new WorkspaceAccessUnavailableError("Workspace access is stopped or not ready");
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
  const memoryFiles = access.memoryFiles;
  if (memoryFiles) {
    const assertMemoryCurrent = () => {
      assertCurrent();
      memoryFiles.assertCurrent();
    };
    boundAccess.memoryFiles = Object.freeze<MemoryWorkspaceFiles>({
      assertCurrent: assertMemoryCurrent,
      async listFiles(...params) {
        assertMemoryCurrent();
        const result = await memoryFiles.listFiles(...params);
        assertMemoryCurrent();
        return result;
      },
      async inspectFile(...params) {
        assertMemoryCurrent();
        const result = await memoryFiles.inspectFile(...params);
        assertMemoryCurrent();
        return result;
      },
      async readFile(params) {
        assertMemoryCurrent();
        const result = await memoryFiles.readFile(params);
        assertMemoryCurrent();
        return result;
      },
      async readForIndexing(filePath) {
        assertMemoryCurrent();
        const result = await memoryFiles.readForIndexing(filePath);
        assertMemoryCurrent();
        return result;
      },
      async buildMultimodalChunk(entry) {
        assertMemoryCurrent();
        const result = await memoryFiles.buildMultimodalChunk(entry);
        assertMemoryCurrent();
        return result;
      },
      async watch(request, onChange, signal) {
        assertMemoryCurrent();
        const active = AbortSignal.any([signal, lifetime.signal]);
        active.throwIfAborted();
        await memoryFiles.watch(
          request,
          (event) => {
            if (!active.aborted) {
              assertMemoryCurrent();
              onChange(event);
            }
          },
          active,
        );
      },
    });
  }
  binding.access = Object.freeze(boundAccess);
  bindings.set(key, binding);
  return () => {
    // A stopped remote workspace remains remote; never expose stale local files.
    binding.active = false;
    lifetime.abort();
  };
}

export function getAgentWorkspaceAccess(workspaceDir: string): AgentWorkspaceAccess | undefined {
  const binding = bindings.get(path.resolve(workspaceDir));
  if (binding && !binding.active) {
    throw new WorkspaceAccessUnavailableError("Workspace access is stopped or not ready");
  }
  return binding?.access;
}
