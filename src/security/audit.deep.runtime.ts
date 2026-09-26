/** Deep audit implementation for code-safety scans loaded only when requested. */
import path from "node:path";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeStringEntries,
  normalizeTrimmedStringList,
} from "@openclaw/normalization-core/string-normalization";
import { MANIFEST_KEY } from "../compat/legacy-names.js";
import type { OpenClawConfig } from "../config/config.js";
import { readRegularFile, statRegularFile } from "../infra/fs-safe.js";
import { getOrCreatePromise } from "../shared/lazy-promise.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import { loadSkillRootRecords } from "../skills/loading/skill-root-loader.js";
import { loadWorkspaceSkills } from "../skills/loading/workspace-skill-loader.js";
import type { SkillScanFinding } from "../skills/security/scanner.js";
import { resolveWorkshopSkillsDir } from "../skills/workshop/skills-root.js";
import type { SecurityAuditFinding } from "./audit.types.js";
import { listInstalledPluginDirs } from "./installed-plugin-dirs.js";
import { extensionUsesSkippedScannerPath, isPathInside } from "./scan-paths.js";

type SkillScanSummary = Awaited<
  ReturnType<typeof import("../skills/security/scanner.js").scanDirectoryWithSummary>
>;

export type CodeSafetySummaryCache = Map<string, Promise<SkillScanSummary>>;

const loadAgentScopeModule = createLazyRuntimeModule(() => import("../agents/agent-scope.js"));

const loadAgentWorkspaceDirsModule = createLazyRuntimeModule(
  () => import("../agents/workspace-dirs.js"),
);

const loadSkillSourceModule = createLazyRuntimeModule(() => import("../skills/loading/source.js"));

const loadSkillScannerModule = createLazyRuntimeModule(
  () => import("../skills/security/scanner.js"),
);

const MAX_PLUGIN_MANIFEST_BYTES = 1024 * 1024;
// Skill file audit reads are bounded like other audit reads; matches the
// workspace loader's DEFAULT_MAX_SKILL_FILE_BYTES so oversized SKILL.md files
// cannot force an unbounded read during the code-safety scan.
const MAX_SKILL_AUDIT_FILE_BYTES = 256_000;

async function readPluginManifestExtensions(pluginPath: string): Promise<string[]> {
  const manifestPath = path.join(pluginPath, "package.json");
  const statResult = await statRegularFile(manifestPath);
  if (statResult.missing) {
    return [];
  }
  if (statResult.stat.size > MAX_PLUGIN_MANIFEST_BYTES) {
    throw new Error(
      `Plugin manifest at ${manifestPath} is too large (${statResult.stat.size} bytes, max ${MAX_PLUGIN_MANIFEST_BYTES})`,
    );
  }

  const { buffer } = await readRegularFile({
    filePath: manifestPath,
    maxBytes: MAX_PLUGIN_MANIFEST_BYTES,
  });
  const raw = buffer.toString("utf-8");
  if (!raw.trim()) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // Re-throw so callers can surface a security finding for malformed manifests.
    // A malicious plugin could use a malformed package.json to hide declared
    // extension entrypoints from deep scan — callers must not silently drop them.
    throw new Error(`Failed to parse plugin manifest at ${manifestPath}: ${String(err)}`, {
      cause: err,
    });
  }
  return normalizeTrimmedStringList(
    asOptionalRecord(asOptionalRecord(parsed)?.[MANIFEST_KEY])?.extensions,
  );
}

function formatCodeSafetyDetails(findings: SkillScanFinding[], rootDir: string): string {
  return findings
    .map((finding) => {
      const relPath = path.relative(rootDir, finding.file);
      const filePath =
        relPath && relPath !== "." && !relPath.startsWith("..")
          ? relPath
          : path.basename(finding.file);
      const normalizedPath = filePath.replaceAll("\\", "/");
      return `  - [${finding.ruleId}] ${finding.message} (${normalizedPath}:${finding.line})`;
    })
    .join("\n");
}

function buildCodeSafetySummaryCacheKey(params: {
  dirPath: string;
  includeFiles?: string[];
}): string {
  const includeFiles = normalizeStringEntries(params.includeFiles);
  const includeKey = includeFiles.length > 0 ? includeFiles.toSorted().join("\u0000") : "";
  return `${params.dirPath}\u0000${includeKey}`;
}

async function getCodeSafetySummary(params: {
  dirPath: string;
  includeFiles?: string[];
  summaryCache?: CodeSafetySummaryCache;
}): Promise<SkillScanSummary> {
  const cacheKey = buildCodeSafetySummaryCacheKey({
    dirPath: params.dirPath,
    includeFiles: params.includeFiles,
  });
  const scan = async () => {
    const skillScanner = await loadSkillScannerModule();
    return await skillScanner.scanDirectoryWithSummary(params.dirPath, {
      includeFiles: params.includeFiles,
    });
  };
  return params.summaryCache
    ? await getOrCreatePromise(params.summaryCache, cacheKey, scan)
    : await scan();
}

async function getSkillCodeSafetySummary(params: {
  dirPath: string;
  skillFilePath: string;
  summaryCache?: CodeSafetySummaryCache;
}): Promise<SkillScanSummary> {
  const [summary, skillContent, skillScanner] = await Promise.all([
    getCodeSafetySummary({
      dirPath: params.dirPath,
      summaryCache: params.summaryCache,
    }),
    readRegularFile({
      filePath: params.skillFilePath,
      maxBytes: MAX_SKILL_AUDIT_FILE_BYTES,
    }).then(({ buffer }) => buffer.toString("utf-8")),
    loadSkillScannerModule(),
  ]);
  const skillFindings = [
    ...skillScanner.scanSkillContent(skillContent, params.skillFilePath),
    ...skillScanner.scanSource(skillContent, params.skillFilePath),
  ];

  return {
    ...summary,
    scannedFiles: summary.scannedFiles + 1,
    critical:
      summary.critical + skillFindings.filter((finding) => finding.severity === "critical").length,
    warn: summary.warn + skillFindings.filter((finding) => finding.severity === "warn").length,
    info: summary.info + skillFindings.filter((finding) => finding.severity === "info").length,
    findings: [...summary.findings, ...skillFindings],
  };
}

export async function collectPluginsCodeSafetyFindings(params: {
  stateDir: string;
  summaryCache?: CodeSafetySummaryCache;
}): Promise<SecurityAuditFinding[]> {
  const findings: SecurityAuditFinding[] = [];
  const { extensionsDir, pluginDirs } = await listInstalledPluginDirs({
    stateDir: params.stateDir,
    onReadError: (err) => {
      findings.push({
        checkId: "plugins.code_safety.scan_failed",
        severity: "warn",
        title: "Plugin extensions directory scan failed",
        detail: `Static code scan could not list extensions directory: ${String(err)}`,
        remediation:
          "Check file permissions and plugin layout, then rerun `openclaw security audit --deep`.",
      });
    },
  });

  for (const pluginName of pluginDirs) {
    const pluginPath = path.join(extensionsDir, pluginName);
    let extensionEntries: string[] = [];
    try {
      extensionEntries = await readPluginManifestExtensions(pluginPath);
    } catch (manifestErr) {
      // Malformed package.json — surface a warning so the user investigates.
      // A plugin could deliberately corrupt its manifest to hide declared
      // extension entrypoints from the deep code scanner.
      findings.push({
        checkId: "plugins.code_safety.manifest_parse_error",
        severity: "warn",
        title: `Plugin "${pluginName}" has a malformed package.json`,
        detail:
          `Could not parse plugin manifest: ${String(manifestErr)}.\n` +
          "The extension entrypoint list is unavailable. Deep scan will cover the plugin directory but may miss entries declared via `openclaw.extensions`.",
        remediation:
          "Inspect the plugin package.json for syntax errors. If the plugin is untrusted, remove it from your OpenClaw extensions state directory.",
      });
      // Continue — getCodeSafetySummary below still scans the plugin directory
    }
    const forcedScanEntries: string[] = [];
    const escapedEntries: string[] = [];

    for (const entry of extensionEntries) {
      const resolvedEntry = path.resolve(pluginPath, entry);
      if (!isPathInside(pluginPath, resolvedEntry)) {
        escapedEntries.push(entry);
        continue;
      }
      if (extensionUsesSkippedScannerPath(entry)) {
        findings.push({
          checkId: "plugins.code_safety.entry_path",
          severity: "warn",
          title: `Plugin "${pluginName}" entry path is hidden or node_modules`,
          detail: `Extension entry "${entry}" points to a hidden or node_modules path. Deep code scan will cover this entry explicitly, but review this path choice carefully.`,
          remediation: "Prefer extension entrypoints under normal source paths like dist/ or src/.",
        });
      }
      forcedScanEntries.push(resolvedEntry);
    }

    if (escapedEntries.length > 0) {
      findings.push({
        checkId: "plugins.code_safety.entry_escape",
        severity: "critical",
        title: `Plugin "${pluginName}" has extension entry path traversal`,
        detail: `Found extension entries that escape the plugin directory:\n${escapedEntries.map((entry) => `  - ${entry}`).join("\n")}`,
        remediation:
          "Update the plugin manifest so all openclaw.extensions entries stay inside the plugin directory.",
      });
    }

    const summary = await getCodeSafetySummary({
      dirPath: pluginPath,
      includeFiles: forcedScanEntries,
      summaryCache: params.summaryCache,
    }).catch((err: unknown) => {
      findings.push({
        checkId: "plugins.code_safety.scan_failed",
        severity: "warn",
        title: `Plugin "${pluginName}" code scan failed`,
        detail: `Static code scan could not complete: ${String(err)}`,
        remediation:
          "Check file permissions and plugin layout, then rerun `openclaw security audit --deep`.",
      });
      return null;
    });
    if (!summary) {
      continue;
    }
    if (summary.truncated) {
      findings.push({
        checkId: "plugins.code_safety.scan_truncated",
        severity: "warn",
        title: `Plugin "${pluginName}" code scan is incomplete`,
        detail: `Static code scan reached its file or directory-entry budget under ${pluginPath}. Some files were not checked.`,
        remediation:
          "Review the remaining files manually; this bounded scan is not a full code audit.",
      });
    }

    if (summary.critical > 0) {
      const criticalFindings = summary.findings.filter((f) => f.severity === "critical");
      const details = formatCodeSafetyDetails(criticalFindings, pluginPath);

      findings.push({
        checkId: "plugins.code_safety",
        severity: "critical",
        title: `Plugin "${pluginName}" contains dangerous code patterns`,
        detail: `Found ${summary.critical} critical issue(s) in ${summary.scannedFiles} scanned file(s):\n${details}`,
        remediation:
          "Review the plugin source code carefully before use. If untrusted, remove the plugin from your OpenClaw extensions state directory.",
      });
    } else if (summary.warn > 0) {
      const warnFindings = summary.findings.filter((f) => f.severity === "warn");
      const details = formatCodeSafetyDetails(warnFindings, pluginPath);

      findings.push({
        checkId: "plugins.code_safety",
        severity: "warn",
        title: `Plugin "${pluginName}" contains suspicious code patterns`,
        detail: `Found ${summary.warn} warning(s) in ${summary.scannedFiles} scanned file(s):\n${details}`,
        remediation: `Review the flagged code to ensure it is intentional and safe.`,
      });
    }
  }

  return findings;
}

export async function collectInstalledSkillsCodeSafetyFindings(params: {
  cfg: OpenClawConfig;
  stateDir: string;
  workspaceDir?: string;
  summaryCache?: CodeSafetySummaryCache;
}): Promise<SecurityAuditFinding[]> {
  const findings: SecurityAuditFinding[] = [];
  const pluginExtensionsDir = path.join(params.stateDir, "extensions");
  const scannedSkillDirs = new Set<string>();
  const [{ listAgentWorkspaceDirs, listExplicitAgentWorkspaceDirs }, { resolveSkillSource }] =
    await Promise.all([loadAgentWorkspaceDirsModule(), loadSkillSourceModule()]);
  const workspaceDirs = new Set(params.workspaceDir ? [params.workspaceDir] : []);
  try {
    for (const workspaceDir of listAgentWorkspaceDirs(params.cfg)) {
      workspaceDirs.add(workspaceDir);
    }
  } catch {
    // Deep audit accepts raw pre-migration and malformed configs. Continue
    // scanning every entry-authored workspace instead of turning a finding into a crash.
    for (const workspaceDir of listExplicitAgentWorkspaceDirs(params.cfg)) {
      workspaceDirs.add(workspaceDir);
    }
  }
  const entries = [...workspaceDirs].flatMap((workspaceDir) =>
    loadWorkspaceSkills(workspaceDir, { config: params.cfg }),
  );
  const { listAgentIds } = await loadAgentScopeModule();
  const env = { ...process.env, OPENCLAW_STATE_DIR: params.stateDir };
  const reportWorkshopScanFailure = (filePath: string, error: unknown) => {
    findings.push({
      checkId: "skills.code_safety.scan_failed",
      severity: "warn",
      title: "Workshop skill inventory scan failed",
      detail: `Static code scan could not inspect ${filePath}: ${String(error)}`,
      remediation:
        "Check file permissions and skill layout, then rerun `openclaw security audit --deep`.",
    });
  };
  // Installed-code audit includes hidden and shadowed Workshop skills, not only
  // the merged prompt inventory. Prompt discovery limits must not hide installed
  // artifacts from the audit.
  for (const agentId of listAgentIds(params.cfg)) {
    const workshopDir = resolveWorkshopSkillsDir(params.cfg, agentId, env);
    entries.push(
      ...loadSkillRootRecords({
        dir: workshopDir,
        source: "openclaw-workshop",
        config: params.cfg,
        mode: "audit",
        rejectHardlinks: true,
        onDiagnostic: ({ path: filePath, message }) => reportWorkshopScanFailure(filePath, message),
      }),
    );
  }
  for (const entry of entries) {
    if (resolveSkillSource(entry.skill) === "openclaw-bundled") {
      continue;
    }

    const skillDir = path.resolve(entry.skill.baseDir);
    if (isPathInside(pluginExtensionsDir, skillDir)) {
      // Plugin code is already covered by plugins.code_safety checks.
      continue;
    }
    if (scannedSkillDirs.has(skillDir)) {
      continue;
    }
    scannedSkillDirs.add(skillDir);

    const skillName = entry.skill.name;
    const summary = await getSkillCodeSafetySummary({
      dirPath: skillDir,
      skillFilePath: entry.skill.filePath,
      summaryCache: params.summaryCache,
    }).catch((err: unknown) => {
      findings.push({
        checkId: "skills.code_safety.scan_failed",
        severity: "warn",
        title: `Skill "${skillName}" code scan failed`,
        detail: `Static code scan could not complete for ${skillDir}: ${String(err)}`,
        remediation:
          "Check file permissions and skill layout, then rerun `openclaw security audit --deep`.",
      });
      return null;
    });
    if (!summary) {
      continue;
    }
    if (summary.truncated) {
      findings.push({
        checkId: "skills.code_safety.scan_truncated",
        severity: "warn",
        title: `Skill "${skillName}" code scan is incomplete`,
        detail: `Static code scan reached its file or directory-entry budget under ${skillDir}. Some files were not checked.`,
        remediation:
          "Review the remaining files manually; this bounded scan is not a full code audit.",
      });
    }

    if (summary.critical > 0) {
      const criticalFindings = summary.findings.filter(
        (finding) => finding.severity === "critical",
      );
      const details = formatCodeSafetyDetails(criticalFindings, skillDir);
      findings.push({
        checkId: "skills.code_safety",
        severity: "critical",
        title: `Skill "${skillName}" contains dangerous code patterns`,
        detail: `Found ${summary.critical} critical issue(s) in ${summary.scannedFiles} scanned file(s) under ${skillDir}:\n${details}`,
        remediation: `Review the skill source code before use. If untrusted, remove "${skillDir}".`,
      });
    } else if (summary.warn > 0) {
      const warnFindings = summary.findings.filter((finding) => finding.severity === "warn");
      const details = formatCodeSafetyDetails(warnFindings, skillDir);
      findings.push({
        checkId: "skills.code_safety",
        severity: "warn",
        title: `Skill "${skillName}" contains suspicious code patterns`,
        detail: `Found ${summary.warn} warning(s) in ${summary.scannedFiles} scanned file(s) under ${skillDir}:\n${details}`,
        remediation: "Review flagged lines to ensure the behavior is intentional and safe.",
      });
    }
  }

  return findings;
}
