import path from "node:path";
import { extensionUsesSkippedScannerPath, isPathInside } from "../security/scan-paths.js";
import { scanDirectoryWithSummary } from "../security/skill-scanner.js";
import { getGlobalHookRunner } from "./hook-runner-global.js";
import { createBeforeInstallHookPayload } from "./install-policy-context.js";
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

async function runBeforeInstallHook(params: {
  logger: InstallScanLogger;
  installLabel: string;
  origin: string;
  sourcePath: string;
  sourcePathKind: "file" | "directory";
  targetName: string;
  targetType: "skill" | "plugin";
  requestKind: PluginInstallRequestKind;
  requestMode: "install" | "update";
  requestedSpecifier?: string;
  builtinScan: BuiltinInstallScan;
  skill?: {
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
  };
  plugin?: {
    contentType: "bundle" | "package" | "file";
    pluginId: string;
    packageName?: string;
    manifestId?: string;
    version?: string;
    extensions?: string[];
  };
}): Promise<InstallSecurityScanResult | undefined> {
  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("before_install")) {
    return undefined;
  }

  try {
    const { event, ctx } = createBeforeInstallHookPayload({
      targetName: params.targetName,
      targetType: params.targetType,
      origin: params.origin,
      sourcePath: params.sourcePath,
      sourcePathKind: params.sourcePathKind,
      request: {
        kind: params.requestKind,
        mode: params.requestMode,
        ...(params.requestedSpecifier ? { requestedSpecifier: params.requestedSpecifier } : {}),
      },
      builtinScan: params.builtinScan,
      ...(params.skill ? { skill: params.skill } : {}),
      ...(params.plugin ? { plugin: params.plugin } : {}),
    });
    const hookResult = await hookRunner.runBeforeInstall(event, ctx);
    if (hookResult?.block) {
      const reason = hookResult.blockReason || "Installation blocked by plugin hook";
      params.logger.warn?.(`WARNING: ${params.installLabel} blocked by plugin hook: ${reason}`);
      return { blocked: { reason } };
    }
    if (hookResult?.findings) {
      for (const finding of hookResult.findings) {
        if (finding.severity === "critical" || finding.severity === "warn") {
          params.logger.warn?.(
            `Plugin scanner: ${finding.message} (${finding.file}:${finding.line})`,
          );
        }
      }
    }
  } catch {
    // Hook errors are non-fatal.
  }

  return undefined;
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

  const hookResult = await runBeforeInstallHook({
    logger: params.logger,
    installLabel: `Bundle "${params.pluginId}" installation`,
    origin: "plugin-bundle",
    sourcePath: params.sourceDir,
    sourcePathKind: "directory",
    targetName: params.pluginId,
    targetType: "plugin",
    requestKind: params.requestKind ?? "plugin-dir",
    requestMode: params.mode ?? "install",
    requestedSpecifier: params.requestedSpecifier,
    builtinScan,
    plugin: {
      contentType: "bundle",
      pluginId: params.pluginId,
      manifestId: params.pluginId,
      ...(params.version ? { version: params.version } : {}),
    },
  });
  return hookResult?.blocked ? hookResult : builtinBlocked;
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

  const hookResult = await runBeforeInstallHook({
    logger: params.logger,
    installLabel: `Plugin "${params.pluginId}" installation`,
    origin: "plugin-package",
    sourcePath: params.packageDir,
    sourcePathKind: "directory",
    targetName: params.pluginId,
    targetType: "plugin",
    requestKind: params.requestKind ?? "plugin-dir",
    requestMode: params.mode ?? "install",
    requestedSpecifier: params.requestedSpecifier,
    builtinScan,
    plugin: {
      contentType: "package",
      pluginId: params.pluginId,
      ...(params.packageName ? { packageName: params.packageName } : {}),
      ...(params.manifestId ? { manifestId: params.manifestId } : {}),
      ...(params.version ? { version: params.version } : {}),
      extensions: params.extensions.slice(),
    },
  });
  return hookResult?.blocked ? hookResult : builtinBlocked;
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

  const hookResult = await runBeforeInstallHook({
    logger: params.logger,
    installLabel: `Plugin file "${params.pluginId}" installation`,
    origin: "plugin-file",
    sourcePath: params.filePath,
    sourcePathKind: "file",
    targetName: params.pluginId,
    targetType: "plugin",
    requestKind: "plugin-file",
    requestMode: params.mode ?? "install",
    requestedSpecifier: params.requestedSpecifier,
    builtinScan,
    plugin: {
      contentType: "file",
      pluginId: params.pluginId,
      extensions: [path.basename(params.filePath)],
    },
  });
  return hookResult?.blocked ? hookResult : builtinBlocked;
}
