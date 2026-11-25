import type { AnyChannelPlugin as ChannelPlugin } from "./types.plugin.js";

export function mergeChannelPluginSection<T>(
  baseValue: T | undefined,
  overrideValue: T | undefined,
): T | undefined {
  if (
    baseValue &&
    overrideValue &&
    typeof baseValue === "object" &&
    typeof overrideValue === "object"
  ) {
    // Setup artifacts can add lightweight setup/docs/secrets fields on top of
    // runtime artifacts; undefined setup values should not erase runtime data.
    const merged = {
      // SAFETY: The object guard permits copying enumerable section fields.
      ...(baseValue as Record<string, unknown>),
    };
    // SAFETY: The object guard permits reading string-keyed override fields.
    for (const [key, value] of Object.entries(overrideValue as Record<string, unknown>)) {
      if (value !== undefined) {
        merged[key] = value;
      }
    }
    return merged as T; // SAFETY: Base fields and defined overrides share the section type T.
  }
  return overrideValue ?? baseValue;
}

export function mergeChannelPlugins(
  runtimePlugin: ChannelPlugin,
  setupPlugin: ChannelPlugin,
  setupMode: "merge" | "override",
): ChannelPlugin {
  return {
    ...runtimePlugin,
    ...setupPlugin,
    meta: mergeChannelPluginSection(runtimePlugin.meta, setupPlugin.meta),
    capabilities: mergeChannelPluginSection(runtimePlugin.capabilities, setupPlugin.capabilities),
    commands: mergeChannelPluginSection(runtimePlugin.commands, setupPlugin.commands),
    doctor: mergeChannelPluginSection(runtimePlugin.doctor, setupPlugin.doctor),
    reload: mergeChannelPluginSection(runtimePlugin.reload, setupPlugin.reload),
    config: mergeChannelPluginSection(runtimePlugin.config, setupPlugin.config),
    ...(setupMode === "merge"
      ? { setup: mergeChannelPluginSection(runtimePlugin.setup, setupPlugin.setup) }
      : {}),
    messaging: mergeChannelPluginSection(runtimePlugin.messaging, setupPlugin.messaging),
    actions: mergeChannelPluginSection(runtimePlugin.actions, setupPlugin.actions),
    secrets: mergeChannelPluginSection(runtimePlugin.secrets, setupPlugin.secrets),
  } as ChannelPlugin; // SAFETY: Both inputs satisfy the same channel section types.
}
