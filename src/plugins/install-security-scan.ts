type InstallScanLogger = {
  warn?: (message: string) => void;
};

export type InstallSecurityScanResult = {
  blocked?: {
    reason: string;
  };
};

async function loadInstallSecurityScanRuntime() {
  return await import("./install-security-scan.runtime.js");
}

export async function scanBundleInstallSource(params: {
  logger: InstallScanLogger;
  pluginId: string;
  sourceDir: string;
}): Promise<InstallSecurityScanResult | undefined> {
  const { scanBundleInstallSourceRuntime } = await loadInstallSecurityScanRuntime();
  return await scanBundleInstallSourceRuntime(params);
}

export async function scanPackageInstallSource(params: {
  extensions: string[];
  logger: InstallScanLogger;
  packageDir: string;
  pluginId: string;
}): Promise<InstallSecurityScanResult | undefined> {
  const { scanPackageInstallSourceRuntime } = await loadInstallSecurityScanRuntime();
  return await scanPackageInstallSourceRuntime(params);
}
