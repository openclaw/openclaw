import {
  isCloudWorkerPlacementState,
  type SessionsFilesRevealParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { getAgentWorkspaceAccess } from "../../agents/workspace-access.js";
import { SessionMutationAuthorizationChangedError } from "../session-mutation-authorization-error.js";
import type { WorkerSessionPlacementStore } from "../worker-environments/placement-store.js";
import { readSessionWorkerPlacementAsync } from "../worker-environments/session-placement-lifecycle.js";
import {
  execOpenPath,
  formatOpenPathError,
  isHeadlessOpenPathError,
  resolveOpenPathCommand,
  sanitizePathForLog,
} from "./open-path.js";
import { createSessionFileReadAuthority } from "./session-file-read-authority.js";
import { prepareSessionFileReadPath, resolveSessionFileReadTarget } from "./session-file-read.js";
import { rejectDeviceFolderFiles, respondSessionFileNotFound } from "./session-files-errors.js";
import { withSessionFileRoot } from "./session-files-root.js";
import { readGatewayRequestMutationAuthority } from "./session-mutation-guards.js";
import type { GatewayRequestHandlerOptions } from "./types.js";
import { statWorkspacePath } from "./workspace-fs.js";

/** Open the current selected local file, or preserve the legacy workspace-folder action. */
export async function revealSessionFile(
  options: Omit<GatewayRequestHandlerOptions, "params"> & { params: SessionsFilesRevealParams },
  agentId: string,
) {
  const { params, respond, context } = options;
  return withSessionFileRoot(
    {
      sessionKey: params.key,
      agentId,
      messageEntryId: params.path ? params.messageEntryId : undefined,
      getRuntimeConfig: context.getRuntimeConfig,
    },
    context.getRuntimeConfig(),
    async (loaded, assertCurrent, readEntry) => {
      if (rejectDeviceFolderFiles(loaded.entry, respond)) {
        return;
      }
      if (loaded.entry?.repositoryWorkspaceId) {
        respond(true, {
          ok: false,
          error:
            "This repository exists only on the cloud session runner. Use the Files panel to browse it; there is no Gateway checkout to reveal.",
        });
        return;
      }
      const workspaceRoot = loaded.root;
      if (!workspaceRoot) {
        respond(true, {
          ok: false,
          error: "No workspace root is available for this session.",
        });
        return;
      }
      if (params.path && params.expectedRoot && workspaceRoot !== params.expectedRoot) {
        respond(true, {
          ok: false,
          error: "The workspace changed. Reopen this file before opening it on the Gateway host.",
        });
        return;
      }
      if (loaded.entry?.execNode || getAgentWorkspaceAccess(workspaceRoot)) {
        respond(true, {
          ok: false,
          path: workspaceRoot,
          error: loaded.entry?.execNode
            ? "Cannot reveal this workspace because the session runs on an exec node."
            : "Cannot reveal this workspace because its files live on a remote host.",
        });
        return;
      }
      const placement = await readSessionWorkerPlacementAsync({
        context,
        sessionId: loaded.entry?.sessionId,
      });
      if (isCloudWorkerPlacementState(placement?.state)) {
        respond(true, {
          ok: false,
          path: workspaceRoot,
          error: `Cannot reveal this workspace because the session runs remotely (${placement.state}).`,
        });
        return;
      }
      let targetPath = workspaceRoot;
      const fileAuthority = params.path
        ? createSessionFileReadAuthority(options, {
            ...loaded,
            agentId,
            readEntry,
            assertSourceCurrent: assertCurrent,
          })
        : undefined;
      const requestAuthority = readGatewayRequestMutationAuthority(options);
      const current = () => {
        assertCurrent();
        requestAuthority.assertCurrent();
        fileAuthority?.assertCurrent();
      };
      let localPlacement:
        | Awaited<ReturnType<WorkerSessionPlacementStore["prepareRuntimeRefresh"]>>
        | undefined;
      let assertReadCurrent: (() => void) | undefined;
      try {
        if (params.path && fileAuthority) {
          current();
          localPlacement = loaded.entry?.sessionId
            ? await context.workerSessionPlacementService?.prepareRuntimeRefresh?.(
                loaded.entry.sessionId,
              )
            : undefined;
          current();
          if (
            localPlacement &&
            (localPlacement.move ||
              localPlacement.pendingResult ||
              (localPlacement.placement &&
                localPlacement.placement.state !== "local" &&
                localPlacement.placement.state !== "reclaimed"))
          ) {
            respond(true, { ok: false, error: "This file is not on the Gateway host." });
            return;
          }
          const preparedPath = await prepareSessionFileReadPath({
            ...loaded,
            filePath: params.path,
            sandboxWorkspace: loaded.fileWorkspace?.sandboxWorkspace,
            historical: loaded.fileWorkspace?.historical,
            worktreeId: loaded.entry?.worktree?.id,
            assertCurrent: current,
            assertReadCurrent: current,
          });
          assertReadCurrent = preparedPath.assertCurrent;
          const target =
            preparedPath.path === null
              ? "outside_session_boundary"
              : await resolveSessionFileReadTarget(
                  {
                    ...loaded,
                    authorizeHostRead: fileAuthority.authorizeHostRead,
                  },
                  preparedPath.path ?? params.path,
                );
          current();
          if (
            !target ||
            target === "outside_session_boundary" ||
            !(await statWorkspacePath(target.root, target.path, current))?.isFile
          ) {
            respondSessionFileNotFound(
              respond,
              params.path,
              target === "outside_session_boundary" ? target : undefined,
            );
            return;
          }
          targetPath = target.absolutePath;
        }
        const command = resolveOpenPathCommand(targetPath);
        let opening: ReturnType<typeof execOpenPath> | undefined;
        const open = () => {
          current();
          assertReadCurrent?.();
          localPlacement?.assertCurrent();
          // Spawn while the authority owner's synchronous consumer is current.
          opening = execOpenPath(command);
          // Observe a rejection while the authority wrapper settles; await it below.
          void opening.catch(() => {});
        };
        if (fileAuthority?.hasHostRead()) {
          await fileAuthority.withCurrent(open);
        } else {
          open();
        }
        await opening;
        respond(true, { ok: true, path: targetPath });
      } catch (error) {
        if (error instanceof SessionMutationAuthorizationChangedError) {
          respond(false, undefined, error.error);
          return;
        }
        const errorMessage = formatOpenPathError(error);
        const command = resolveOpenPathCommand(targetPath);
        const detailedError = isHeadlessOpenPathError(error, command)
          ? `Cannot open path in headless environment. Path: ${targetPath}. This environment appears to lack a graphical or terminal browser handler.`
          : `Failed to open session path: ${errorMessage}`;
        context.logGateway.warn(
          `sessions.files.reveal failed path=${sanitizePathForLog(targetPath)}: ${errorMessage}`,
        );
        respond(true, { ok: false, path: targetPath, error: detailedError });
      } finally {
        fileAuthority?.release();
        localPlacement?.release();
      }
    },
  );
}
