import { createLazyRuntimeNamedExport } from "../shared/lazy-runtime.js";

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
