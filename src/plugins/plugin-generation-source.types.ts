import type { PluginCapturedSourceFact } from "./plugin-source-verification.js";

export type PluginFrozenSourceSnapshot = {
  rootDir: string;
  sourceRoot: string;
  sourceAliases: Readonly<Record<string, string>>;
  sourcePaths: ReadonlySet<string>;
  sourceLinks: ReadonlyMap<string, string>;
  sourceHardlinks: ReadonlySet<string>;
  sourceDigest: string;
};

export type PluginSourceSnapshotFacts = {
  files: ReadonlyMap<string, PluginCapturedSourceFact>;
  directories: ReadonlySet<string>;
  links: ReadonlyMap<string, string>;
  hardlinks: ReadonlySet<string>;
};
