import type { InstallCodeSafetyMode } from "../infra/install-code-safety-mode.js";

type InstallScanLogger = {
  warn?: (message: string) => void;
};

async function loadInstallSecurityScanRuntime() {
  return await import("./install-security-scan.runtime.js");
}

export async function scanBundleInstallSource(params: {
  codeSafetyMode?: InstallCodeSafetyMode;
  logger: InstallScanLogger;
  pluginId: string;
  sourceDir: string;
}) {
  const { scanBundleInstallSourceRuntime } = await loadInstallSecurityScanRuntime();
  return await scanBundleInstallSourceRuntime(params);
}

export async function scanPackageInstallSource(params: {
  codeSafetyMode?: InstallCodeSafetyMode;
  extensions: string[];
  logger: InstallScanLogger;
  packageDir: string;
  pluginId: string;
}) {
  const { scanPackageInstallSourceRuntime } = await loadInstallSecurityScanRuntime();
  return await scanPackageInstallSourceRuntime(params);
}
