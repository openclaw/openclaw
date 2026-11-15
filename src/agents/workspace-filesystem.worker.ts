import { closeSync, lstatSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { openRootFile } from "../infra/boundary-file-read.js";
import { isHardlinkFallbackError } from "../infra/directory-durability.js";
import { hasErrnoCode } from "../infra/errno.js";
import { FsSafeError, root as fsRoot } from "../infra/fs-safe.js";
import { lstatIfExists } from "../infra/path-existence.js";
import { encodeNativeWorkerFailure } from "../infra/worker-native-error.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveUserPath } from "../utils.js";
import { assertSandboxStateOwnerPathCurrent } from "./sandbox/state-owner-path.js";
import {
  DEFAULT_BOOTSTRAP_FILENAME,
  GENERATED_WORKSPACE_BOOTSTRAP_FILENAMES,
} from "./workspace-bootstrap-policy.js";
import {
  MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES,
  readWorkspaceBootstrapFile,
} from "./workspace-bootstrap-read.js";
import { readLocalWorkspaceFileWithGuards } from "./workspace-file-read.js";
import type {
  WorkspaceFilesystemCommand,
  WorkspaceFilesystemReadCommand,
  WorkspaceFilesystemReadReply,
  WorkspaceFilesystemReply,
  WorkspaceLegacyResetOperation,
} from "./workspace-filesystem.types.js";
import {
  LEGACY_WORKSPACE_ATTESTATION_HEADER,
  LEGACY_WORKSPACE_ATTESTATION_MAX_BYTES,
} from "./workspace-legacy-state.js";
import { assertWorkspaceFilesystemEvidence } from "./workspace-state-guard.js";
import { WorkspaceAliasRepointedError } from "./workspace-state-identity.js";

const log = createSubsystemLogger("sandbox-workspace");

async function removeLegacyState(
  operation: WorkspaceLegacyResetOperation,
  grant: () => void,
): Promise<Extract<WorkspaceFilesystemReply, { type: "workspace-legacy-reset" }>> {
  const result: Extract<WorkspaceFilesystemReply, { type: "workspace-legacy-reset" }> = {
    type: "workspace-legacy-reset",
    removedPaths: [],
    warnings: [],
  };
  for (const candidate of operation.plan.candidates) {
    const { root: evidence, sourcePath } = candidate;
    try {
      lstatSync(evidence.workspaceDir);
      if ("error" in evidence) {
        result.warnings.push({ sourcePath, action: "inspect", error: evidence.error });
        continue;
      }
    } catch (error) {
      // The workspace or state root may already have been removed by reset.
      if (!hasErrnoCode(error, "ENOENT")) {
        result.warnings.push({ sourcePath, action: "inspect", error: String(error) });
      }
      continue;
    }
    let authorityRefused = false;
    try {
      const relativePath = path.relative(evidence.workspaceDir, sourcePath);
      const sourceRoot = await fsRoot(evidence.canonical, {
        hardlinks: "reject",
        maxBytes: LEGACY_WORKSPACE_ATTESTATION_MAX_BYTES,
        symlinks: "reject",
      });
      if (!(await sourceRoot.exists(relativePath))) {
        continue;
      }
      if (candidate.requireAttestationHeader) {
        const snapshot = await sourceRoot.read(relativePath);
        if (
          snapshot.buffer
            .subarray(0, LEGACY_WORKSPACE_ATTESTATION_HEADER.length + 1)
            .toString("utf8") !== `${LEGACY_WORKSPACE_ATTESTATION_HEADER}\n`
        ) {
          continue;
        }
      }
      if (operation.dryRun) {
        assertWorkspaceFilesystemEvidence(evidence);
      } else {
        await sourceRoot.remove(relativePath, {
          assertBeforeMutation: () => {
            assertWorkspaceFilesystemEvidence(evidence);
            try {
              grant();
            } catch (error) {
              authorityRefused = true;
              throw error;
            }
          },
        });
      }
      result.removedPaths.push(sourcePath);
    } catch (error) {
      result.warnings.push({
        sourcePath,
        action: "remove",
        error: String(error),
        authorityRefused,
      });
    }
  }
  return result;
}

export async function executeWorkspaceFilesystemOperation(
  command: WorkspaceFilesystemCommand,
  grant: () => void,
): Promise<WorkspaceFilesystemReply> {
  try {
    const { operation, filesystem } = command;
    if (operation.kind === "legacy-reset") {
      return await removeLegacyState(operation, grant);
    }
    const original = filesystem.find(
      (evidence) => evidence.workspaceDir === path.resolve(resolveUserPath(operation.dir)),
    );
    if (!original) {
      throw new Error("Workspace filesystem effect has no original target");
    }
    // Physical work can block; live logical custody is granted only afterward.
    const assertCurrent = () => {
      for (const evidence of filesystem) {
        assertWorkspaceFilesystemEvidence(evidence);
      }
      if (command.stateOwnerPath) {
        assertSandboxStateOwnerPathCurrent(command.stateOwnerPath);
      }
      grant();
    };
    const dir = original.canonical;
    let created = false;
    const publish = async (name: string, content: string | Uint8Array, seed = false) => {
      if (await lstatIfExists(path.join(dir, name), "ENOENT")) {
        assertCurrent();
        return false;
      }
      const root = await fsRoot(dir);
      // Structured clone transports Buffer as Uint8Array; fs-safe create accepts Buffer.
      const bytes = typeof content === "string" ? content : Buffer.from(content);
      try {
        if (seed) {
          await root.write(name, bytes, {
            overwrite: false,
            assertBeforeMutation: assertCurrent,
          });
        } else {
          await root.create(name, bytes, {
            atomic: true,
            durable: "file",
            mkdir: false,
            mode: 0o600,
            assertBeforeMutation: assertCurrent,
          });
        }
        return true;
      } catch (error) {
        if (error instanceof FsSafeError && error.code === "already-exists" && !error.details) {
          return false;
        }
        if (!seed && isHardlinkFallbackError(error instanceof FsSafeError ? error.cause : error)) {
          throw new Error(
            "Workspace filesystem does not support atomic bootstrap publication. Use a workspace on a filesystem with hard-link support.",
            { cause: error },
          );
        }
        throw error;
      }
    };
    switch (operation.kind) {
      case "mkdir":
        assertCurrent();
        await fs.mkdir(dir, { recursive: true });
        break;
      case "publish":
        created = await publish(operation.name, operation.content);
        break;
      case "seed":
      case "purpose": {
        created = await publish(operation.name, operation.content, operation.kind === "seed");
        if (!created) {
          const existing = await readLocalWorkspaceFileWithGuards({
            filePath: path.join(dir, operation.name),
            workspaceDir: dir,
          });
          assertCurrent();
          if (
            !existing.ok ||
            !Buffer.from(existing.content, "utf8").equals(Buffer.from(operation.content))
          ) {
            throw Object.assign(
              new Error(
                operation.kind === "purpose"
                  ? "Existing AGENTS.md was preserved. Choose a new workspace to seed the approved custom purpose."
                  : existing.ok
                    ? "Existing BOOTSTRAP.md differs from the consented Template bootstrap."
                    : "Existing BOOTSTRAP.md could not be read safely.",
              ),
              { code: "WORKSPACE_BOOTSTRAP_SEED_CONFLICT" },
            );
          }
        }
        break;
      }
      case "remove": {
        const root = await fsRoot(dir);
        await root.remove(operation.name, { force: true, assertBeforeMutation: assertCurrent });
        break;
      }
      case "copy": {
        assertCurrent();
        await fs.mkdir(dir, { recursive: true });
        for (const evidence of filesystem) {
          assertWorkspaceFilesystemEvidence(evidence);
        }
        if (operation.seed) {
          for (const name of [
            ...GENERATED_WORKSPACE_BOOTSTRAP_FILENAMES,
            DEFAULT_BOOTSTRAP_FILENAME,
          ]) {
            if (
              await fs.access(path.join(dir, name)).then(
                () => true,
                () => false,
              )
            ) {
              continue;
            }
            const opened = await openRootFile({
              absolutePath: path.join(operation.seed, name),
              rootPath: operation.seed,
              boundaryLabel: "sandbox seed workspace",
            });
            if (!opened.ok) {
              continue;
            }
            let content: string;
            try {
              content = await readWorkspaceBootstrapFile(opened.fd);
            } catch (error) {
              if (error instanceof RangeError) {
                log.warn(
                  `Ignoring oversized sandbox seed file ${path.join(operation.seed, name)}: file exceeds the ${MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES}-byte limit`,
                );
                continue;
              }
              throw error;
            } finally {
              closeSync(opened.fd);
            }
            await publish(name, content);
          }
        }
        break;
      }
      case "git-init": {
        const { getProcessSupervisor } = await import("../process/supervisor/index.js");
        let refusal: { error: unknown } | undefined;
        try {
          const run = await getProcessSupervisor().spawn({
            mode: "child",
            argv: ["git", "init"],
            cwd: dir,
            timeoutMs: 10_000,
            beforeSpawn: () => {
              try {
                assertCurrent();
              } catch (error) {
                refusal ??= { error };
                throw error;
              }
            },
          });
          try {
            await run.wait();
          } finally {
            await run.waitForExtinction?.();
          }
        } catch {
          // Git initialization is best effort; final launch authority remains mandatory.
        }
        if (refusal) {
          throw refusal.error;
        }
        break;
      }
    }
    for (const evidence of filesystem) {
      assertWorkspaceFilesystemEvidence(evidence);
    }
    return { type: "workspace", created, filesystem };
  } catch (error) {
    return {
      type: "workspace-failed",
      error: encodeNativeWorkerFailure(error),
      ...(error instanceof FsSafeError ? { fsCode: error.code, details: error.details } : {}),
      ...(error instanceof WorkspaceAliasRepointedError
        ? {
            alias: {
              aliasPath: error.aliasPath,
              storedWorkspacePath: error.storedWorkspacePath,
              currentWorkspacePath: error.currentWorkspacePath,
            },
          }
        : {}),
    };
  }
}

export async function executeWorkspaceFilesystemRead(
  command: WorkspaceFilesystemReadCommand,
): Promise<WorkspaceFilesystemReadReply> {
  const result = await readLocalWorkspaceFileWithGuards(command.input);
  if (result.ok) {
    return { type: "workspace-read", result };
  }
  return {
    type: "workspace-read",
    result: {
      ok: false,
      reason: result.reason,
      ...(result.error === undefined ? {} : { error: encodeNativeWorkerFailure(result.error) }),
      ...(result.error instanceof FsSafeError
        ? { fsCode: result.error.code, details: result.error.details }
        : {}),
    },
  };
}
