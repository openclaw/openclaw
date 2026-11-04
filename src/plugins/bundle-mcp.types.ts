export type BundleMcpServerConfig = Record<string, unknown>;

export type BundleMcpConfig = {
  mcpServers: Record<string, BundleMcpServerConfig>;
};

export type BundleMcpDataDirOwnership = {
  pluginId: string;
  dataDir: string;
};

export type BundleMcpDiagnostic = {
  pluginId: string;
  message: string;
};

export type EnabledBundleMcpConfigResult = {
  config: BundleMcpConfig;
  diagnostics: BundleMcpDiagnostic[];
  prepareDataDirsByServer: Record<string, BundleMcpDataDirOwnership>;
  pluginIdsByServer: Record<string, string>;
};
