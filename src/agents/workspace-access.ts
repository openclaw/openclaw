import path from "node:path";
import {
  collectErrorGraphCandidates,
  extractErrorCode,
} from "@openclaw/normalization-core/error-coercion";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readPersistedMediaFacts, type MediaFact } from "../media/media-facts.js";
import type { UserTurnTranscriptRecorder } from "../sessions/user-turn-transcript.types.js";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.types.js";

type WorkspaceAttachmentTurn = {
  abortSignal?: AbortSignal;
  config?: OpenClawConfig;
  media?: MediaFact[];
  timeoutMs: number;
};

/** Host-owned workspace files; callers keep their existing allowlists. */
export type AgentWorkspaceAccess = {
  bridge: Pick<
    SandboxFsBridge,
    "readFile" | "readFileWithSource" | "readDirectory" | "writeFile" | "stat"
  >;
  /** Transfer admitted originals and return execution-only paths; leave recorded media unchanged. */
  prepareTurnAttachments?: (
    turn: WorkspaceAttachmentTurn,
    assertCurrent: () => void,
  ) => Promise<string | undefined>;
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
  const prepareTurnAttachments = access.prepareTurnAttachments?.bind(access);
  if (prepareTurnAttachments) {
    boundAccess.prepareTurnAttachments = async (turn, assertRunCurrent) => {
      const assertPreparationCurrent = () => {
        assertCurrent();
        turn.abortSignal?.throwIfAborted();
        assertRunCurrent();
      };
      assertPreparationCurrent();
      const note = await prepareTurnAttachments(turn, assertPreparationCurrent);
      assertPreparationCurrent();
      return note;
    };
  }
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
    throw new WorkspaceAccessUnavailableError("Workspace access is stopped or not ready");
  }
  return binding?.access;
}

/** Prepare execution-only paths while retaining canonical media and transcript facts. */
export async function prepareAgentWorkspaceAttachments(params: {
  workspaceDir: string;
  turn: WorkspaceAttachmentTurn & { userTurnTranscriptRecorder?: UserTurnTranscriptRecorder };
  assertCurrent: () => void;
}): Promise<string | undefined> {
  if (!params.turn.media?.length && !params.turn.userTurnTranscriptRecorder) {
    return undefined;
  }
  const access = getAgentWorkspaceAccess(params.workspaceDir);
  if (!access?.prepareTurnAttachments) {
    return undefined;
  }
  const assertCurrent = () => {
    params.turn.abortSignal?.throwIfAborted();
    params.assertCurrent();
    if (getAgentWorkspaceAccess(params.workspaceDir) !== access) {
      throw new Error("Workspace access changed during attachment preparation");
    }
  };
  assertCurrent();
  const recorder = params.turn.userTurnTranscriptRecorder;
  const message = (await recorder?.resolveMessage()) ?? recorder?.message;
  assertCurrent();
  // Deferred originals can differ from both the initial snapshot and runtime media.
  const facts = (message ? readPersistedMediaFacts(message) : undefined) ?? params.turn.media ?? [];
  if (!facts.some((fact) => fact.path?.trim() || fact.url?.trim())) {
    return undefined;
  }
  const note = await access.prepareTurnAttachments(
    {
      config: params.turn.config,
      media: facts,
      timeoutMs: params.turn.timeoutMs,
      abortSignal: params.turn.abortSignal,
    },
    assertCurrent,
  );
  assertCurrent();
  return note;
}
