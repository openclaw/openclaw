import path from "node:path";
import { isRootFileMissingFailure } from "../infra/boundary-file-read.js";
import { readUserProfileIdentity } from "../state/user-profile-list.js";
import { resolveUserPath } from "../utils.js";
import {
  readWorkspaceFileWithGuards,
  setWorkspaceFileSourceIdentity,
} from "./workspace-file-read.js";
import { DEFAULT_USER_FILENAME, type WorkspaceBootstrapFile } from "./workspace.js";

/** Optional personal overlay; the caller supplies only the admitted ingress profile. */
export async function loadPersonalUserBootstrapFile(
  dir: string,
  profileId?: string,
  warn?: (message: string) => void,
): Promise<WorkspaceBootstrapFile | undefined> {
  if (!profileId) {
    return undefined;
  }
  const canonicalId = readUserProfileIdentity(profileId)?.profileId;
  // IDs are opaque, single path segments, not display names or caller-selected paths.
  if (!canonicalId || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(canonicalId)) {
    return undefined;
  }
  const workspaceDir = resolveUserPath(dir);
  const filePath = path.join(workspaceDir, "users", canonicalId, DEFAULT_USER_FILENAME);
  const loaded = await readWorkspaceFileWithGuards({ filePath, workspaceDir, rejectAliases: true });
  if (!loaded.ok) {
    if (!isRootFileMissingFailure(loaded)) {
      warn?.("Personal USER.md could not be read safely; using shared defaults.");
    }
    return undefined;
  }
  // A merge while the file was being read must not inject a retired profile's overlay.
  if (readUserProfileIdentity(profileId)?.profileId !== canonicalId) {
    return undefined;
  }
  const file: WorkspaceBootstrapFile = {
    name: DEFAULT_USER_FILENAME,
    path: filePath,
    content: loaded.content,
    missing: false,
  };
  setWorkspaceFileSourceIdentity(file, loaded.sourceIdentity);
  return file;
}
