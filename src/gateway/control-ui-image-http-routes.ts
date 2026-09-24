import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";

const getPluginIconHttpModule = createLazyRuntimeModule(() => import("./plugin-icon-http.js"));
const getPluginThemeArtHttpModule = createLazyRuntimeModule(
  () => import("./plugin-theme-art-http.js"),
);
const getWorkspaceIconHttpModule = createLazyRuntimeModule(
  () => import("./workspace-icon-http.js"),
);
const getChannelAvatarHttpModule = createLazyRuntimeModule(
  () => import("./channel-avatar-http.js"),
);

/** Resource owners stay lazy until their authenticated image route is requested. */
export const CONTROL_UI_IMAGE_HTTP_ROUTES = [
  [
    ["pluginIcon", "pluginActivityIcon", "catalogIcon", "linkFavicon"],
    async () => (await getPluginIconHttpModule()).handlePluginIconHttpRequest,
  ],
  [
    ["pluginThemeArt"],
    async () => (await getPluginThemeArtHttpModule()).handlePluginThemeArtHttpRequest,
  ],
  [
    ["workspaceIcon"],
    async () => (await getWorkspaceIconHttpModule()).handleWorkspaceIconHttpRequest,
  ],
  [
    ["channelAvatar"],
    async () => (await getChannelAvatarHttpModule()).handleChannelAvatarHttpRequest,
  ],
] as const;
