import path from "node:path";
import {
  resolveInstallCodeSafetyMode,
  type InstallCodeSafetyMode,
} from "../infra/install-code-safety-mode.js";
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

function resolveCriticalFindingBlockMessage(params: {
  codeSafetyMode?: InstallCodeSafetyMode;
  findings: Array<{ file: string; line: number; message: string; severity: string }>;
  label: "Bundle" | "Plugin";
  logger: InstallScanLogger;
  pluginId: string;
}): string | null {
  const details = buildCriticalDetails({ findings: params.findings });
  if (resolveInstallCodeSafetyMode(params.codeSafetyMode) === "block-critical") {
    return `${params.label} "${params.pluginId}" install blocked by code safety scan: ${details}`;
  }
  params.logger.warn?.(
    `WARNING: ${params.label} "${params.pluginId}" contains dangerous code patterns: ${details}`,
  );
  return null;
}

export async function scanBundleInstallSourceRuntime(params: {
  codeSafetyMode?: InstallCodeSafetyMode;
  logger: InstallScanLogger;
  pluginId: string;
  sourceDir: string;
}) {
  try {
    const scanSummary = await scanDirectoryWithSummary(params.sourceDir);
    if (scanSummary.critical > 0) {
      return resolveCriticalFindingBlockMessage({
        codeSafetyMode: params.codeSafetyMode,
        findings: scanSummary.findings,
        label: "Bundle",
        logger: params.logger,
        pluginId: params.pluginId,
      });
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

  return null;
}

export async function scanPackageInstallSourceRuntime(params: {
  codeSafetyMode?: InstallCodeSafetyMode;
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
      return resolveCriticalFindingBlockMessage({
        codeSafetyMode: params.codeSafetyMode,
        findings: scanSummary.findings,
        label: "Plugin",
        logger: params.logger,
        pluginId: params.pluginId,
      });
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

  return null;
}
