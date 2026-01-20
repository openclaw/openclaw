export type PluginManifestChannel = {
  id?: string;
  label?: string;
  selectionLabel?: string;
  docsPath?: string;
  docsLabel?: string;
  blurb?: string;
  order?: number;
  aliases?: string[];
  selectionDocsPrefix?: string;
  selectionDocsOmitLabel?: boolean;
  selectionExtras?: string[];
  showConfigured?: boolean;
  quickstartAllowFrom?: boolean;
  forceAccountBinding?: boolean;
  preferSessionLookupForAnnounceTarget?: boolean;
};

export type PluginManifestInstall = {
  npmSpec?: string;
  localPath?: string;
  defaultChoice?: "npm" | "local";
};

export type ClawdbotManifest = {
  extensions?: string[];
  channel?: PluginManifestChannel;
  install?: PluginManifestInstall;
};

export type PackageManifest = {
  name?: string;
  version?: string;
  description?: string;
  clawdbot?: ClawdbotManifest;
};
