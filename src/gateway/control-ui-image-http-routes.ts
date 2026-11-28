import { createLazyRuntimeNamedExport } from "../shared/lazy-runtime.js";
import { parseControlUiUserAvatarPath } from "./control-ui-contract.js";
import { parseControlUiUserBackgroundPath } from "./control-ui-user-background-route.js";
import { parsePwaIconRoute } from "./pwa-icon-contract.js";

/** Resource owners stay lazy until their authenticated image route is requested. */
export const CONTROL_UI_IMAGE_HTTP_ROUTES = [
  [
    ["providerIcon"],
    createLazyRuntimeNamedExport(
      () => import("./provider-icon-http.js"),
      "handleProviderIconHttpRequest",
    ),
  ],
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
    ["projectIcon"],
    createLazyRuntimeNamedExport(
      () => import("./workspace-icon-http.js"),
      "handleProjectIconHttpRequest",
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

/** The final flag marks install artwork, which is served only when dashboard hosting is enabled. */
export const CONTROL_UI_USER_IMAGE_HTTP_ROUTES = [
  [
    parseControlUiUserBackgroundPath,
    createLazyRuntimeNamedExport(
      () => import("./user-background-http.js"),
      "handleUserBackgroundHttpRequest",
    ),
    false,
  ],
  [
    parseControlUiUserAvatarPath,
    createLazyRuntimeNamedExport(
      () => import("./user-profiles-http.js"),
      "handleUserProfileAvatarHttpRequest",
    ),
    false,
  ],
  [
    (pathname: string, basePath: string) => ({
      matched: Boolean(parsePwaIconRoute(pathname, basePath)),
    }),
    createLazyRuntimeNamedExport(() => import("./pwa-icon-http.js"), "handlePwaIconHttpRequest"),
    true,
  ],
] as const;
