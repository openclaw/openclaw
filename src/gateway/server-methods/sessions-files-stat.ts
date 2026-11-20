import type {
  SessionsFilesStatParams,
  SessionsFilesStatResult,
} from "../../../packages/gateway-protocol/src/index.js";
import { SessionMutationAuthorizationChangedError } from "../session-mutation-authorization-error.js";
import { hasSessionReadAccessChanged } from "../session-sharing-policy.js";
import {
  createSessionFileReadAuthority,
  sessionFileWorkspaceMatches,
} from "./session-file-read-authority.js";
import { prepareSessionFileReadPath } from "./session-file-read.js";
import { rejectDeviceFolderFiles } from "./session-files-errors.js";
import {
  loadSessionFiles,
  requireSessionFilesAgentId,
  withSessionFileRoot,
} from "./session-files-root.js";
import { readGatewayRequestMutationAuthority } from "./session-mutation-guards.js";
import { retainSessionScopedRead } from "./session-scoped-read.js";
import type { GatewayRequestHandlerOptions } from "./types.js";
import { getSessionWorkspaceFile, listSessionWorkspaceFiles } from "./workspace-files.js";

type SessionFileStatStatus = SessionsFilesStatResult["files"][number]["status"];

/**
 * Answers whether `sessions.files.get` would open each path, using the same session root,
 * sandbox mapping, and host-read authority, but stopping at a metadata stat.
 */
export async function handleSessionFilesStat(
  options: GatewayRequestHandlerOptions & { params: SessionsFilesStatParams },
): Promise<void> {
  const { respond, context, params } = options;
  const agentId = requireSessionFilesAgentId({
    cfg: context.getRuntimeConfig(),
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    respond,
  });
  if (!agentId) {
    return;
  }
  const read = await retainSessionScopedRead(options, params.sessionKey, agentId, {
    requireMaterialized: true,
    projection: ["skillsSnapshot"],
    entryMatches: (previous, current) =>
      !hasSessionReadAccessChanged(previous, current) &&
      sessionFileWorkspaceMatches(previous, current),
  });
  const paths = [...new Set(params.paths)];
  try {
    await withSessionFileRoot(
      {
        sessionKey: params.sessionKey,
        agentId,
        messageEntryId: params.messageEntryId,
        getRuntimeConfig: context.getRuntimeConfig,
        projection: "list",
        retained: read?.prepared,
      },
      context.getRuntimeConfig(),
      async (source, assertSourceCurrent, readEntry) => {
        if (rejectDeviceFolderFiles(source.entry, respond)) {
          return;
        }
        const hostRead = createSessionFileReadAuthority(options, {
          ...source,
          agentId,
          readEntry: read?.prepared.readRetainedEntry ?? readEntry,
          assertSourceCurrent: read?.assertCurrent ?? assertSourceCurrent,
        });
        const authority = readGatewayRequestMutationAuthority(options);
        const assertReaderCurrent = () => {
          authority.assertCurrent();
          read?.assertCurrent();
          hostRead.assertCurrent();
        };
        const assertCurrent = () => {
          assertSourceCurrent();
          assertReaderCurrent();
        };
        let repository: Awaited<ReturnType<typeof loadSessionFiles>>["repository"];
        try {
          assertCurrent();
          const loaded = await loadSessionFiles(
            source,
            context,
            assertSourceCurrent,
            assertReaderCurrent,
          );
          repository = loaded.repository;
          assertCurrent();
          const statPath = async (path: string): Promise<SessionFileStatStatus> => {
            // Repository files live with the session runner; only a full read can answer.
            if (repository) {
              return "unknown";
            }
            const prepared = await prepareSessionFileReadPath({
              root: source.root,
              fileRoot: source.fileRoot,
              filePath: path,
              sandboxWorkspace: source.fileWorkspace?.sandboxWorkspace,
              historical: source.fileWorkspace?.historical,
              worktreeId: source.entry?.worktree?.id,
              assertCurrent: assertSourceCurrent,
              assertReadCurrent: assertReaderCurrent,
            });
            if (prepared.path === null) {
              return "missing";
            }
            const { file } = await getSessionWorkspaceFile({
              ...loaded,
              readRoot: prepared.readRoot ?? loaded.readRoot,
              path: prepared.path ?? path,
              includeContent: false,
              assertCurrent: () => {
                assertCurrent();
                prepared.assertCurrent?.();
              },
              authorizeHostRead: hostRead.authorizeHostRead,
            });
            if (file && !file.missing) {
              return "file";
            }
            if (!loaded.root || !/^[^\\/]+$/u.test(path)) {
              return "missing";
            }
            // Mirrors the Control UI's bare-name reader fallback: one complete, unique match opens.
            const { browser } = await listSessionWorkspaceFiles({
              ...loaded,
              path: "",
              search: path,
              assertCurrent,
              authorizeHostRead: hostRead.authorizeHostRead,
            });
            const matches =
              browser && !browser.truncated
                ? browser.entries.filter((entry) => entry.kind === "file" && entry.name === path)
                : [];
            return matches.length === 1 ? "file" : "missing";
          };
          const files: SessionsFilesStatResult["files"] = [];
          for (const path of paths) {
            files.push({ path, status: await statPath(path) });
          }
          assertCurrent();
          const publish = () => {
            assertSourceCurrent();
            respond(true, { sessionKey: params.sessionKey, files });
          };
          if (hostRead.hasHostRead()) {
            await hostRead.withCurrent(publish);
          } else {
            publish();
          }
        } finally {
          repository?.[Symbol.dispose]();
          hostRead.release();
        }
      },
    );
  } catch (error) {
    if (!(error instanceof SessionMutationAuthorizationChangedError)) {
      throw error;
    }
    respond(false, undefined, error.error);
  } finally {
    read?.release();
  }
}
