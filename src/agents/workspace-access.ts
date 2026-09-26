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
import type { LocalAttachmentExecutionContext } from "./workspace-attachments.local.js";

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
  /** Keep the subscription alive until aborted; available certifies verified coverage after loss. */
  watchSkills?: (
    request: Pick<WorkspaceSkillSourceRequest, "sourcePlan" | "executionWorkspaceDir">,
    onChange: (event: "change" | "unavailable" | "available") => void,
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
    | "readFile"
    | "readFileWithSource"
    | "readDirectory"
    | "writeFile"
    | "createFileExclusive"
    | "stat"
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
  const guardCall =
    <Args extends unknown[], Result>(
      call: (...args: Args) => Promise<Result>,
      assertActive = assertCurrent,
    ) =>
    async (...args: Args): Promise<Result> => {
      assertActive();
      const result = await call(...args);
      assertActive();
      return result;
    };
  const bridge: AgentWorkspaceAccess["bridge"] = {
    readFile: guardCall((params) => access.bridge.readFile(params)),
    writeFile: guardCall((params) => access.bridge.writeFile(params)),
    stat: guardCall((params) => access.bridge.stat(params)),
  };
  const createFileExclusive = access.bridge.createFileExclusive?.bind(access.bridge);
  if (createFileExclusive) {
    bridge.createFileExclusive = guardCall(createFileExclusive);
  }
  const readFileWithSource = access.bridge.readFileWithSource?.bind(access.bridge);
  if (readFileWithSource) {
    bridge.readFileWithSource = guardCall(readFileWithSource);
  }
  const readDirectory = access.bridge.readDirectory?.bind(access.bridge);
  if (readDirectory) {
    bridge.readDirectory = guardCall(readDirectory);
  }
  const boundAccess: AgentWorkspaceAccess = { bridge: Object.freeze(bridge) };
  const outboundMedia = access.outboundMedia;
  if (outboundMedia) {
    const readFile = outboundMedia.readFile.bind(outboundMedia);
    boundAccess.outboundMedia = Object.freeze({
      localRoots: Object.freeze([...outboundMedia.localRoots]),
      readFile: guardCall(readFile),
    });
  }
  const memoryFiles = access.memoryFiles;
  if (memoryFiles) {
    const assertMemoryCurrent = () => {
      assertCurrent();
      memoryFiles.assertCurrent();
    };
    const guardMemoryCall = <Args extends unknown[], Result>(
      call: (...args: Args) => Promise<Result>,
    ) => guardCall(call, assertMemoryCurrent);
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
      listFiles: guardMemoryCall((...params) => memoryFiles.listFiles(...params)),
      inspectFile: guardMemoryCall((...params) => memoryFiles.inspectFile(...params)),
      readFile: guardMemoryCall((params) => memoryFiles.readFile(params)),
      readForIndexing: guardMemoryCall((filePath) => memoryFiles.readForIndexing(filePath)),
      buildMultimodalChunk: guardMemoryCall((entry) => memoryFiles.buildMultimodalChunk(entry)),
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
    boundAccess.installSkillDependencies = guardCall(installSkillDependencies);
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
      resolveExplicitSkill: guardCall((selection) =>
        skillResources.resolveExplicitSkill(selection),
      ),
      readSkillFiles: guardCall((skill, options) => skillResources.readSkillFiles(skill, options)),
    });
  }
  const applySkillRoot = access.applySkillRoot?.bind(access);
  if (applySkillRoot) {
    boundAccess.applySkillRoot = guardCall((params) =>
      applySkillRoot({
        ...params,
        beforeInstall: async (mode) => {
          assertCurrent();
          const decision = await params.beforeInstall?.(mode);
          assertCurrent();
          return decision;
        },
      }),
    );
  }
  const recordSkillSourceInstall = access.recordSkillSourceInstall?.bind(access);
  if (recordSkillSourceInstall) {
    boundAccess.recordSkillSourceInstall = guardCall(recordSkillSourceInstall);
  }
  const clawHubSkills = access.clawHubSkills;
  if (clawHubSkills) {
    boundAccess.clawHubSkills = Object.freeze({
      planClawHubSkillUninstall: guardCall((params) =>
        clawHubSkills.planClawHubSkillUninstall(params),
      ),
      applyClawHubSkillUninstall: guardCall((plan, options) =>
        clawHubSkills.applyClawHubSkillUninstall(plan, {
          ...options,
          beforePersistentApply() {
            assertCurrent();
            options.beforePersistentApply?.();
          },
          beforeRollback() {
            assertCurrent();
            options.beforeRollback?.();
          },
        }),
      ),
      resolveClawHubSkillVerificationTarget: guardCall((params) =>
        clawHubSkills.resolveClawHubSkillVerificationTarget(params),
      ),
      readClawHubSkillsLockfile: guardCall((params) =>
        clawHubSkills.readClawHubSkillsLockfile(params),
      ),
      resolveRequestedUpdateSlug: guardCall((params) =>
        clawHubSkills.resolveRequestedUpdateSlug(params),
      ),
      resolveTrackedUpdateTarget: guardCall((params) =>
        clawHubSkills.resolveTrackedUpdateTarget(params),
      ),
      guardTrackedSkillLocalState: guardCall((params) =>
        clawHubSkills.guardTrackedSkillLocalState(params),
      ),
      preflightSkillOwnerState: guardCall((params) =>
        clawHubSkills.preflightSkillOwnerState(params),
      ),
      assertClawHubSkillInstallState: guardCall((params) =>
        clawHubSkills.assertClawHubSkillInstallState(params),
      ),
      readInstalledClawHubSkillFiles: guardCall((params) =>
        clawHubSkills.readInstalledClawHubSkillFiles(params),
      ),
      recordClawHubSkillInstall: guardCall((params) =>
        clawHubSkills.recordClawHubSkillInstall(params),
      ),
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
  /** Final attempt policy; omission retains the remote-adapter-only SDK contract. */
  localExecution?: LocalAttachmentExecutionContext;
}): Promise<string | undefined> {
  if (!params.turn.media?.length && !params.turn.userTurnTranscriptRecorder) {
    return undefined;
  }
  // Local preparation never substitutes for any registered remote workspace owner.
  if (params.localExecution && bindings.has(path.resolve(params.workspaceDir))) {
    return undefined;
  }
  const access = getAgentWorkspaceAccess(params.workspaceDir, "prepareTurnAttachments");
  if (!access?.prepareTurnAttachments && !params.localExecution) {
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
  let note: string | undefined;
  if (access?.prepareTurnAttachments) {
    note = await access.prepareTurnAttachments(
      {
        config: params.turn.config,
        media: facts,
        timeoutMs: params.turn.timeoutMs,
        abortSignal: params.turn.abortSignal,
      },
      assertCurrent,
    );
  } else if (params.localExecution) {
    const { prepareLocalWorkspaceAttachments } = await import("./workspace-attachments.local.js");
    assertCurrent();
    note = await prepareLocalWorkspaceAttachments({
      media: facts,
      execution: params.localExecution,
      assertCurrent,
    });
  }
  assertCurrent();
  return note;
}
