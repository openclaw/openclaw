import { tryLoadActivatedBundledPluginPublicSurfaceModuleSync } from "./facade-runtime.js";

type DiscordThreadBindingsModule = typeof import("../../extensions/discord/runtime-api.js");

export const unbindThreadBindingsBySessionKey: DiscordThreadBindingsModule["unbindThreadBindingsBySessionKey"] =
  ((...args) => {
    // Session cleanup always attempts Discord thread unbinds, even when Discord is disabled.
    // Keep that path a no-op unless the Discord runtime is actually active.
    const unbindThreadBindings = tryLoadActivatedBundledPluginPublicSurfaceModuleSync<
      Pick<DiscordThreadBindingsModule, "unbindThreadBindingsBySessionKey">
    >({
      dirName: "discord",
      artifactBasename: "runtime-api.js",
    })?.unbindThreadBindingsBySessionKey;
    return typeof unbindThreadBindings === "function" ? unbindThreadBindings(...args) : [];
  }) as DiscordThreadBindingsModule["unbindThreadBindingsBySessionKey"];
