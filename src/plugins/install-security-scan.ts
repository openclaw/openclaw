type InstallScanLogger = {
  warn?: (message: string) => void;
};

export type InstallSecurityScanResult = {
  blocked?: {
    reason: string;
  };
};

export type PluginInstallRequestKind =
  | "plugin-dir"
  | "plugin-archive"
  | "plugin-file"
  | "plugin-npm";

async function loadInstallSecurityScanRuntime() {
  return await import("./install-security-scan.runtime.js");
}

export async function scanBundleInstallSource(params: {
  logger: InstallScanLogger;
  pluginId: string;
  sourceDir: string;
  requestKind?: PluginInstallRequestKind;
  requestedSpecifier?: string;
  mode?: "install" | "update";
  version?: string;
}): Promise<InstallSecurityScanResult | undefined> {
  const { scanBundleInstallSourceRuntime } = await loadInstallSecurityScanRuntime();
  return await scanBundleInstallSourceRuntime(params);
}

export async function scanPackageInstallSource(params: {
  extensions: string[];
  logger: InstallScanLogger;
  packageDir: string;
  pluginId: string;
  requestKind?: PluginInstallRequestKind;
  requestedSpecifier?: string;
  mode?: "install" | "update";
  packageName?: string;
  manifestId?: string;
  version?: string;
}): Promise<InstallSecurityScanResult | undefined> {
  const { scanPackageInstallSourceRuntime } = await loadInstallSecurityScanRuntime();
  return await scanPackageInstallSourceRuntime(params);
}

export async function scanFileInstallSource(params: {
  filePath: string;
  logger: InstallScanLogger;
  mode?: "install" | "update";
  pluginId: string;
  requestedSpecifier?: string;
}): Promise<InstallSecurityScanResult | undefined> {
  const { scanFileInstallSourceRuntime } = await loadInstallSecurityScanRuntime();
  return await scanFileInstallSourceRuntime(params);
}
