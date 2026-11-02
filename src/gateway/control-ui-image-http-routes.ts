import { createLazyRuntimeNamedExport } from "../shared/lazy-runtime.js";
import { parseControlUiUserAvatarPath } from "./control-ui-contract.js";
import { parseControlUiUserBackgroundPath } from "./control-ui-user-background-route.js";

/** Resource owners stay lazy until their authenticated image route is requested. */
export const CONTROL_UI_IMAGE_HTTP_ROUTES = [
  [
    ["pluginIcon", "pluginActivityIcon", "catalogIcon", "linkFavicon"],
    createLazyRuntimeNamedExport(
      () => import("./plugin-icon-http.js"),
      "handlePluginIconHttpRequest",
    ),
  ],
  [
    ["pluginThemeArt"],
    createLazyRuntimeNamedExport(
      () => import("./plugin-theme-art-http.js"),
      "handlePluginThemeArtHttpRequest",
    ),
  ],
  [
    ["workspaceIcon"],
    createLazyRuntimeNamedExport(
      () => import("./workspace-icon-http.js"),
      "handleWorkspaceIconHttpRequest",
    ),
  ],
  [
    ["channelAvatar"],
    createLazyRuntimeNamedExport(
      () => import("./channel-avatar-http.js"),
      "handleChannelAvatarHttpRequest",
    ),
  ],
] as const;

/** Personal images use their private authenticated owners even without dashboard hosting. */
export const CONTROL_UI_USER_IMAGE_HTTP_ROUTES = [
  [
    parseControlUiUserBackgroundPath,
    createLazyRuntimeNamedExport(
      () => import("./user-background-http.js"),
      "handleUserBackgroundHttpRequest",
    ),
  ],
  [
    parseControlUiUserAvatarPath,
    createLazyRuntimeNamedExport(
      () => import("./user-profiles-http.js"),
      "handleUserProfileAvatarHttpRequest",
    ),
  ],
] as const;
