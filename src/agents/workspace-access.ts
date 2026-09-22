import path from "node:path";
import {
  collectErrorGraphCandidates,
  extractErrorCode,
} from "@openclaw/normalization-core/error-coercion";
import type { MemoryWorkspaceFiles } from "../../packages/memory-host-sdk/src/host/workspace-files.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readPersistedMediaFacts, type MediaFact } from "../media/media-facts.js";
import type { UserTurnTranscriptRecorder } from "../sessions/user-turn-transcript.types.js";
import type { WorkspaceSkillLifecycle } from "../skills/lifecycle/workspace-types.js";
import type {
  WorkspaceSkillSourceRequest,
  WorkspaceSkillSources,
} from "../skills/loading/workspace-skill-sources.types.js";
import type { SkillResourceSourceReader } from "../skills/types.js";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.types.js";

type WorkspaceAttachmentTurn = {
  abortSignal?: AbortSignal;
  config?: OpenClawConfig;
  media?: MediaFact[];
  timeoutMs: number;
};

/** Host-owned workspace files; callers keep their existing allowlists. */
export type AgentWorkspaceAccess = {
  /** Native Memory file operations; indexing and session state remain on Gateway. */
  memoryFiles?: MemoryWorkspaceFiles;
  /** Execute a Gateway-approved dependency recipe on the workspace host. */
  installSkillDependencies?: WorkspaceSkillLifecycle["installSkillDependencies"];
  /** Read native source tiers and execution-host facts without applying Gateway policy. */
  loadSkills?: (request: WorkspaceSkillSourceRequest) => Promise<WorkspaceSkillSources>;
  /** Keep a host subscription alive until aborted; notify without transferring file contents. */
  watchSkills?: (
    request: Pick<WorkspaceSkillSourceRequest, "sourcePlan" | "executionWorkspaceDir">,
    onChange: (event: "change" | "unavailable") => void,
    signal: AbortSignal,
  ) => Promise<void>;
  skillResources?: SkillResourceSourceReader;
  /** Transfer the source tree and apply it on the host; run beforeInstall on Gateway. */
  applySkillRoot?: WorkspaceSkillLifecycle["applyExtractedSkillRoot"];
  recordSkillSourceInstall?: WorkspaceSkillLifecycle["recordSkillSourceInstall"];
  clawHubSkills?: Omit<
    WorkspaceSkillLifecycle,
    "installSkillDependencies" | "applyExtractedSkillRoot" | "recordSkillSourceInstall"
  >;
  bridge: Pick<
    SandboxFsBridge,
    "readFile" | "readFileWithSource" | "readDirectory" | "writeFile" | "stat"
  >;
  /** Purpose-scoped output reads; the document bridge need not allow attachment paths. */
  outboundMedia?: {
    localRoots: readonly string[];
    readFile: (filePath: string, maxBytes: number) => Promise<Buffer>;
  };
  /** Transfer admitted originals and return execution-only paths; leave recorded media unchanged. */
  prepareTurnAttachments?: (
    turn: WorkspaceAttachmentTurn,
    assertCurrent: () => void,
  ) => Promise<string | undefined>;
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
  const lifetime = new AbortController();
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
  const memoryFiles = access.memoryFiles;
  if (memoryFiles) {
    const assertMemoryCurrent = () => {
      assertCurrent();
      memoryFiles.assertCurrent();
    };
    const guardMemoryCall =
      <Args extends unknown[], Result>(call: (...args: Args) => Promise<Result>) =>
      async (...args: Args): Promise<Result> => {
        assertMemoryCurrent();
        const result = await call(...args);
        assertMemoryCurrent();
        return result;
      };
    const maintenance = memoryFiles.maintenance;
    boundAccess.memoryFiles = Object.freeze<MemoryWorkspaceFiles>({
      assertCurrent: assertMemoryCurrent,
      ...(maintenance
        ? {
            maintenance: Object.freeze<NonNullable<MemoryWorkspaceFiles["maintenance"]>>({
              readFile: guardMemoryCall(maintenance.readFile.bind(maintenance)),
              stat: guardMemoryCall(maintenance.stat.bind(maintenance)),
              listDirectory: guardMemoryCall(maintenance.listDirectory.bind(maintenance)),
              mkdir: guardMemoryCall(maintenance.mkdir.bind(maintenance)),
              rename: guardMemoryCall(maintenance.rename.bind(maintenance)),
              resolveWritePath: guardMemoryCall(maintenance.resolveWritePath.bind(maintenance)),
              async commitContent(params) {
                assertMemoryCurrent();
                await maintenance.commitContent(params);
                try {
                  assertMemoryCurrent();
                } catch (cause) {
                  // Revocation still rejects access, but cannot undo a confirmed publication.
                  throw Object.assign(
                    new WorkspaceAccessUnavailableError(
                      "Workspace access stopped after Memory write committed",
                      { cause },
                    ),
                    { publication: "committed" as const },
                  );
                }
              },
              resolveDreamsPath: guardMemoryCall(maintenance.resolveDreamsPath.bind(maintenance)),
              readDreams: guardMemoryCall(maintenance.readDreams.bind(maintenance)),
              writeDreams: guardMemoryCall(maintenance.writeDreams.bind(maintenance)),
              replaceReport: guardMemoryCall(maintenance.replaceReport.bind(maintenance)),
              appendCorpus: guardMemoryCall(maintenance.appendCorpus.bind(maintenance)),
            }),
          }
        : {}),
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
  const installSkillDependencies = access.installSkillDependencies?.bind(access);
  if (installSkillDependencies) {
    boundAccess.installSkillDependencies = async (params) => {
      assertCurrent();
      const result = await installSkillDependencies(params);
      assertCurrent();
      return result;
    };
  }
  const loadSkills = access.loadSkills?.bind(access);
  if (loadSkills) {
    boundAccess.loadSkills = async (request) => {
      assertCurrent();
      let result: WorkspaceSkillSources;
      try {
        result = await loadSkills(request);
      } catch (cause) {
        throw new WorkspaceAccessUnavailableError("Remote workspace skill discovery failed", {
          cause,
        });
      }
      assertCurrent();
      return result;
    };
  }
  const watchSkills = access.watchSkills?.bind(access);
  if (watchSkills) {
    boundAccess.watchSkills = async (request, onChange, signal) => {
      assertCurrent();
      const active = AbortSignal.any([signal, lifetime.signal]);
      active.throwIfAborted();
      await watchSkills(
        request,
        (event) => {
          if (!active.aborted && binding.active && bindings.get(key) === binding) {
            onChange(event);
          }
        },
        active,
      );
    };
  }
  const skillResources = access.skillResources;
  if (skillResources) {
    boundAccess.skillResources = Object.freeze({
      async readInstructions(filePath, options) {
        assertCurrent();
        options.signal?.throwIfAborted();
        const result = await skillResources.readInstructions(filePath, options);
        assertCurrent();
        options.signal?.throwIfAborted();
        return result;
      },
      async resolveExplicitSkill(selection) {
        assertCurrent();
        const result = await skillResources.resolveExplicitSkill(selection);
        assertCurrent();
        return result;
      },
      async readSkillFiles(skill, options) {
        assertCurrent();
        const result = await skillResources.readSkillFiles(skill, options);
        assertCurrent();
        return result;
      },
    });
  }
  const applySkillRoot = access.applySkillRoot?.bind(access);
  if (applySkillRoot) {
    boundAccess.applySkillRoot = async (params) => {
      assertCurrent();
      const result = await applySkillRoot({
        ...params,
        beforeInstall: async (mode) => {
          assertCurrent();
          const decision = await params.beforeInstall?.(mode);
          assertCurrent();
          return decision;
        },
      });
      assertCurrent();
      return result;
    };
  }
  const recordSkillSourceInstall = access.recordSkillSourceInstall?.bind(access);
  if (recordSkillSourceInstall) {
    boundAccess.recordSkillSourceInstall = async (params) => {
      assertCurrent();
      await recordSkillSourceInstall(params);
      assertCurrent();
    };
  }
  const clawHubSkills = access.clawHubSkills;
  if (clawHubSkills) {
    boundAccess.clawHubSkills = Object.freeze({
      async planClawHubSkillUninstall(params) {
        assertCurrent();
        const result = await clawHubSkills.planClawHubSkillUninstall(params);
        assertCurrent();
        return result;
      },
      async applyClawHubSkillUninstall(plan, options) {
        assertCurrent();
        const result = await clawHubSkills.applyClawHubSkillUninstall(plan, {
          ...options,
          beforePersistentApply() {
            assertCurrent();
            options.beforePersistentApply?.();
          },
          beforeRollback() {
            assertCurrent();
            options.beforeRollback?.();
          },
        });
        assertCurrent();
        return result;
      },
      async resolveClawHubSkillVerificationTarget(params) {
        assertCurrent();
        const result = await clawHubSkills.resolveClawHubSkillVerificationTarget(params);
        assertCurrent();
        return result;
      },
      async readClawHubSkillsLockfile(params) {
        assertCurrent();
        const result = await clawHubSkills.readClawHubSkillsLockfile(params);
        assertCurrent();
        return result;
      },
      async resolveRequestedUpdateSlug(params) {
        assertCurrent();
        const result = await clawHubSkills.resolveRequestedUpdateSlug(params);
        assertCurrent();
        return result;
      },
      async resolveTrackedUpdateTarget(params) {
        assertCurrent();
        const result = await clawHubSkills.resolveTrackedUpdateTarget(params);
        assertCurrent();
        return result;
      },
      async guardTrackedSkillLocalState(params) {
        assertCurrent();
        const result = await clawHubSkills.guardTrackedSkillLocalState(params);
        assertCurrent();
        return result;
      },
      async preflightSkillOwnerState(params) {
        assertCurrent();
        const result = await clawHubSkills.preflightSkillOwnerState(params);
        assertCurrent();
        return result;
      },
      async assertClawHubSkillInstallState(params) {
        assertCurrent();
        await clawHubSkills.assertClawHubSkillInstallState(params);
        assertCurrent();
      },
      async readInstalledClawHubSkillFiles(params) {
        assertCurrent();
        const result = await clawHubSkills.readInstalledClawHubSkillFiles(params);
        assertCurrent();
        return result;
      },
      async recordClawHubSkillInstall(params) {
        assertCurrent();
        await clawHubSkills.recordClawHubSkillInstall(params);
        assertCurrent();
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

export function getAgentWorkspaceAccess(
  workspaceDir: string,
  capability?: keyof AgentWorkspaceAccess,
): AgentWorkspaceAccess | undefined {
  const key = path.resolve(workspaceDir);
  const binding = bindings.get(key);
  // Stopping an adapter must not disable capabilities it never owned.
  if (capability && binding?.access && !binding.access[capability]) {
    return undefined;
  }
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

/** Prepare execution-only paths while retaining canonical media and transcript facts. */
export async function prepareAgentWorkspaceAttachments(params: {
  workspaceDir: string;
  turn: WorkspaceAttachmentTurn & { userTurnTranscriptRecorder?: UserTurnTranscriptRecorder };
  assertCurrent: () => void;
}): Promise<string | undefined> {
  if (!params.turn.media?.length && !params.turn.userTurnTranscriptRecorder) {
    return undefined;
  }
  const access = getAgentWorkspaceAccess(params.workspaceDir, "prepareTurnAttachments");
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
