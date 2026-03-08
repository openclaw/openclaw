import fsPromises from "node:fs/promises";
import path from "node:path";
import { listAgentIds, resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { loadConfig } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/config.js";
import { loadSessionStore } from "../../config/sessions.js";
import { checkTokenDrift } from "../../daemon/service-audit.js";
import { resolveGatewayService } from "../../daemon/service.js";
import type { RuntimeEnv } from "../../runtime.js";
import { resolveUserPath } from "../../utils.js";
import { resolveSessionStoreTargets } from "../session-store-targets.js";
import { validateManifest } from "./manifest.js";

export type MigrateDoctorOptions = {
  bundle?: string;
  json?: boolean;
};

type DoctorIssue = {
  code: string;
  message: string;
  detail?: string;
  fix?: string;
};

/** Returns true if path looks like a macOS home dir prefix on a non-macOS system, or vice-versa. */
function detectForeignOsPrefix(p: string): string | null {
  const resolved = resolveUserPath(p);
  if (process.platform !== "darwin" && resolved.startsWith("/Users/")) {
    return "/Users/";
  }
  if (process.platform === "darwin" && resolved.startsWith("/home/")) {
    // Unusual but flag it for review
    return "/home/";
  }
  // Also check for Windows-style paths on non-Windows
  if (process.platform !== "win32" && /^[A-Za-z]:[/\\]/.test(resolved)) {
    return resolved.slice(0, 3);
  }
  return null;
}

async function checkWorkspacePaths(cfg: OpenClawConfig): Promise<DoctorIssue[]> {
  const issues: DoctorIssue[] = [];
  const agentIds = listAgentIds(cfg);

  for (const agentId of agentIds) {
    const wsDir = resolveAgentWorkspaceDir(cfg, agentId);
    const foreignPrefix = detectForeignOsPrefix(wsDir);
    if (foreignPrefix) {
      issues.push({
        code: "workspace-foreign-path",
        message: `Agent "${agentId}" workspace path starts with ${foreignPrefix} which looks like a foreign OS path`,
        detail: wsDir,
        fix: `qverisbot config set agents.defaults.workspace ~/.openclaw/workspace`,
      });
      continue;
    }

    // Check if workspace exists and is accessible
    try {
      const stat = await fsPromises.stat(wsDir);
      if (!stat.isDirectory()) {
        issues.push({
          code: "workspace-not-directory",
          message: `Agent "${agentId}" workspace path exists but is not a directory`,
          detail: wsDir,
        });
      }
    } catch {
      // Workspace doesn't exist yet - this is OK for fresh installs
      // but report if it has suspicious chars
    }
  }

  // Also check agents.defaults.workspace explicitly
  const defaultWs = cfg.agents?.defaults?.workspace?.trim();
  if (defaultWs) {
    const foreignPrefix = detectForeignOsPrefix(defaultWs);
    if (foreignPrefix) {
      issues.push({
        code: "config-defaults-workspace-foreign-path",
        message: `agents.defaults.workspace starts with ${foreignPrefix} which looks like a foreign OS path`,
        detail: defaultWs,
        fix: `qverisbot config set agents.defaults.workspace ~/.openclaw/workspace`,
      });
    }
  }

  // Check agents.list[].workspace
  const list = cfg.agents?.list ?? [];
  for (const entry of list) {
    const ws = (entry as { workspace?: unknown }).workspace;
    if (typeof ws === "string" && ws.trim()) {
      const foreignPrefix = detectForeignOsPrefix(ws);
      if (foreignPrefix) {
        const id = (entry as { id?: unknown }).id;
        issues.push({
          code: "config-agent-workspace-foreign-path",
          message: `Agent "${String(id)}" workspace in config starts with ${foreignPrefix} which looks like a foreign OS path`,
          detail: ws,
          fix: `qverisbot agents config --agent ${String(id)} --workspace ~/.openclaw/workspace-${String(id)}`,
        });
      }
    }
  }

  return issues;
}

async function checkSessionPoison(cfg: OpenClawConfig): Promise<DoctorIssue[]> {
  const issues: DoctorIssue[] = [];

  let targets: { agentId: string; storePath: string }[];
  try {
    targets = resolveSessionStoreTargets(cfg, { allAgents: true });
  } catch {
    return issues;
  }

  for (const target of targets) {
    let store: Record<string, { sessionId?: string; sessionFile?: string }>;
    try {
      store = loadSessionStore(target.storePath);
    } catch {
      continue;
    }

    let poisonedCount = 0;
    for (const [, entry] of Object.entries(store)) {
      const sessionFile = entry?.sessionFile;
      if (typeof sessionFile === "string" && sessionFile.trim()) {
        const foreignPrefix = detectForeignOsPrefix(sessionFile);
        if (foreignPrefix) {
          poisonedCount++;
        }
      }
    }

    if (poisonedCount > 0) {
      issues.push({
        code: "session-store-path-poison",
        message: `Session store for agent "${target.agentId}" has ${poisonedCount} entry/entries with foreign OS paths in sessionFile`,
        detail: target.storePath,
        fix: `qverisbot migrate import <bundle> (sessions will be reset) or: qverisbot sessions cleanup --agent ${target.agentId}`,
      });
    }
  }

  return issues;
}

async function checkGatewayTokenDrift(): Promise<DoctorIssue[]> {
  const issues: DoctorIssue[] = [];
  try {
    const { resolveIsNixMode } = await import("../../config/paths.js");
    if (resolveIsNixMode(process.env)) {
      return issues;
    }

    const cfg = loadConfig();
    const configToken =
      typeof cfg.gateway?.auth?.token === "string" ? cfg.gateway.auth.token.trim() : undefined;

    const service = resolveGatewayService();
    const command = await service.readCommand(process.env);
    const serviceToken = command?.environment?.OPENCLAW_GATEWAY_TOKEN?.trim();

    const drift = checkTokenDrift({ serviceToken, configToken });
    if (drift) {
      issues.push({
        code: drift.code,
        message: drift.message,
        detail: drift.detail,
        fix: "qverisbot gateway install --force",
      });
    }
  } catch {
    // Token drift check is best-effort; service may not be installed
  }
  return issues;
}

async function validateBundleFile(bundlePath: string): Promise<DoctorIssue[]> {
  const issues: DoctorIssue[] = [];
  const { extractArchive, readJsonFile } = await import("../../infra/archive.js");
  const fsTemp = await import("node:fs/promises");
  const osMod = await import("node:os");
  const extractDir = await fsTemp.mkdtemp(path.join(osMod.tmpdir(), "qverisbot-doctor-"));
  try {
    await extractArchive({
      archivePath: resolveUserPath(bundlePath),
      destDir: extractDir,
      timeoutMs: 30_000,
    });
    const manifestPath = path.join(extractDir, "manifest.json");
    try {
      const raw = await readJsonFile<unknown>(manifestPath);
      validateManifest(raw);
    } catch (err) {
      issues.push({
        code: "bundle-invalid-manifest",
        message: `Bundle manifest validation failed: ${String(err)}`,
        detail: bundlePath,
      });
    }
  } catch (err) {
    issues.push({
      code: "bundle-extract-failed",
      message: `Could not extract bundle: ${String(err)}`,
      detail: bundlePath,
    });
  } finally {
    await fsTemp.rm(extractDir, { recursive: true, force: true }).catch(() => undefined);
  }
  return issues;
}

export async function migrateDoctor(
  runtime: RuntimeEnv,
  opts: MigrateDoctorOptions,
): Promise<void> {
  const cfg = loadConfig();
  const allIssues: DoctorIssue[] = [];

  // 1. Workspace path checks
  const wsIssues = await checkWorkspacePaths(cfg);
  allIssues.push(...wsIssues);

  // 2. Session poison scan
  const sessIssues = await checkSessionPoison(cfg);
  allIssues.push(...sessIssues);

  // 3. Gateway token drift
  const tokenIssues = await checkGatewayTokenDrift();
  allIssues.push(...tokenIssues);

  // 4. Optional bundle validation
  if (opts.bundle) {
    const bundleIssues = await validateBundleFile(opts.bundle);
    allIssues.push(...bundleIssues);
  }

  if (opts.json) {
    runtime.log(JSON.stringify({ ok: allIssues.length === 0, issues: allIssues }, null, 2));
    return;
  }

  if (allIssues.length === 0) {
    runtime.log("No migration issues detected.");
    return;
  }

  runtime.log(`Found ${allIssues.length} issue(s):\n`);
  for (const issue of allIssues) {
    runtime.log(`[${issue.code}] ${issue.message}`);
    if (issue.detail) {
      runtime.log(`  Detail: ${issue.detail}`);
    }
    if (issue.fix) {
      runtime.log(`  Fix:    ${issue.fix}`);
    }
    runtime.log("");
  }
}
