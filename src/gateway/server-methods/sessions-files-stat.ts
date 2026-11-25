import { resolve as resolvePath } from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type {
  SessionsFilesStatParams,
  SessionsFilesStatResult,
} from "../../../packages/gateway-protocol/src/index.js";
import { getAgentWorkspaceAccess } from "../../agents/workspace-access.js";
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
import { getSessionWorkspaceFile, searchWorkspaceEntries } from "./workspace-files.js";
import { openWorkspaceRoot } from "./workspace-fs.js";

type SessionFileStatStatus = SessionsFilesStatResult["files"][number]["status"];
type SessionFileStatReference = SessionsFilesStatParams["files"][number];
type LoadedSessionFileRoot = Parameters<Parameters<typeof withSessionFileRoot>[2]>[0];

/** Mirrors prepareSessionFileWorkspace: only a carried-over prior workspace makes a message's root differ. */
function mayResolveHistoricalWorkspace(entry: LoadedSessionFileRoot["entry"]) {
  return Boolean(
    entry?.sessionId &&
    entry.priorWorkspace &&
    entry.priorWorkspace.worktreeId === entry.worktree?.id,
  );
}

/**
 * Answers whether `sessions.files.get` would open each reference, using the same session root,
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
  const statuses = params.files.map((): SessionFileStatStatus => "unknown");

  /** Stats one workspace's references; returns message-scoped references it must not answer. */
  const statWorkspace = (messageEntryId: string | undefined, indices: number[]) =>
    withSessionFileRoot(
      {
        sessionKey: params.sessionKey,
        agentId,
        messageEntryId,
        getRuntimeConfig: context.getRuntimeConfig,
        projection: "list",
        retained: read?.prepared,
      },
      context.getRuntimeConfig(),
      async (source, assertSourceCurrent, readEntry) => {
        const deferred = new Map<string, number[]>();
        if (rejectDeviceFolderFiles(source.entry, respond)) {
          return null;
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
          // Touched files change candidate resolution when the session cwd is not the root, or
          // when re-resolving a workspace path would reinterpret "@", "~" or "file:" syntax.
          const syntaxSensitive = (path: string) => /[@~]|file:/u.test(path);
          const touchedFiles =
            Boolean(
              source.root &&
              source.fileRoot &&
              resolvePath(source.fileRoot) !== resolvePath(source.root),
            ) || indices.some((index) => syntaxSensitive(params.files[index]!.path));
          const loaded = await loadSessionFiles(
            source,
            context,
            assertSourceCurrent,
            assertReaderCurrent,
            undefined,
            { touchedFiles },
          );
          repository = loaded.repository;
          assertCurrent();
          const statPath = async (path: string): Promise<SessionFileStatStatus> => {
            // Repository and remote workspace files live elsewhere; only a full read can answer.
            if (repository || (source.root && getAgentWorkspaceAccess(source.root))) {
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
              admitRead: true,
              assertCurrent: () => {
                assertCurrent();
                prepared.assertCurrent?.();
              },
              authorizeHostRead: hostRead.authorizeHostRead,
            });
            return file && !file.missing ? "file" : "missing";
          };
          const splitByMessage =
            messageEntryId === undefined && mayResolveHistoricalWorkspace(source.entry);
          const answered = new Map<string, SessionFileStatStatus>();
          for (const index of indices) {
            const reference: SessionFileStatReference = params.files[index]!;
            if (splitByMessage && reference.messageEntryId) {
              const group = deferred.get(reference.messageEntryId) ?? [];
              group.push(index);
              deferred.set(reference.messageEntryId, group);
              continue;
            }
            let status = answered.get(reference.path);
            if (!status) {
              status = await statPath(reference.path);
              answered.set(reference.path, status);
            }
            statuses[index] = status;
          }
          // Mirrors the Control UI's bare-name reader fallback: one complete, unique match opens.
          const bareMisses = [...answered]
            .filter(([path, status]) => status === "missing" && /^[^\\/]+$/u.test(path))
            .map(([path]) => path);
          // The reader searches the current workspace even for a historical message, so a
          // historical miss cannot be answered from either root alone.
          if (source.fileWorkspace?.historical) {
            for (const index of indices) {
              if (statuses[index] === "missing" && bareMisses.includes(params.files[index]!.path)) {
                statuses[index] = "unknown";
              }
            }
          } else if (loaded.root && bareMisses.length > 0) {
            // The same Files searches the reader runs, over one walk; a complete search with
            // exactly one same-name file is the match the reader would open.
            const searches = bareMisses.flatMap((name) => {
              const search = normalizeOptionalString(name);
              return search ? [{ name, search }] : [];
            });
            const workspaceRoot = await openWorkspaceRoot(loaded.readRoot ?? loaded.root);
            const results = await searchWorkspaceEntries(
              workspaceRoot ?? loaded.root,
              searches.map(({ search }) => search),
              undefined,
              assertCurrent,
            );
            const found = new Map<string, string>();
            for (const [index, { name }] of searches.entries()) {
              const { entries, truncated } = results[index]!;
              const matches = truncated
                ? []
                : entries.filter((entry) => entry.kind === "file" && entry.name === name);
              if (matches.length === 1) {
                found.set(name, matches[0]!.path);
              }
            }
            const opened = new Set<string>();
            const undecided = new Set<string>();
            for (const [name, match] of found) {
              // Without the touched files, such a match could resolve differently than the reader.
              if (!touchedFiles && syntaxSensitive(match)) {
                undecided.add(name);
                continue;
              }
              // The reader then opens the match by its full path, under the same admission.
              const { file } = await getSessionWorkspaceFile({
                ...loaded,
                path: resolvePath(loaded.root, match),
                includeContent: false,
                admitRead: true,
                assertCurrent,
                authorizeHostRead: hostRead.authorizeHostRead,
              });
              if (file && !file.missing) {
                opened.add(name);
              }
            }
            for (const index of indices) {
              const reference = params.files[index]!.path;
              if (statuses[index] === "missing" && opened.has(reference)) {
                statuses[index] = "file";
              } else if (statuses[index] === "missing" && undecided.has(reference)) {
                statuses[index] = "unknown";
              }
            }
          }
          assertCurrent();
          if (hostRead.hasHostRead()) {
            await hostRead.withCurrent(assertSourceCurrent);
          }
          return deferred;
        } finally {
          repository?.[Symbol.dispose]();
          hostRead.release();
        }
      },
    );

  try {
    const deferred = await statWorkspace(
      undefined,
      params.files.map((_, index) => index),
    );
    if (!deferred) {
      return;
    }
    for (const [messageEntryId, indices] of deferred) {
      // A message that left the conversation is refused like a read; its links stay "unknown".
      await statWorkspace(messageEntryId, indices).catch((error: unknown) => {
        if (!(error instanceof SessionMutationAuthorizationChangedError)) {
          throw error;
        }
      });
    }
    respond(true, {
      sessionKey: params.sessionKey,
      files: params.files.map(({ path }, index) => ({ path, status: statuses[index]! })),
    });
  } catch (error) {
    if (!(error instanceof SessionMutationAuthorizationChangedError)) {
      throw error;
    }
    respond(false, undefined, error.error);
  } finally {
    read?.release();
  }
}
