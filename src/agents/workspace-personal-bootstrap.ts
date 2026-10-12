import path from "node:path";
import { isRootFileMissingFailure } from "../infra/boundary-file-read.js";
import { prepareUserProfileCatalog } from "../state/user-profile-list.js";
import { resolveUserPath } from "../utils.js";
import {
  createLoadedWorkspaceBootstrapFile,
  readWorkspaceFileWithGuards,
} from "./workspace-file-read.js";
import { DEFAULT_USER_FILENAME, type WorkspaceBootstrapFile } from "./workspace.js";

/** Optional personal overlay; the caller supplies the session-selected human profile. */
export async function loadPersonalUserBootstrapFile(
  dir: string,
  profileId?: string,
  warn?: (message: string) => void,
): Promise<WorkspaceBootstrapFile | undefined> {
  if (!profileId) {
    return undefined;
  }
  const profiles = await prepareUserProfileCatalog();
  try {
    if (!profiles.hasMultipleSessionSharingIdentities()) {
      return undefined;
    }
    const canonicalId = profiles.readCurrentIdentity(profileId)?.profileId;
    // IDs are opaque, single path segments, not display names or caller-selected paths.
    if (!canonicalId || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(canonicalId)) {
      return undefined;
    }
    const workspaceDir = resolveUserPath(dir);
    const filePath = path.join(workspaceDir, "users", canonicalId, DEFAULT_USER_FILENAME);
    const loaded = await readWorkspaceFileWithGuards({
      filePath,
      workspaceDir,
      rejectAliases: true,
    });
    if (!loaded.ok) {
      if (!isRootFileMissingFailure(loaded)) {
        warn?.("Personal USER.md could not be read safely; using shared defaults.");
      }
      return undefined;
    }
    // A merge while the file was being read must not inject a retired profile's overlay.
    if (
      !profiles.hasMultipleSessionSharingIdentities() ||
      profiles.readCurrentIdentity(profileId)?.profileId !== canonicalId
    ) {
      return undefined;
    }
    return createLoadedWorkspaceBootstrapFile(DEFAULT_USER_FILENAME, filePath, loaded, true);
  } finally {
    profiles.release();
  }
}
