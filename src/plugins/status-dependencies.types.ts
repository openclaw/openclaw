/** Dependency name-to-version map from a plugin package manifest. */
export type PluginDependencySpecMap = Record<string, string>;

/** Installation status for one plugin dependency. */
export type PluginDependencyEntry = {
  name: string;
  spec: string;
  installed: boolean;
  optional: boolean;
  resolvedPath?: string;
};

/** Aggregate installation status for required and optional plugin dependencies. */
export type PluginDependencyStatus = {
  hasDependencies: boolean;
  installed: boolean;
  requiredInstalled: boolean;
  optionalInstalled: boolean;
  missing: string[];
  missingOptional: string[];
  dependencies: PluginDependencyEntry[];
  optionalDependencies: PluginDependencyEntry[];
};
