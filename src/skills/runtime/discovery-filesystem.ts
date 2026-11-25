import { getFsSafeNativeConfig } from "@openclaw/fs-safe/config";
import { FsSafeError } from "@openclaw/fs-safe/errors";
import type { resolveSandboxFsPathWithMounts } from "../../agents/sandbox/fs-paths.js";
import type { SandboxMountPlanInput } from "../../agents/sandbox/mount-plan.prepare.js";
import type { SandboxStateOwnerPath } from "../../agents/sandbox/state-owner-path.js";
import type { SandboxContext } from "../../agents/sandbox/types.js";
import { restoreNativeErrorResponse } from "../../infra/native-error-response.js";
import { createWorkerMutationAuthority } from "../../infra/worker-mutation-authority.js";
import { decodeNativeWorkerFailure } from "../../infra/worker-native-error.js";
import type { WorkerTaskPool } from "../../infra/worker-task-pool.js";
import type { SkillLibraryFilesystemInput } from "../library/filesystem.contract.js";
import type { Skill } from "../loading/skill-contract.js";
import type { SkillsSyncFilesystemOperation } from "../loading/workspace-skill-sync-files.js";
import { SkillLibraryError } from "../skill-library-error.js";
import type {
  SkillsDiscoveryInput,
  SkillsDiscoveryOutput,
  SkillsFilesystemMutation,
} from "./discovery-worker-contract.js";

export function createSkillsFilesystemOperations(
  getWorker: () => Promise<
    Pick<WorkerTaskPool<SkillsDiscoveryInput, SkillsDiscoveryOutput>, "run">
  >,
) {
  /** Catalogs carry snapshot admission; only the actual companion read dispatches work. */
  async function prepareSkillResourceRoot(
    directoryPath: string,
    identity: Skill["resourceRootIdentity"],
  ) {
    if (!identity) {
      throw new Error("Skill resource directory was not prepared by discovery");
    }
    if ("error" in identity) {
      throw new Error(identity.error);
    }
    return {
      async read(relativePath: string, maxBytes: number) {
        const nativeMode = getFsSafeNativeConfig().mode;
        const worker = await getWorker();
        const result = await worker.run(
          {
            kind: "companion",
            nativeMode,
            directoryPath,
            identity,
            relativePath,
            maxBytes,
          },
          { timeoutMs: 120_000 },
        );
        if (result.kind !== "companion") {
          throw new Error("Unexpected Skills companion response");
        }
        const bytes = result.buffer;
        return { buffer: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength) };
      },
    };
  }

  async function runFilesystemMutation(
    request: SkillsFilesystemMutation,
    assertCurrent?: () => void,
    stateOwnerPath?: SandboxStateOwnerPath,
    onPhase?: (phase: string) => void,
  ) {
    const nativeMode = getFsSafeNativeConfig().mode;
    const worker = await getWorker();
    const authority = assertCurrent ? createWorkerMutationAuthority(assertCurrent) : undefined;
    let result: SkillsDiscoveryOutput;
    try {
      result = await worker.run(
        { ...request, nativeMode, stateOwnerPath, authority: authority?.buffer },
        {
          timeoutMs: 120_000,
          onNotification: (notification) => {
            if (notification === "authority") {
              authority?.onNotification();
            } else if (typeof notification === "string") {
              onPhase?.(notification);
            }
          },
        },
      );
    } finally {
      authority?.dispose();
      // The original host refusal outranks a worker error or lost reply.
      authority?.throwIfRefused();
    }
    if (result.kind === "filesystem-mutation-error") {
      const error = decodeNativeWorkerFailure(result.error);
      throw result.code && error instanceof Error
        ? new FsSafeError(result.code, error.message, {
            cause: error.cause,
            details: result.details,
          })
        : error;
    }
    return result;
  }

  async function prepareSandboxMounts(
    input: SandboxMountPlanInput,
    assertCurrent?: () => void,
    stateOwnerPath?: SandboxStateOwnerPath,
  ) {
    const result = await runFilesystemMutation(
      { kind: "sandbox-mounts", input },
      assertCurrent,
      stateOwnerPath,
    );
    if (result.kind !== "sandbox-mounts") {
      throw new Error("Unexpected sandbox mount preparation response");
    }
    return result.plan;
  }

  async function prepareSandboxMountSources(
    input: SandboxMountPlanInput,
    assertCurrent?: () => void,
    stateOwnerPath?: SandboxStateOwnerPath,
  ) {
    const result = await runFilesystemMutation(
      { kind: "sandbox-mount-sources", input },
      assertCurrent,
      stateOwnerPath,
    );
    if (result.kind !== "sandbox-mount-sources") {
      throw new Error("Unexpected sandbox mount source preparation response");
    }
    return result.created;
  }

  async function runSkillLibraryFilesystemTask(
    input: SkillLibraryFilesystemInput,
    nativeMode = getFsSafeNativeConfig().mode,
  ) {
    const worker = await getWorker();
    const result = await worker.run({ kind: "library", input, nativeMode }, { timeoutMs: 120_000 });
    if (result.kind !== "library") {
      throw new Error("Unexpected skill library filesystem response");
    }
    if (result.result.kind === "error") {
      const { error, libraryCode } = result.result;
      if (libraryCode) {
        throw new SkillLibraryError(libraryCode, error.message, undefined, {
          cause: restoreNativeErrorResponse(error).cause,
        });
      }
      throw restoreNativeErrorResponse(error);
    }
    return result.result;
  }

  async function syncSkillsFilesystem(
    operation: SkillsSyncFilesystemOperation,
    assertCurrent: (() => void) | undefined,
    onPhase: (phase: string) => void,
    stateOwnerPath?: SandboxStateOwnerPath,
  ) {
    const result = await runFilesystemMutation(
      { kind: "sync-filesystem", operation },
      assertCurrent,
      stateOwnerPath,
      onPhase,
    );
    if (result.kind !== "sync-filesystem") {
      throw new Error("Unexpected Skills filesystem response");
    }
    return result.prepared;
  }

  async function prepareSandboxFsPath(input: Parameters<typeof resolveSandboxFsPathWithMounts>[0]) {
    const nativeMode = getFsSafeNativeConfig().mode;
    const worker = await getWorker();
    const result = await worker.run(
      { kind: "sandbox-path", nativeMode, input },
      { timeoutMs: 120_000 },
    );
    if (result.kind !== "sandbox-path") {
      throw new Error("Unexpected sandbox filesystem path response");
    }
    return result.path;
  }

  async function prepareSandboxFsContext(sandbox: SandboxContext) {
    const nativeMode = getFsSafeNativeConfig().mode;
    const worker = await getWorker();
    const {
      workspaceDir,
      agentWorkspaceDir,
      skillsWorkspaceDir,
      readOnlyResourceMounts,
      workspaceAccess,
      containerName,
      containerWorkdir,
      docker,
    } = sandbox;
    const result = await worker.run(
      {
        kind: "sandbox-projection",
        nativeMode,
        input: {
          sandbox: {
            workspaceDir,
            agentWorkspaceDir,
            skillsWorkspaceDir,
            readOnlyResourceMounts,
            workspaceAccess,
            containerName,
            containerWorkdir,
            docker: { binds: docker.binds, tmpfs: docker.tmpfs },
          },
          skillUsagePaths: sandbox.backend?.capabilities?.readOnlyResourceMounts
            ? (sandbox.skillUsagePaths ?? [])
            : [],
        },
      },
      { timeoutMs: 120_000 },
    );
    if (result.kind !== "sandbox-projection") {
      throw new Error("Unexpected sandbox filesystem projection response");
    }
    return result.preparation;
  }

  return {
    prepareSkillResourceRoot,
    prepareSandboxMounts,
    prepareSandboxMountSources,
    runSkillLibraryFilesystemTask,
    syncSkillsFilesystem,
    prepareSandboxFsContext,
    prepareSandboxFsPath,
  };
}
