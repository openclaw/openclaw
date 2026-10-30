import { resolve as resolvePath } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  ErrorCodes,
  errorShape,
  isCloudWorkerPlacementState,
  type SessionsFilesGetParams,
  type SessionsFilesListParams,
  type SessionsFilesAssetsParams,
  type SessionsFilesPreviewParams,
  validateSessionsFilesPreviewParams,
  validateSessionsFilesPreviewReleaseParams,
  CANVAS_DOCUMENT_PREVIEW_MAX_BYTES,
  validateSessionsFilesAssetsParams,
  validateSessionsFilesRevealParams,
  validateSessionsFilesGetParams,
  validateSessionsFilesDownloadParams,
  validateSessionsFilesListParams,
  validateSessionsFilesSetParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { loadAgentIdentityFromWorkspaceAsync } from "../../agents/identity-file.js";
import { getAgentWorkspaceAccess } from "../../agents/workspace-access.js";
import { DEFAULT_IDENTITY_FILENAME } from "../../agents/workspace-bootstrap-policy.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  releaseSessionFilePreviewGrant,
  sessionFilePreviewBinding,
} from "../artifact-download-grants.js";
import { SessionMutationAuthorizationChangedError } from "../session-mutation-authorization-error.js";
import { resolveRequestedSessionAgentId } from "../session-request-agent.js";
import { hasSessionReadAccessChanged } from "../session-sharing-policy.js";
import { readSessionWorkerPlacementAsync } from "../worker-environments/session-placement-lifecycle.js";
import { WORKSPACE_PREVIEW_MAX_BYTES } from "../workspace-file-limits.js";
import {
  execOpenPath,
  formatOpenPathError,
  isHeadlessOpenPathError,
  resolveOpenPathCommand,
  sanitizePathForLog,
} from "./open-path.js";
import {
  createSessionFileReadAuthority,
  sessionFileWorkspaceMatches,
} from "./session-file-read-authority.js";
import {
  rejectDeviceFolderFiles,
  respondSessionFileNotFound,
  respondSessionFileTooLarge,
  sessionFilesError,
} from "./session-files-errors.js";
import { loadSessionFiles, withSessionFileRoot } from "./session-files-root.js";
import { readGatewayRequestMutationAuthority } from "./session-mutation-guards.js";
import {
  getRepositoryArtifact,
  listRepositoryArtifacts,
  resolveRepositoryArtifactPath,
} from "./session-repository-artifacts.js";
import { resolveRepositoryWorkspaceAccess } from "./session-repository-workspace-access.js";
import { retainSessionScopedRead } from "./session-scoped-read.js";
import { getSessionWorkspaceAssets } from "./sessions-file-assets.js";
import { respondSessionFileDownload } from "./sessions-file-download.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers, RespondFn } from "./types.js";
import { assertValidParams, defineValidatedGatewayHandler } from "./validation.js";
import {
  getSessionWorkspaceFile,
  listSessionWorkspaceFiles,
  setSessionWorkspaceFile,
} from "./workspace-files.js";

function requireSessionFilesAgentId(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId?: string;
  respond: RespondFn;
}): string | undefined {
  const requestedAgent = resolveRequestedSessionAgentId(
    params.cfg,
    params.sessionKey,
    params.agentId,
  );
  if (!requestedAgent.ok) {
    params.respond(false, undefined, requestedAgent.error);
    return undefined;
  }
  return requestedAgent.agentId;
}

async function handleSessionFilesRead(
  options: GatewayRequestHandlerOptions,
  request:
    | { kind: "list"; params: SessionsFilesListParams }
    | { kind: "get"; params: SessionsFilesGetParams }
    | { kind: "download"; params: SessionsFilesGetParams }
    | { kind: "assets"; params: SessionsFilesAssetsParams }
    | { kind: "preview"; params: SessionsFilesPreviewParams },
): Promise<void> {
  const { respond, context } = options;
  const { params } = request;
  const agentId = requireSessionFilesAgentId({
    cfg: context.getRuntimeConfig(),
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    respond,
  });
  if (!agentId) {
    return;
  }
  const retainedTransport = request.kind === "download" || request.kind === "preview";
  const read = await retainSessionScopedRead(options, params.sessionKey, agentId, {
    requireMaterialized: true,
    retain: retainedTransport,
    projection: ["skillsSnapshot"],
    entryMatches: (previous, current) =>
      !hasSessionReadAccessChanged(previous, current) &&
      sessionFileWorkspaceMatches(previous, current),
  });
  let transportOwnsRead = false;
  let readAuthority: ReturnType<typeof createSessionFileReadAuthority> | undefined;
  return withSessionFileRoot(
    { ...params, agentId, getRuntimeConfig: context.getRuntimeConfig },
    context.getRuntimeConfig(),
    async (source, assertSourceCurrent, readEntry) => {
      if (rejectDeviceFolderFiles(source.entry, respond)) {
        return;
      }
      // HTTP delivery borrows the download grant's retained row, not this shorter callback.
      const hostRead = createSessionFileReadAuthority(options, {
        ...source,
        agentId,
        readEntry: read?.prepared.readRetainedEntry ?? readEntry,
        assertSourceCurrent: read?.assertCurrent ?? assertSourceCurrent,
      });
      readAuthority = hostRead;
      const authority = readGatewayRequestMutationAuthority(options);
      // Namespace inspection must retain the reader without capturing its own returned guard.
      const assertReaderCurrent = () => {
        authority.assertCurrent();
        read?.assertCurrent();
        hostRead.assertCurrent();
      };
      let assertReadCurrent: (() => void) | undefined;
      const assertCurrent = () => {
        assertSourceCurrent();
        read?.assertCurrent();
        hostRead.assertCurrent();
        assertReadCurrent?.();
      };
      let retainedRepository: Awaited<ReturnType<typeof resolveRepositoryWorkspaceAccess>>;
      try {
        assertCurrent();
        // A download grant outlives this request's planning-row borrow, including
        // memory-backed repositories. Its retained read owns all later assertions.
        const loaded = await loadSessionFiles(
          source,
          context,
          retainedTransport ? () => read?.assertCurrent() : assertSourceCurrent,
          assertReaderCurrent,
          request.kind === "list" ? undefined : request.params.path,
        );
        assertReadCurrent = loaded.readPath?.assertCurrent;
        const repository = loaded.repository;
        retainedRepository = repository;
        assertCurrent();
        if (request.kind !== "list" && loaded.readPath?.path === null) {
          respondSessionFileNotFound(respond, request.params.path, "outside_session_boundary");
          return;
        }
        if (
          request.kind !== "list" &&
          repository?.kind === "stored" &&
          resolveRepositoryArtifactPath(request.params.path) === undefined
        ) {
          respondSessionFileNotFound(respond, request.params.path, "outside_session_boundary");
          return;
        }
        if (request.kind === "download") {
          await respondSessionFileDownload({
            options,
            path: loaded.readPath?.path ?? request.params.path,
            loaded,
            repository,
            hostRead,
            assertSessionCurrent: () => {
              read?.assertCurrent();
              assertReadCurrent?.();
            },
            release: () => {
              repository?.[Symbol.dispose]();
              hostRead.release();
              read?.release();
            },
            onGrantCreated: () => {
              transportOwnsRead = true;
            },
          });
          return;
        }
        if (request.kind === "preview") {
          const { respondSessionFilePreview } = await import("./sessions-file-preview.js");
          const assertPreviewCurrent = () => {
            authority.assertCurrent();
            read?.assertCurrent();
            assertReadCurrent?.();
            repository?.assertCurrent();
            hostRead.assertCurrent();
          };
          const path = loaded.readPath?.path ?? request.params.path;
          await respondSessionFilePreview({
            options,
            params: request.params,
            assertCurrent: assertPreviewCurrent,
            readAssets: async (refs) => {
              assertPreviewCurrent();
              const assets = await getSessionWorkspaceAssets({
                ...loaded,
                path,
                refs,
                authorizeHostRead: hostRead.authorizeHostRead,
                assertCurrent: assertPreviewCurrent,
                ...(repository
                  ? {
                      repositoryFile: async (assetPath: string) => {
                        const result =
                          repository.kind === "stored"
                            ? await getRepositoryArtifact(repository, assetPath)
                            : await repository.inspect("get", {
                                path: assetPath,
                                files: loaded.files,
                              });
                        assertPreviewCurrent();
                        return result.file;
                      },
                    }
                  : {}),
              });
              assertPreviewCurrent();
              return hostRead.hasHostRead() ? hostRead.withCurrent(() => assets) : assets;
            },
            release: () => {
              repository?.[Symbol.dispose]();
              hostRead.release();
              read?.release();
            },
            onGrantCreated: () => {
              transportOwnsRead = true;
            },
          });
          return;
        }
        let result:
          | Awaited<ReturnType<typeof listSessionWorkspaceFiles>>
          | Awaited<ReturnType<typeof getSessionWorkspaceFile>>
          | Awaited<ReturnType<typeof getSessionWorkspaceAssets>>;
        let failure: (() => void) | undefined;
        if (request.kind === "list") {
          const query = {
            files: loaded.files,
            path: request.params.path,
            search: request.params.search,
          };
          result =
            repository?.kind === "stored"
              ? await listRepositoryArtifacts(repository, query)
              : repository
                ? await repository.inspect("list", query)
                : await listSessionWorkspaceFiles({
                    ...loaded,
                    ...query,
                    assertCurrent,
                    authorizeHostRead: hostRead.authorizeHostRead,
                  });
          assertCurrent();
        } else if (request.kind === "assets") {
          result = await getSessionWorkspaceAssets({
            ...loaded,
            path: loaded.readPath?.path ?? request.params.path,
            refs: request.params.refs,
            authorizeHostRead: hostRead.authorizeHostRead,
            assertCurrent,
            ...(repository
              ? {
                  repositoryFile: async (path: string) => {
                    const repositoryResult =
                      repository.kind === "stored"
                        ? await getRepositoryArtifact(repository, path)
                        : await repository.inspect("get", { path, files: loaded.files });
                    return repositoryResult.file;
                  },
                }
              : {}),
          });
          assertCurrent();
        } else {
          const query = { files: loaded.files, path: loaded.readPath?.path ?? request.params.path };
          const fileResult =
            repository?.kind === "stored"
              ? await getRepositoryArtifact(repository, request.params.path)
              : repository
                ? await repository.inspect("get", query)
                : await getSessionWorkspaceFile({
                    ...loaded,
                    ...query,
                    assertCurrent,
                    authorizeHostRead: hostRead.authorizeHostRead,
                  });
          assertCurrent();
          const { file } = fileResult;
          if (file && source.fileWorkspace?.historical) {
            delete file.hash;
          }
          if (!file || file.missing) {
            failure = () =>
              respondSessionFileNotFound(
                respond,
                request.params.path,
                "reason" in fileResult && fileResult.reason === "outside_session_boundary"
                  ? "outside_session_boundary"
                  : undefined,
              );
          } else if (typeof file.content !== "string" && file.previewKind !== "unsupported") {
            failure = () =>
              respondSessionFileTooLarge(respond, file, request.params.path, {
                root: repository ? undefined : loaded.root,
                source: source.source,
              });
          }
          result = fileResult;
        }
        const publish = () => {
          assertSourceCurrent();
          if (failure) {
            failure();
          } else {
            respond(
              true,
              request.kind === "assets"
                ? result
                : {
                    sessionKey: params.sessionKey,
                    ...result,
                    ...(request.kind === "get" && source.source ? { source: source.source } : {}),
                    ...(repository ? { root: undefined } : {}),
                  },
            );
          }
        };
        if (hostRead.hasHostRead()) {
          await hostRead.withCurrent(publish);
        } else {
          publish();
        }
      } finally {
        if (!transportOwnsRead) {
          retainedRepository?.[Symbol.dispose]();
          hostRead.release();
        }
      }
    },
  )
    .finally(() => {
      if (!transportOwnsRead) {
        read?.release();
      }
    })
    .catch((error: unknown) => {
      if (!(error instanceof SessionMutationAuthorizationChangedError)) {
        throw error;
      }
      if (!readAuthority?.hasHostRead()) {
        respond(false, undefined, error.error);
        return;
      }
      respondSessionFileNotFound(
        respond,
        "path" in params ? (params.path ?? "") : "",
        "outside_session_boundary",
      );
    });
}

export const sessionsFilesHandlers: GatewayRequestHandlers = {
  "sessions.files.download": defineValidatedGatewayHandler(
    "sessions.files.download",
    validateSessionsFilesDownloadParams,
    (options) => handleSessionFilesRead(options, { kind: "download", params: options.params }),
  ),
  "sessions.files.preview": defineValidatedGatewayHandler(
    "sessions.files.preview",
    validateSessionsFilesPreviewParams,
    async (options) => {
      if (Buffer.byteLength(options.params.html, "utf8") > CANVAS_DOCUMENT_PREVIEW_MAX_BYTES) {
        options.respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "HTML preview exceeds 2 MiB of UTF-8 data"),
        );
        return;
      }
      await handleSessionFilesRead(options, { kind: "preview", params: options.params });
    },
  ),
  "sessions.files.preview.release": defineValidatedGatewayHandler(
    "sessions.files.preview.release",
    validateSessionsFilesPreviewReleaseParams,
    ({ client, params, respond }) => {
      const released = releaseSessionFilePreviewGrant(
        client,
        params.previewId,
        sessionFilePreviewBinding(params),
      );
      respond(true, { released });
    },
  ),
  "sessions.files.assets": defineValidatedGatewayHandler(
    "sessions.files.assets",
    validateSessionsFilesAssetsParams,
    (options) => handleSessionFilesRead(options, { kind: "assets", params: options.params }),
  ),
  "sessions.files.list": defineValidatedGatewayHandler(
    "sessions.files.list",
    validateSessionsFilesListParams,
    (options) => handleSessionFilesRead(options, { kind: "list", params: options.params }),
  ),
  "sessions.files.get": defineValidatedGatewayHandler(
    "sessions.files.get",
    validateSessionsFilesGetParams,
    (options) => handleSessionFilesRead(options, { kind: "get", params: options.params }),
  ),
  "sessions.files.set": async ({ params, respond, context, sessionMutationAuthorization }) => {
    if (!assertValidParams(params, validateSessionsFilesSetParams, "sessions.files.set", respond)) {
      return;
    }
    const cfg = context.getRuntimeConfig();
    const agentId = requireSessionFilesAgentId({
      cfg,
      sessionKey: params.sessionKey,
      agentId: params.agentId,
      respond,
    });
    if (!agentId) {
      return;
    }
    return withSessionFileRoot(
      { ...params, agentId, getRuntimeConfig: context.getRuntimeConfig },
      context.getRuntimeConfig(),
      async (loaded, assertSourceCurrent) => {
        if (rejectDeviceFolderFiles(loaded.entry, respond)) {
          return;
        }
        if (!loaded.agentId || !loaded.entry?.sessionId) {
          respondSessionFileNotFound(respond, params.path);
          return;
        }
        const source = loaded.source;
        const authorize = () => {
          assertSourceCurrent();
          sessionMutationAuthorization?.assertCurrent();
          if (
            (params.expectedSource !== undefined ||
              (source !== undefined &&
                loaded.entry?.priorWorkspace?.worktreeId === source.workspaceId)) &&
            !isDeepStrictEqual(params.expectedSource, source)
          ) {
            throw new SessionMutationAuthorizationChangedError(
              sessionFilesError(
                "session_file_source_changed",
                "The file's workspace changed. Reopen the file before saving; your draft was preserved.",
                { path: params.path },
              ),
            );
          }
        };
        authorize();
        using repository = await resolveRepositoryWorkspaceAccess(loaded, context, authorize);
        if (repository?.kind === "stored") {
          throw new Error("Start this cloud session before editing its repository files.");
        }
        const update = repository
          ? await repository.inspect(
              "set",
              { path: params.path, content: params.content, expectedHash: params.expectedHash },
              authorize,
            )
          : await setSessionWorkspaceFile({
              ...params,
              root: loaded.root,
              fileRoot: loaded.fileRoot,
              assertCurrent: authorize,
            });
        assertSourceCurrent();
        if (update.status === "missing") {
          respondSessionFileNotFound(respond, params.path);
          return;
        }
        if (update.status !== "updated") {
          const errors = {
            "too-large": ["session_file_too_large", "session file content is too large"],
            conflict: ["session_file_conflict", "session file changed since it was read"],
            unsafe: ["session_file_unsafe", "session file could not be written safely"],
          } as const;
          const [type, message] = errors[update.status];
          respond(
            false,
            undefined,
            sessionFilesError(type, message, {
              path: params.path,
              ...(update.status === "too-large"
                ? { maxPreviewBytes: WORKSPACE_PREVIEW_MAX_BYTES, size: update.size }
                : update.status === "conflict"
                  ? { currentHash: update.currentHash }
                  : {}),
            }),
          );
          return;
        }
        const workspaceDir = repository ? undefined : resolveAgentWorkspaceDir(loaded.cfg, agentId);
        if (
          workspaceDir &&
          update.file.workspacePath &&
          resolvePath(update.root, update.file.workspacePath) ===
            resolvePath(workspaceDir, DEFAULT_IDENTITY_FILENAME)
        ) {
          // A pre-write worker reply must settle before the event admits a new identity read.
          await loadAgentIdentityFromWorkspaceAsync(workspaceDir);
          authorize();
          context.broadcast("agent.identity.changed", { agentId });
        }
        respond(true, {
          sessionKey: params.sessionKey,
          ...(source ? { source } : {}),
          ...(repository ? {} : { root: update.root }),
          file: update.file,
        });
      },
    );
  },
  "sessions.files.reveal": defineValidatedGatewayHandler(
    "sessions.files.reveal",
    validateSessionsFilesRevealParams,
    async ({ params, respond, context }) => {
      const agentId = requireSessionFilesAgentId({
        cfg: context.getRuntimeConfig(),
        sessionKey: params.key,
        agentId: params.agentId,
        respond,
      });
      if (!agentId) {
        return;
      }
      return withSessionFileRoot(
        { sessionKey: params.key, agentId, getRuntimeConfig: context.getRuntimeConfig },
        context.getRuntimeConfig(),
        async (loaded, assertCurrent) => {
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
          const command = resolveOpenPathCommand(workspaceRoot);
          try {
            assertCurrent();
            await execOpenPath(command);
            assertCurrent();
            respond(true, { ok: true, path: workspaceRoot });
          } catch (error) {
            const errorMessage = formatOpenPathError(error);
            const detailedError = isHeadlessOpenPathError(error, command)
              ? `Cannot open path in headless environment. Path: ${workspaceRoot}. This environment appears to lack a graphical or terminal browser handler.`
              : `Failed to reveal session workspace: ${errorMessage}`;
            context.logGateway.warn(
              `sessions.files.reveal failed path=${sanitizePathForLog(workspaceRoot)}: ${errorMessage}`,
            );
            respond(true, { ok: false, path: workspaceRoot, error: detailedError });
          }
        },
      );
    },
  ),
};
