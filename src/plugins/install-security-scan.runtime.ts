import path from "node:path";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  runInstallPolicy,
  type InstallPolicyFinding,
  type InstallPolicyOrigin,
  type InstallPolicyRequestKind,
  type InstallPolicySource,
} from "../security/install-policy.js";
import { getGlobalHookRunner } from "./hook-runner-global.js";
import { createBeforeInstallHookPayload } from "./install-policy-context.js";
import type { InstallSafetyOverrides } from "./install-security-scan.types.js";

type InstallScanLogger = {
  warn?: (message: string) => void;
};

const FULL_GIT_COMMIT_PATTERN = /^[0-9a-f]{40}$/i;

type PluginInstallRequestKind = Exclude<InstallPolicyRequestKind, "skill-install">;

function formatInstallPolicyWarning(finding: InstallPolicyFinding): string {
  const location = finding.file
    ? ` (${finding.file}${finding.line ? `:${finding.line}` : ""})`
    : "";
  return `Install policy: ${finding.message}${location}`;
}

type InstallScanFinding = {
  ruleId: string;
  severity: "info" | "warn" | "critical";
  file: string;
  line: number;
  message: string;
  evidence?: string;
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

type PackageExecutableScanMetadata = {
  runtimeExtensions?: readonly string[];
  runtimeSetupEntry?: string;
  setupEntry?: string;
};

type SkillInstallSpec = {
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

export type InstallSecurityScanResult = {
  blocked?: {
    code?: "security_scan_blocked" | "security_scan_failed";
    reason: string;
  };
};

async function runBeforeInstallHook(params: {
  logger: InstallScanLogger;
  installLabel: string;
  origin: string;
  sourcePath: string;
  sourcePathKind: "file" | "directory";
  source?: InstallPolicySource;
  targetName: string;
  targetType: "skill" | "plugin";
  requestKind: InstallPolicyRequestKind;
  requestMode: "install" | "update";
  requestedSpecifier?: string;
  builtinScan?: BuiltinInstallScan;
  skill?: {
    installId: string;
    installSpec?: SkillInstallSpec;
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
      return { blocked: { code: "security_scan_blocked", reason } };
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
  } catch (err) {
    const reason = `Installation blocked because before_install hook failed: ${formatErrorMessage(err)}`;
    params.logger.warn?.(
      `WARNING: ${params.installLabel} blocked by plugin hook failure: ${reason}`,
    );
    return { blocked: { code: "security_scan_failed", reason } };
  }

  return undefined;
}

function formatInstallPolicyOriginForHook(origin: InstallPolicyOrigin): string {
  const type = typeof origin.type === "string" ? origin.type : "unknown";
  if (type === "upload") {
    return "skill-upload";
  }
  const spec = typeof origin.spec === "string" ? origin.spec : undefined;
  const slug = typeof origin.slug === "string" ? origin.slug : undefined;
  return spec ?? slug ?? type;
}

function isMutableGitOrigin(origin: InstallPolicyOrigin | undefined): boolean {
  const ref = typeof origin?.ref === "string" ? origin.ref : undefined;
  return !FULL_GIT_COMMIT_PATTERN.test(ref ?? "");
}

function resolvePolicySource(params: {
  requestKind: InstallPolicyRequestKind;
  origin?: InstallPolicyOrigin;
}): InstallPolicySource {
  if (params.requestKind === "skill-install") {
    switch (params.origin?.type) {
      case "clawhub":
        return { kind: "clawhub", authority: "openclaw", mutable: false, network: true };
      case "git":
        return {
          kind: "git",
          authority: "third-party",
          mutable: isMutableGitOrigin(params.origin),
          network: true,
        };
      case "path":
        return { kind: "local-path", authority: "user", mutable: true, network: false };
      case "upload":
        return { kind: "upload", authority: "user", mutable: false, network: false };
      case "openclaw-bundled":
        return { kind: "bundled", authority: "openclaw", mutable: false, network: false };
      case "openclaw-managed":
      case "openclaw-extra":
        return { kind: "managed", authority: "openclaw", mutable: false, network: false };
      default:
        return { kind: "workspace", authority: "user", mutable: true, network: false };
    }
  }

  switch (params.requestKind) {
    case "plugin-archive":
      return { kind: "archive", authority: "third-party", mutable: true, network: false };
    case "plugin-file":
      return { kind: "file", authority: "user", mutable: true, network: false };
    case "plugin-git":
      return { kind: "git", authority: "third-party", mutable: true, network: true };
    case "plugin-npm":
      return { kind: "npm", authority: "third-party", mutable: false, network: true };
    case "plugin-dir":
      return { kind: "local-path", authority: "user", mutable: true, network: false };
  }
  return { kind: "local-path", authority: "unknown", mutable: true, network: false };
}

async function runOperatorInstallPolicy(params: {
  config?: OpenClawConfig;
  logger: InstallScanLogger;
  origin: InstallPolicyOrigin;
  source?: InstallPolicySource;
  sourcePath: string;
  sourcePathKind: "file" | "directory";
  targetName: string;
  targetType: "skill" | "plugin";
  requestKind: InstallPolicyRequestKind;
  requestMode: "install" | "update";
  requestedSpecifier?: string;
  skill?: {
    installId: string;
    installSpec?: SkillInstallSpec;
  };
  plugin?: {
    contentType: "bundle" | "package" | "file" | "dependency-tree";
    pluginId: string;
    packageName?: string;
    manifestId?: string;
    version?: string;
    extensions?: string[];
  };
}): Promise<InstallSecurityScanResult | undefined> {
  const result = await runInstallPolicy({
    config: params.config,
    logger: params.logger,
    request: {
      targetName: params.targetName,
      targetType: params.targetType,
      sourcePath: params.sourcePath,
      sourcePathKind: params.sourcePathKind,
      ...(params.source ? { source: params.source } : {}),
      origin: params.origin,
      request: {
        kind: params.requestKind,
        mode: params.requestMode,
        ...(params.requestedSpecifier ? { requestedSpecifier: params.requestedSpecifier } : {}),
      },
      ...(params.skill ? { skill: params.skill } : {}),
      ...(params.plugin ? { plugin: params.plugin } : {}),
    },
  });
  if (!result?.blocked) {
    for (const finding of result?.findings ?? []) {
      if (finding.severity === "critical" || finding.severity === "warn") {
        params.logger.warn?.(formatInstallPolicyWarning(finding));
      }
    }
    return undefined;
  }
  return { blocked: result.blocked };
}

export async function scanBundleInstallSourceRuntime(
  params: InstallSafetyOverrides & {
    config?: OpenClawConfig;
    logger: InstallScanLogger;
    pluginId: string;
    sourceDir: string;
    requestKind?: PluginInstallRequestKind;
    requestedSpecifier?: string;
    mode?: "install" | "update";
    version?: string;
    source?: InstallPolicySource;
  },
): Promise<InstallSecurityScanResult | undefined> {
  const policyResult = await runOperatorInstallPolicy({
    config: params.config,
    logger: params.logger,
    origin: { type: "plugin-bundle", ...(params.version ? { version: params.version } : {}) },
    source:
      params.source ?? resolvePolicySource({ requestKind: params.requestKind ?? "plugin-dir" }),
    sourcePath: params.sourceDir,
    sourcePathKind: "directory",
    targetName: params.pluginId,
    targetType: "plugin",
    requestKind: params.requestKind ?? "plugin-dir",
    requestMode: params.mode ?? "install",
    requestedSpecifier: params.requestedSpecifier,
    plugin: {
      contentType: "bundle",
      pluginId: params.pluginId,
      manifestId: params.pluginId,
      ...(params.version ? { version: params.version } : {}),
    },
  });
  if (policyResult?.blocked) {
    return policyResult;
  }

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
    plugin: {
      contentType: "bundle",
      pluginId: params.pluginId,
      manifestId: params.pluginId,
      ...(params.version ? { version: params.version } : {}),
    },
  });
  return hookResult;
}

export async function scanPackageInstallSourceRuntime(
  params: InstallSafetyOverrides & {
    config?: OpenClawConfig;
    extensions: string[];
    logger: InstallScanLogger;
    packageDir: string;
    packageMetadata?: PackageExecutableScanMetadata;
    pluginId: string;
    requestKind?: PluginInstallRequestKind;
    requestedSpecifier?: string;
    mode?: "install" | "update";
    packageName?: string;
    manifestId?: string;
    version?: string;
    source?: InstallPolicySource;
  },
): Promise<InstallSecurityScanResult | undefined> {
  const policyResult = await runOperatorInstallPolicy({
    config: params.config,
    logger: params.logger,
    origin: {
      type: "plugin-package",
      ...(params.packageName ? { packageName: params.packageName } : {}),
      ...(params.version ? { version: params.version } : {}),
    },
    source:
      params.source ?? resolvePolicySource({ requestKind: params.requestKind ?? "plugin-dir" }),
    sourcePath: params.packageDir,
    sourcePathKind: "directory",
    targetName: params.pluginId,
    targetType: "plugin",
    requestKind: params.requestKind ?? "plugin-dir",
    requestMode: params.mode ?? "install",
    requestedSpecifier: params.requestedSpecifier,
    plugin: {
      contentType: "package",
      pluginId: params.pluginId,
      ...(params.packageName ? { packageName: params.packageName } : {}),
      ...(params.manifestId ? { manifestId: params.manifestId } : {}),
      ...(params.version ? { version: params.version } : {}),
      extensions: params.extensions.slice(),
    },
  });
  if (policyResult?.blocked) {
    return policyResult;
  }

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
    plugin: {
      contentType: "package",
      pluginId: params.pluginId,
      ...(params.packageName ? { packageName: params.packageName } : {}),
      ...(params.manifestId ? { manifestId: params.manifestId } : {}),
      ...(params.version ? { version: params.version } : {}),
      extensions: params.extensions.slice(),
    },
  });
  return hookResult;
}

export async function scanInstalledPackageDependencyTreeRuntime(params: {
  additionalPackageDirs?: string[];
  allowManagedNpmRootPackagePeerSymlinks?: boolean;
  config?: OpenClawConfig;
  dangerouslyForceUnsafeInstall?: boolean;
  dependencyScanRootDir?: string;
  logger: InstallScanLogger;
  mode?: "install" | "update";
  packageDir: string;
  pluginId: string;
  requestKind?: PluginInstallRequestKind;
  requestedSpecifier?: string;
  source?: InstallPolicySource;
  trustedSourceLinkedOfficialInstall?: boolean;
}): Promise<InstallSecurityScanResult | undefined> {
  const requestKind = params.requestKind ?? "plugin-npm";
  return await runOperatorInstallPolicy({
    config: params.config,
    logger: params.logger,
    origin: { type: "plugin-dependency-tree" },
    source: params.source ?? resolvePolicySource({ requestKind }),
    sourcePath: params.dependencyScanRootDir ?? params.packageDir,
    sourcePathKind: "directory",
    targetName: params.pluginId,
    targetType: "plugin",
    requestKind,
    requestMode: params.mode ?? "install",
    requestedSpecifier: params.requestedSpecifier,
    plugin: {
      contentType: "dependency-tree",
      pluginId: params.pluginId,
    },
  });
}

export async function scanFileInstallSourceRuntime(
  params: InstallSafetyOverrides & {
    config?: OpenClawConfig;
    filePath: string;
    logger: InstallScanLogger;
    mode?: "install" | "update";
    pluginId: string;
    requestedSpecifier?: string;
    source?: InstallPolicySource;
  },
): Promise<InstallSecurityScanResult | undefined> {
  const policyResult = await runOperatorInstallPolicy({
    config: params.config,
    logger: params.logger,
    origin: { type: "plugin-file" },
    source: params.source ?? resolvePolicySource({ requestKind: "plugin-file" }),
    sourcePath: params.filePath,
    sourcePathKind: "file",
    targetName: params.pluginId,
    targetType: "plugin",
    requestKind: "plugin-file",
    requestMode: params.mode ?? "install",
    requestedSpecifier: params.requestedSpecifier,
    plugin: {
      contentType: "file",
      pluginId: params.pluginId,
      extensions: [path.basename(params.filePath)],
    },
  });
  if (policyResult?.blocked) {
    return policyResult;
  }

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
    plugin: {
      contentType: "file",
      pluginId: params.pluginId,
      extensions: [path.basename(params.filePath)],
    },
  });
  return hookResult;
}

export async function preflightPluginNpmInstallPolicyRuntime(params: {
  config?: OpenClawConfig;
  logger: InstallScanLogger;
  mode?: "install" | "update";
  packageName: string;
  pluginId?: string;
  requestedSpecifier?: string;
  source?: InstallPolicySource;
  sourcePath: string;
  sourcePathKind: "file" | "directory";
}): Promise<InstallSecurityScanResult | undefined> {
  const pluginId = params.pluginId ?? params.packageName;
  return await runOperatorInstallPolicy({
    config: params.config,
    logger: params.logger,
    origin: { type: "plugin-npm", packageName: params.packageName },
    source: params.source ?? resolvePolicySource({ requestKind: "plugin-npm" }),
    sourcePath: params.sourcePath,
    sourcePathKind: params.sourcePathKind,
    targetName: pluginId,
    targetType: "plugin",
    requestKind: "plugin-npm",
    requestMode: params.mode ?? "install",
    requestedSpecifier: params.requestedSpecifier,
    plugin: {
      contentType: "package",
      pluginId,
      packageName: params.packageName,
    },
  });
}

export async function preflightPluginGitInstallPolicyRuntime(params: {
  config?: OpenClawConfig;
  logger: InstallScanLogger;
  mode?: "install" | "update";
  pluginId: string;
  requestedSpecifier?: string;
  source?: InstallPolicySource;
  sourcePath: string;
}): Promise<InstallSecurityScanResult | undefined> {
  return await runOperatorInstallPolicy({
    config: params.config,
    logger: params.logger,
    origin: { type: "plugin-git" },
    source: params.source ?? resolvePolicySource({ requestKind: "plugin-git" }),
    sourcePath: params.sourcePath,
    sourcePathKind: "directory",
    targetName: params.pluginId,
    targetType: "plugin",
    requestKind: "plugin-git",
    requestMode: params.mode ?? "install",
    requestedSpecifier: params.requestedSpecifier,
    plugin: {
      contentType: "package",
      pluginId: params.pluginId,
    },
  });
}

export async function evaluateSkillInstallPolicyRuntime(params: {
  config?: OpenClawConfig;
  installId: string;
  installSpec?: SkillInstallSpec;
  logger: InstallScanLogger;
  origin: InstallPolicyOrigin;
  requestedSpecifier?: string;
  source?: InstallPolicySource;
  mode?: "install" | "update";
  skillName: string;
  sourceDir: string;
}): Promise<InstallSecurityScanResult | undefined> {
  const policyResult = await runOperatorInstallPolicy({
    config: params.config,
    logger: params.logger,
    origin: params.origin,
    source:
      params.source ?? resolvePolicySource({ requestKind: "skill-install", origin: params.origin }),
    sourcePath: params.sourceDir,
    sourcePathKind: "directory",
    targetName: params.skillName,
    targetType: "skill",
    requestKind: "skill-install",
    requestMode: params.mode ?? "install",
    requestedSpecifier: params.requestedSpecifier,
    skill: {
      installId: params.installId,
      ...(params.installSpec ? { installSpec: params.installSpec } : {}),
    },
  });
  if (policyResult?.blocked) {
    return policyResult;
  }

  const hookResult = await runBeforeInstallHook({
    logger: params.logger,
    installLabel: `Skill "${params.skillName}" installation`,
    origin: formatInstallPolicyOriginForHook(params.origin),
    sourcePath: params.sourceDir,
    sourcePathKind: "directory",
    targetName: params.skillName,
    targetType: "skill",
    requestKind: "skill-install",
    requestMode: params.mode ?? "install",
    requestedSpecifier: params.requestedSpecifier,
    skill: {
      installId: params.installId,
      ...(params.installSpec ? { installSpec: params.installSpec } : {}),
    },
  });
  return hookResult;
}
