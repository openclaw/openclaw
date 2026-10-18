import { readFileWindowFully } from "@openclaw/fs-safe/advanced";
import { WORKSPACE_DOWNLOAD_CHUNK_BYTES } from "../workspace-file-limits.js";
import { resolveSessionFileReadTarget } from "./session-file-read.js";
import { getSessionWorkspaceFile, type LoadedSessionFiles } from "./workspace-files.js";
import { openWorkspaceRoot } from "./workspace-fs.js";

/** No offset prepares metadata only; GET pulls one bounded window at a time.
 * Concurrent edits fail at the next window; bytes already delivered cannot be recalled.
 */
export async function readSessionFileDownloadWindow(
  params: LoadedSessionFiles & {
    path: string;
    offset?: number;
    identity?: string;
    assertCurrent: () => void;
  },
) {
  const { file } = await getSessionWorkspaceFile({ ...params, includeContent: false });
  params.assertCurrent();
  if (!file || file.missing || !file.workspacePath) {
    return { status: "missing" as const };
  }
  const target = await resolveSessionFileReadTarget(
    { ...params, fileRoot: params.root },
    file.workspacePath,
  );
  params.assertCurrent();
  if (!target || target === "outside_session_boundary") {
    return { status: "missing" as const };
  }
  const root = typeof target.root === "string" ? await openWorkspaceRoot(target.root) : target.root;
  if (!root) {
    return { status: "missing" as const };
  }
  if ("access" in root) {
    throw new Error("This workspace host does not support streaming downloads.");
  }
  const opened = await root.open(target.path);
  await using handle = opened.handle;
  params.assertCurrent();
  const { stat } = opened;
  const identity = JSON.stringify([
    opened.realPath,
    stat.dev,
    stat.ino,
    stat.size,
    stat.mtimeMs,
    stat.ctimeMs,
  ]);
  if (params.identity !== undefined && params.identity !== identity) {
    throw new Error("Session file changed during download; retry the download.");
  }
  const bytes = Buffer.alloc(
    params.offset === undefined
      ? 0
      : Math.min(WORKSPACE_DOWNLOAD_CHUNK_BYTES, Math.max(0, stat.size - params.offset)),
  );
  if (
    params.offset !== undefined &&
    (await readFileWindowFully(handle, bytes, params.offset)) !== bytes.length
  ) {
    throw new Error("Session file changed during download; retry the download.");
  }
  params.assertCurrent();
  return {
    status: "ok" as const,
    filename: file.name,
    size: stat.size,
    identity,
    data: bytes.toString("base64"),
  };
}
