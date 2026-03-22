type InstallScanLogger = {
  warn?: (message: string) => void;
};

async function loadInstallSecurityScanRuntime() {
  return await import("./install-security-scan.runtime.js");
}

export async function scanBundleInstallSource(params: {
  logger: InstallScanLogger;
  pluginId: string;
  sourceDir: string;
}) {
  const { scanBundleInstallSourceRuntime } = await loadInstallSecurityScanRuntime();
  await scanBundleInstallSourceRuntime(params);
}

export async function scanPackageInstallSource(params: {
  extensions: string[];
  logger: InstallScanLogger;
  packageDir: string;
  pluginId: string;
}) {
  const { scanPackageInstallSourceRuntime } = await loadInstallSecurityScanRuntime();
  await scanPackageInstallSourceRuntime(params);
}
