import path from "node:path";
import { extensionUsesSkippedScannerPath, isPathInside } from "../security/scan-paths.js";
import { scanDirectoryWithSummary } from "../security/skill-scanner.js";

type InstallScanLogger = {
  warn?: (message: string) => void;
};

function buildCriticalDetails(params: {
  findings: Array<{ file: string; line: number; message: string; severity: string }>;
}) {
  return params.findings
    .filter((finding) => finding.severity === "critical")
    .map((finding) => `${finding.message} (${finding.file}:${finding.line})`)
    .join("; ");
}

export async function scanBundleInstallSourceRuntime(params: {
  logger: InstallScanLogger;
  pluginId: string;
  sourceDir: string;
}) {
  try {
    const scanSummary = await scanDirectoryWithSummary(params.sourceDir);
    if (scanSummary.critical > 0) {
      params.logger.warn?.(
        `WARNING: Bundle "${params.pluginId}" contains dangerous code patterns: ${buildCriticalDetails({ findings: scanSummary.findings })}`,
      );
      return;
    }
    if (scanSummary.warn > 0) {
      params.logger.warn?.(
        `Bundle "${params.pluginId}" has ${scanSummary.warn} suspicious code pattern(s). Run "openclaw security audit --deep" for details.`,
      );
    }
  } catch (err) {
    params.logger.warn?.(
      `Bundle "${params.pluginId}" code safety scan failed (${String(err)}). Installation continues; run "openclaw security audit --deep" after install.`,
    );
  }
}

export async function scanPackageInstallSourceRuntime(params: {
  extensions: string[];
  logger: InstallScanLogger;
  packageDir: string;
  pluginId: string;
}) {
  const forcedScanEntries: string[] = [];
  for (const entry of params.extensions) {
    const resolvedEntry = path.resolve(params.packageDir, entry);
    if (!isPathInside(params.packageDir, resolvedEntry)) {
      params.logger.warn?.(
        `extension entry escapes plugin directory and will not be scanned: ${entry}`,
      );
      continue;
    }
    if (extensionUsesSkippedScannerPath(entry)) {
      params.logger.warn?.(
        `extension entry is in a hidden/node_modules path and will receive targeted scan coverage: ${entry}`,
      );
    }
    forcedScanEntries.push(resolvedEntry);
  }

  try {
    const scanSummary = await scanDirectoryWithSummary(params.packageDir, {
      includeFiles: forcedScanEntries,
    });
    if (scanSummary.critical > 0) {
      params.logger.warn?.(
        `WARNING: Plugin "${params.pluginId}" contains dangerous code patterns: ${buildCriticalDetails({ findings: scanSummary.findings })}`,
      );
      return;
    }
    if (scanSummary.warn > 0) {
      params.logger.warn?.(
        `Plugin "${params.pluginId}" has ${scanSummary.warn} suspicious code pattern(s). Run "openclaw security audit --deep" for details.`,
      );
    }
  } catch (err) {
    params.logger.warn?.(
      `Plugin "${params.pluginId}" code safety scan failed (${String(err)}). Installation continues; run "openclaw security audit --deep" after install.`,
    );
  }
}
