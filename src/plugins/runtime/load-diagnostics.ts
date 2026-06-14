export type RuntimePluginLoadProgressPhase =
  | "resolve"
  | "load"
  | "setup-runtime-load"
  | "setup-runtime-apply"
  | "setup-runtime-register"
  | "register";

export type RuntimePluginLoadProgress = {
  pluginIds: readonly string[];
  completedPluginIds: readonly string[];
  inFlightPluginId?: string;
  inFlightPhase?: RuntimePluginLoadProgressPhase;
};

export type RuntimePluginLoadProgressReporter = (progress: RuntimePluginLoadProgress) => void;
