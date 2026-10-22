import path from "node:path";
import type {
  SessionFileBrowserEntry,
  SessionFileEntry,
  SessionsDiffParams,
  SessionsDiffResult,
} from "../../../packages/gateway-protocol/src/index.js";
import { gitEnvironment } from "../../agents/worktrees/git.js";
import { gitCommandArgv, gitReadOnlyEnvironment } from "../../infra/git-exec.js";
import { spawnCommand } from "../../process/exec-spawn.js";
import { readSessionRepositoryArtifacts } from "../worker-environments/session-repository-checkpoints.js";
import type { resolveRepositoryWorkspaceAccess } from "./session-repository-workspace-access.js";
import { populateSessionFilePreview } from "./workspace-files.js";
import { normalizeRelativePath, sortWorkspaceEntries } from "./workspace-fs.js";

type StoredRepository = Extract<
  Awaited<ReturnType<typeof resolveRepositoryWorkspaceAccess>>,
  { kind: "stored" }
>;

async function readArtifacts(access: StoredRepository, previewPath?: string, download = false) {
  access.assertCurrent();
  if (!access.repository.checkpointRef) {
    return undefined;
  }
  const snapshot = await readSessionRepositoryArtifacts({
    store: access.store,
    workspaceId: access.repository.workspaceId,
    checkpointRef: access.repository.checkpointRef,
    ...(download ? { downloadPath: previewPath } : { previewPath }),
    assertCurrent: access.assertCurrent,
  });
  access.assertCurrent();
  return snapshot;
}

function fileEntry(filePath: string, size: number | undefined): SessionFileEntry {
  return {
    path: filePath,
    workspacePath: filePath,
    name: path.posix.basename(filePath),
    kind: "modified",
    missing: size === undefined,
    ...(size === undefined ? {} : { size }),
  };
}

export function resolveRepositoryArtifactPath(requested: string): string | undefined {
  const normalized = normalizeRelativePath(requested);
  return path.posix.isAbsolute(requested) ||
    path.win32.isAbsolute(requested) ||
    normalized.split("/").includes("..")
    ? undefined
    : normalized;
}

/** Only cumulative changed artifacts are retained; no repository checkout is materialized. */
export async function listRepositoryArtifacts(
  access: StoredRepository,
  request: { path?: string; search?: string },
) {
  const snapshot = await readArtifacts(access);
  const changed = new Map(
    snapshot?.changedEntries
      .filter((entry) => entry.type === "file")
      .map((entry) => [entry.path, entry]) ?? [],
  );
  const files =
    snapshot?.changes.map((entry) => fileEntry(entry.path, changed.get(entry.path)?.size)) ?? [];
  const folder = resolveRepositoryArtifactPath(request.path ?? "");
  if (folder === undefined) {
    return { gitCheckout: true, files };
  }
  const entries = new Map<string, SessionFileBrowserEntry>();
  const query = request.search?.trim().toLowerCase();
  const prefix = folder ? `${folder}/` : "";
  for (const [filePath, entry] of changed) {
    if (query ? !filePath.toLowerCase().includes(query) : !filePath.startsWith(prefix)) {
      continue;
    }
    const remainder = filePath.slice(prefix.length);
    const name = query ? path.posix.basename(filePath) : remainder.split("/")[0]!;
    const selectedPath = query ? filePath : `${prefix}${name}`;
    const directory = !query && remainder.includes("/");
    entries.set(selectedPath, {
      path: selectedPath,
      name,
      kind: directory ? "directory" : "file",
      sessionKind: "modified",
      ...(directory ? {} : { size: entry.size }),
    });
  }
  const limit = query ? 500 : 250;
  const parent = path.posix.dirname(folder);
  return {
    gitCheckout: true,
    files,
    browser: {
      path: query ? "" : folder,
      ...(query
        ? { search: request.search }
        : folder
          ? { parentPath: parent === "." ? "" : parent }
          : {}),
      entries: sortWorkspaceEntries([...entries.values()]).slice(0, limit),
      ...(entries.size > limit ? { truncated: true } : {}),
    },
  };
}

export async function getRepositoryArtifact(
  access: StoredRepository,
  requestedPath: string,
): Promise<{ file?: SessionFileEntry }> {
  const selected = resolveRepositoryArtifactPath(requestedPath);
  const snapshot = await readArtifacts(access, selected);
  const entry = snapshot?.changedEntries.find((candidate) => candidate.path === selected);
  if (!snapshot || entry?.type !== "file") {
    throw new Error(
      "This file is not a retained changed artifact. Start the cloud session to read its repository files.",
    );
  }
  const file = fileEntry(entry.path, entry.size);
  if (snapshot.preview !== undefined) {
    const content = Buffer.from(
      snapshot.preview.buffer,
      snapshot.preview.byteOffset,
      snapshot.preview.byteLength,
    );
    access.assertCurrent();
    await populateSessionFilePreview(file, content);
    // Accepted artifacts are immutable; editing resumes with the live worker checkout.
    delete file.hash;
  }
  access.assertCurrent();
  return { file };
}

export async function downloadRepositoryArtifact(access: StoredRepository, requestedPath: string) {
  const selected = resolveRepositoryArtifactPath(requestedPath);
  if (selected === undefined) {
    return { status: "missing" as const };
  }
  const snapshot = await readArtifacts(access, selected, true);
  const entry = snapshot?.changedEntries.find((candidate) => candidate.path === selected);
  if (!snapshot || entry?.type !== "file") {
    return { status: "missing" as const };
  }
  if (!snapshot.downloadObjectId) {
    return { status: "missing" as const };
  }
  return {
    status: "ok" as const,
    filename: path.posix.basename(entry.path),
    size: entry.size,
    identity: snapshot.downloadObjectId,
  };
}

/** Accepted changed blobs are immutable. Never materialize a checkout or a whole blob. */
export async function* streamRepositoryArtifact(
  access: StoredRepository,
  objectId: string,
  start: number,
  end: number,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  access.assertCurrent();
  const args = ["cat-file", "blob", objectId];
  const child = spawnCommand(
    gitCommandArgv(access.store.artifactPath(access.repository.workspaceId), args),
    {
      env: gitReadOnlyEnvironment(args, gitEnvironment()),
      buffer: false,
      stdio: ["ignore", "pipe", "ignore"],
      cancelSignal: signal,
    },
  );
  const completed = child.then(
    () => undefined,
    (error: unknown) => error,
  );
  try {
    let offset = 0;
    for await (const chunk of child.stdout!) {
      const bytes: Buffer = chunk;
      const next = offset + bytes.length;
      if (next > start && offset < end) {
        yield bytes.subarray(Math.max(0, start - offset), Math.min(bytes.length, end - offset));
      }
      offset = next;
      if (offset >= end) {
        break;
      }
    }
    if (offset < end) {
      throw new Error("Retained file download ended before its expected size.");
    }
  } finally {
    child.kill();
    await completed;
  }
}

export async function loadRepositoryArtifactDiff(
  access: StoredRepository,
  params: SessionsDiffParams,
): Promise<SessionsDiffResult> {
  const snapshot = await readArtifacts(access);
  return {
    sessionKey: params.sessionKey,
    branch: access.repository.branch,
    ...(access.repository.baseCommit ? { baseRef: access.repository.baseCommit } : {}),
    files: !params.scope || params.scope === "all" ? (snapshot?.changes ?? []) : [],
    additions: 0,
    deletions: 0,
    unavailableReason: "workspace_stopped",
  };
}
