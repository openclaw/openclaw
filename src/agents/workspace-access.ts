import path from "node:path";
import {
  collectErrorGraphCandidates,
  extractErrorCode,
} from "@openclaw/normalization-core/error-coercion";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.types.js";

/** Host-owned workspace files; callers keep their existing allowlists. */
export type AgentWorkspaceAccess = {
  bridge: Pick<
    SandboxFsBridge,
    "readFile" | "readFileWithSource" | "readDirectory" | "writeFile" | "stat"
  >;
  /** Purpose-scoped output reads; the document bridge need not allow attachment paths. */
  outboundMedia?: {
    localRoots: readonly string[];
    readFile: (filePath: string, maxBytes: number) => Promise<Buffer>;
  };
};

type WorkspaceBinding = { access?: AgentWorkspaceAccess; active: boolean };
const bindings = new Map<string, WorkspaceBinding>();

function assertBindingCurrent(key: string, binding: WorkspaceBinding): void {
  if (!binding.active || bindings.get(key) !== binding) {
    throw new WorkspaceAccessUnavailableError("Workspace access is stopped or not ready");
  }
}

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
  const binding: WorkspaceBinding = { active: true };
  const assertCurrent = () => assertBindingCurrent(key, binding);
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
  const outboundMedia = access.outboundMedia;
  if (outboundMedia) {
    const readFile = outboundMedia.readFile.bind(outboundMedia);
    boundAccess.outboundMedia = Object.freeze({
      localRoots: Object.freeze([...outboundMedia.localRoots]),
      async readFile(filePath: string, maxBytes: number) {
        assertCurrent();
        const data = await readFile(filePath, maxBytes);
        assertCurrent();
        return data;
      },
    });
  }
  binding.access = Object.freeze(boundAccess);
  bindings.set(key, binding);
  return () => {
    // A stopped remote workspace remains remote; never expose stale local files.
    binding.active = false;
  };
}

export function getAgentWorkspaceAccess(workspaceDir: string): AgentWorkspaceAccess | undefined {
  const key = path.resolve(workspaceDir);
  const binding = bindings.get(key);
  if (binding) {
    assertBindingCurrent(key, binding);
  }
  return binding?.access;
}

/** Internal routing capture: unrelated Gateway media remains usable while the host is offline. */
export function captureAgentWorkspaceOutboundMedia(
  workspaceDir: string,
): NonNullable<AgentWorkspaceAccess["outboundMedia"]> | undefined {
  const key = path.resolve(workspaceDir);
  const binding = bindings.get(key);
  if (!binding) {
    return undefined;
  }
  const media = binding.access?.outboundMedia;
  // Registering document access does not opt an existing adapter into remote attachments.
  if (binding.access && !media) {
    return undefined;
  }
  return {
    localRoots: media?.localRoots ?? [],
    async readFile(filePath, maxBytes) {
      // Never adopt a replacement binding on a retained delivery capability.
      assertBindingCurrent(key, binding);
      if (!media) {
        throw new Error("Remote workspace attachment access is unavailable");
      }
      return await media.readFile(filePath, maxBytes);
    },
  };
}
