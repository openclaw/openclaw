import path from "node:path";
import { extensionUsesSkippedScannerPath, isPathInside } from "../security/scan-paths.js";
import { scanDirectoryWithSummary } from "../security/skill-scanner.js";
import type { InstallSafetyOverrides } from "./install-security-scan.js";

type InstallScanLogger = {
  warn?: (message: string) => void;
};

type InstallScanFinding = {
  ruleId: string;
  severity: "info" | "warn" | "critical";
  file: string;
  line: number;
  message: string;
};

type BuiltinInstallScan = {
  status: "ok" | "error";
  scannedFiles: number;
  critical: number;
  warn: number;
  info: number;
  findings: InstallScanFinding[];
  error?: string;
};

type PluginInstallRequestKind =
  | "skill-install"
  | "plugin-dir"
  | "plugin-archive"
  | "plugin-file"
  | "plugin-npm";

export type InstallSecurityScanResult = {
  blocked?: {
    code?: "security_scan_blocked" | "security_scan_failed";
    reason: string;
  };
};

function buildCriticalDetails(params: {
  findings: Array<{ file: string; line: number; message: string; severity: string }>;
}) {
  return params.findings
    .filter((finding) => finding.severity === "critical")
    .map((finding) => `${finding.message} (${finding.file}:${finding.line})`)
    .join("; ");
}

function buildCriticalBlockReason(params: {
  findings: Array<{ file: string; line: number; message: string; severity: string }>;
  targetLabel: string;
}) {
  return `${params.targetLabel} blocked: dangerous code patterns detected: ${buildCriticalDetails({ findings: params.findings })}`;
}

function buildScanFailureBlockReason(params: { error: string; targetLabel: string }) {
  return `${params.targetLabel} blocked: code safety scan failed (${params.error}). Run "openclaw security audit --deep" for details.`;
}

function buildBuiltinScanFromError(error: unknown): BuiltinInstallScan {
  return {
    status: "error",
    scannedFiles: 0,
    critical: 0,
    warn: 0,
    info: 0,
    findings: [],
    error: String(error),
  };
}

function buildBuiltinScanFromSummary(summary: {
  scannedFiles: number;
  critical: number;
  warn: number;
  info: number;
  findings: InstallScanFinding[];
}): BuiltinInstallScan {
  return {
    status: "ok",
    scannedFiles: summary.scannedFiles,
    critical: summary.critical,
    warn: summary.warn,
    info: summary.info,
    findings: summary.findings,
  };
}

async function scanDirectoryTarget(params: {
  includeFiles?: string[];
  logger: InstallScanLogger;
  path: string;
  suspiciousMessage: string;
  targetName: string;
  warningMessage: string;
}): Promise<BuiltinInstallScan> {
  try {
    const scanSummary = await scanDirectoryWithSummary(params.path, {
      includeFiles: params.includeFiles,
    });
    const builtinScan = buildBuiltinScanFromSummary(scanSummary);
    if (scanSummary.critical > 0) {
      params.logger.warn?.(
        `${params.warningMessage}: ${buildCriticalDetails({ findings: scanSummary.findings })}`,
      );
    } else if (scanSummary.warn > 0) {
      params.logger.warn?.(
        params.suspiciousMessage
          .replace("{count}", String(scanSummary.warn))
          .replace("{target}", params.targetName),
      );
    }
    return builtinScan;
  } catch (err) {
    return buildBuiltinScanFromError(err);
  }
}

function buildBlockedScanResult(params: {
  builtinScan: BuiltinInstallScan;
  dangerouslyForceUnsafeInstall?: boolean;
  targetLabel: string;
}): InstallSecurityScanResult | undefined {
  if (params.builtinScan.status === "error") {
    return {
      blocked: {
        code: "security_scan_failed",
        reason: buildScanFailureBlockReason({
          error: params.builtinScan.error ?? "unknown error",
          targetLabel: params.targetLabel,
        }),
      },
    };
  }
  if (params.builtinScan.critical > 0) {
    if (params.dangerouslyForceUnsafeInstall) {
      return undefined;
    }
    return {
      blocked: {
        code: "security_scan_blocked",
        reason: buildCriticalBlockReason({
          findings: params.builtinScan.findings,
          targetLabel: params.targetLabel,
        }),
      },
    };
  }
  return undefined;
}

function logDangerousForceUnsafeInstall(params: {
  findings: Array<{ file: string; line: number; message: string; severity: string }>;
  logger: InstallScanLogger;
  targetLabel: string;
}) {
  params.logger.warn?.(
    `WARNING: ${params.targetLabel} forced despite dangerous code patterns via --dangerously-force-unsafe-install: ${buildCriticalDetails({ findings: params.findings })}`,
  );
}

function resolveBuiltinScanDecision(
  params: InstallSafetyOverrides & {
    builtinScan: BuiltinInstallScan;
    logger: InstallScanLogger;
    targetLabel: string;
  },
): InstallSecurityScanResult | undefined {
  const builtinBlocked = buildBlockedScanResult({
    builtinScan: params.builtinScan,
    dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall,
    targetLabel: params.targetLabel,
  });
  if (params.dangerouslyForceUnsafeInstall && params.builtinScan.critical > 0) {
    logDangerousForceUnsafeInstall({
      findings: params.builtinScan.findings,
      logger: params.logger,
      targetLabel: params.targetLabel,
    });
  }
  return builtinBlocked;
}

async function scanFileTarget(params: {
  logger: InstallScanLogger;
  path: string;
  suspiciousMessage: string;
  targetName: string;
  warningMessage: string;
}): Promise<BuiltinInstallScan> {
  const directory = path.dirname(params.path);
  return await scanDirectoryTarget({
    includeFiles: [params.path],
    logger: params.logger,
    path: directory,
    suspiciousMessage: params.suspiciousMessage,
    targetName: params.targetName,
    warningMessage: params.warningMessage,
  });
}

export async function scanBundleInstallSourceRuntime(
  params: InstallSafetyOverrides & {
    logger: InstallScanLogger;
    pluginId: string;
    sourceDir: string;
    requestKind?: PluginInstallRequestKind;
    requestedSpecifier?: string;
    mode?: "install" | "update";
    version?: string;
  },
): Promise<InstallSecurityScanResult | undefined> {
  const builtinScan = await scanDirectoryTarget({
    logger: params.logger,
    path: params.sourceDir,
    suspiciousMessage: `Bundle "{target}" has {count} suspicious code pattern(s). Run "openclaw security audit --deep" for details.`,
    targetName: params.pluginId,
    warningMessage: `WARNING: Bundle "${params.pluginId}" contains dangerous code patterns`,
  });
  const builtinBlocked = resolveBuiltinScanDecision({
    builtinScan,
    logger: params.logger,
    dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall,
    targetLabel: `Bundle "${params.pluginId}" installation`,
  });

  return builtinBlocked;
}

export async function scanPackageInstallSourceRuntime(
  params: InstallSafetyOverrides & {
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
  },
): Promise<InstallSecurityScanResult | undefined> {
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

  const builtinScan = await scanDirectoryTarget({
    includeFiles: forcedScanEntries,
    logger: params.logger,
    path: params.packageDir,
    suspiciousMessage: `Plugin "{target}" has {count} suspicious code pattern(s). Run "openclaw security audit --deep" for details.`,
    targetName: params.pluginId,
    warningMessage: `WARNING: Plugin "${params.pluginId}" contains dangerous code patterns`,
  });
  const builtinBlocked = resolveBuiltinScanDecision({
    builtinScan,
    logger: params.logger,
    dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall,
    targetLabel: `Plugin "${params.pluginId}" installation`,
  });

  return builtinBlocked;
}

export async function scanFileInstallSourceRuntime(
  params: InstallSafetyOverrides & {
    filePath: string;
    logger: InstallScanLogger;
    mode?: "install" | "update";
    pluginId: string;
    requestedSpecifier?: string;
  },
): Promise<InstallSecurityScanResult | undefined> {
  const builtinScan = await scanFileTarget({
    logger: params.logger,
    path: params.filePath,
    suspiciousMessage: `Plugin file "{target}" has {count} suspicious code pattern(s). Run "openclaw security audit --deep" for details.`,
    targetName: params.pluginId,
    warningMessage: `WARNING: Plugin file "${params.pluginId}" contains dangerous code patterns`,
  });
  const builtinBlocked = resolveBuiltinScanDecision({
    builtinScan,
    logger: params.logger,
    dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall,
    targetLabel: `Plugin file "${params.pluginId}" installation`,
  });

  return builtinBlocked;
}

export async function scanSkillInstallSourceRuntime(params: {
  dangerouslyForceUnsafeInstall?: boolean;
  installId: string;
  installSpec?: {
    id?: string;
    kind: "brew" | "node" | "go" | "uv" | "download";
    label?: string;
    bins?: string[];
    os?: string[];
    formula?: string;
    package?: string;
    module?: string;
    url?: string;
    archive?: string;
    extract?: boolean;
    stripComponents?: number;
    targetDir?: string;
  };
  logger: InstallScanLogger;
  origin: string;
  skillName: string;
  sourceDir: string;
}): Promise<InstallSecurityScanResult | undefined> {
  const builtinScan = await scanDirectoryTarget({
    logger: params.logger,
    path: params.sourceDir,
    suspiciousMessage:
      'Skill "{target}" has {count} suspicious code pattern(s). Run "openclaw security audit --deep" for details.',
    targetName: params.skillName,
    warningMessage: `WARNING: Skill "${params.skillName}" contains dangerous code patterns`,
  });
  const builtinBlocked = buildBlockedScanResult({
    builtinScan,
    dangerouslyForceUnsafeInstall: params.dangerouslyForceUnsafeInstall,
    targetLabel: `Skill "${params.skillName}" installation`,
  });
  if (params.dangerouslyForceUnsafeInstall && builtinScan.critical > 0) {
    logDangerousForceUnsafeInstall({
      findings: builtinScan.findings,
      logger: params.logger,
      targetLabel: `Skill "${params.skillName}" installation`,
    });
  }

  return builtinBlocked;
}
