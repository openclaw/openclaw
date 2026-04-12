type FacadeModule = typeof import("@openclaw/anthropic-vertex/api.js");
import { loadBundledPluginPublicSurfaceModuleSync } from "./facade-loader.js";

function loadFacadeModule(): FacadeModule {
  return loadBundledPluginPublicSurfaceModuleSync<FacadeModule>({
    dirName: "anthropic-vertex",
    artifactBasename: "api.js",
  });
}

export const resolveAnthropicVertexClientRegion: FacadeModule["resolveAnthropicVertexClientRegion"] =
  ((...args) =>
    loadFacadeModule().resolveAnthropicVertexClientRegion(
      ...args,
    )) as FacadeModule["resolveAnthropicVertexClientRegion"];

export const resolveAnthropicVertexProjectId: FacadeModule["resolveAnthropicVertexProjectId"] = ((
  ...args
) =>
  loadFacadeModule().resolveAnthropicVertexProjectId(
    ...args,
  )) as FacadeModule["resolveAnthropicVertexProjectId"];
