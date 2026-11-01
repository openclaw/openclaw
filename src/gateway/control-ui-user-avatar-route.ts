import { normalizeControlUiBasePath } from "./control-ui-shared.js";

export const CONTROL_UI_USER_AVATAR_PATH_PREFIX = "/api/users/";
export const CONTROL_UI_USER_AVATAR_PATH_SUFFIX = "/avatar";

export function buildControlUiUserAvatarPath(
  profileId: string,
  revision?: string | number,
  basePath?: string | null,
): string {
  const path = `${normalizeControlUiBasePath(basePath)}${CONTROL_UI_USER_AVATAR_PATH_PREFIX}${encodeURIComponent(profileId)}${CONTROL_UI_USER_AVATAR_PATH_SUFFIX}`;
  return revision === undefined ? path : `${path}?v=${encodeURIComponent(String(revision))}`;
}
