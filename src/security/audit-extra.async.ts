/**
 * Asynchronous security audit collector functions.
 *
 * These functions perform I/O (filesystem, config reads) to detect security issues.
 */
import path from "node:path";
import { clearTimeout as clearNodeTimeout, setTimeout as setNodeTimeout } from "node:timers";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { resolveAuthProfileDatabaseFilePaths } from "../agents/auth-profiles/sqlite.js";
import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig, ConfigFileSnapshot } from "../config/config.js";
import { collectIncludePathsRecursive } from "../config/includes-scan.js";
import { resolveOAuthDir } from "../config/paths.js";
import { LEGACY_IMPLICIT_AGENT_ID, normalizeAgentId } from "../routing/session-key.js";
import { createLazyRuntimeModule, createLazyRuntimeNamedExport } from "../shared/lazy-runtime.js";
import type { SecurityAuditFinding } from "./audit.types.js";
import type { ExecFn } from "./windows-acl.js";

type ExecDockerRawFn = (
  args: string[],
  opts?: { allowFailure?: boolean; input?: Buffer | string; signal?: AbortSignal },
) => Promise<import("../agents/sandbox/docker.js").ExecDockerRawResult>;

const DEFAULT_SANDBOX_BROWSER_DOCKER_PROBE_TIMEOUT_MS = 5000;

const loadConfigModule = createLazyRuntimeModule(() => import("../config/config.js"));

const loadAuditFsModule = createLazyRuntimeModule(() => import("./audit-fs.js"));

const loadAgentScopeModule = createLazyRuntimeModule(() => import("../agents/agent-scope.js"));

const loadExecDockerRaw = createLazyRuntimeNamedExport(
  () => import("../agents/sandbox/docker.js"),
  "execDockerRaw",
) satisfies () => Promise<ExecDockerRawFn>;

const loadSandboxBrowserSecurityHashEpoch = createLazyRuntimeNamedExport(
  () => import("../agents/sandbox/constants.js"),
  "SANDBOX_BROWSER_SECURITY_HASH_EPOCH",
);

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function expandTilde(p: string, env: NodeJS.ProcessEnv): string | null {
  if (!p.startsWith("~")) {
    return p;
  }
  const home = normalizeOptionalString(env.HOME) ?? null;
  if (!home) {
    return null;
  }
  if (p === "~") {
    return home;
  }
  if (p.startsWith("~/") || p.startsWith("~\\")) {
    return path.join(home, p.slice(2));
  }
  return null;
}

// --------------------------------------------------------------------------
// Exported collectors
// --------------------------------------------------------------------------

function normalizeDockerLabelValue(raw: string | undefined): string | null {
  const trimmed = normalizeOptionalString(raw) ?? "";
  if (!trimmed || trimmed === "<no value>") {
    return null;
  }
  return trimmed;
}

class DockerProbeTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Docker probe timed out after ${timeoutMs}ms`);
    this.name = "DockerProbeTimeoutError";
  }
}

function normalizeDockerProbeTimeoutMs(timeoutMs: number | undefined): number {
  if (Number.isFinite(timeoutMs) && timeoutMs !== undefined) {
    return Math.max(250, Math.floor(timeoutMs));
  }
  return DEFAULT_SANDBOX_BROWSER_DOCKER_PROBE_TIMEOUT_MS;
}

async function withDockerProbeTimeout<T>(
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setNodeTimeout> | undefined;
  let timedOut = false;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setNodeTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new DockerProbeTimeoutError(timeoutMs));
    }, timeoutMs);
  });
  try {
    return await Promise.race([run(controller.signal), timeoutPromise]);
  } catch (err) {
    if (timedOut || controller.signal.aborted) {
      throw new DockerProbeTimeoutError(timeoutMs);
    }
    throw err;
  } finally {
    if (timeout) {
      clearNodeTimeout(timeout);
    }
  }
}

function isDockerProbeTimeoutError(error: unknown): boolean {
  return error instanceof DockerProbeTimeoutError;
}

async function listSandboxBrowserContainers(params: {
  execDockerRawFn: ExecDockerRawFn;
  timeoutMs: number;
  onTimeout?: () => void;
}): Promise<string[] | null> {
  try {
    const result = await withDockerProbeTimeout(params.timeoutMs, (signal) =>
      params.execDockerRawFn(
        ["ps", "-a", "--filter", "label=openclaw.sandboxBrowser=1", "--format", "{{.Names}}"],
        { allowFailure: true, signal },
      ),
    );
    if (result.code !== 0) {
      return null;
    }
    return normalizeStringEntries(result.stdout.toString("utf8").split(/\r?\n/));
  } catch (err) {
    if (isDockerProbeTimeoutError(err)) {
      params.onTimeout?.();
    }
    return null;
  }
}

async function readSandboxBrowserHashLabels(params: {
  containerName: string;
  execDockerRawFn: ExecDockerRawFn;
  timeoutMs: number;
  onTimeout?: () => void;
}): Promise<{ configHash: string | null; epoch: string | null } | null> {
  try {
    const result = await withDockerProbeTimeout(params.timeoutMs, (signal) =>
      params.execDockerRawFn(
        [
          "inspect",
          "-f",
          '{{ index .Config.Labels "openclaw.configHash" }}\t{{ index .Config.Labels "openclaw.browserConfigEpoch" }}',
          params.containerName,
        ],
        { allowFailure: true, signal },
      ),
    );
    if (result.code !== 0) {
      return null;
    }
    const [hashRaw, epochRaw] = result.stdout.toString("utf8").split("\t");
    return {
      configHash: normalizeDockerLabelValue(hashRaw),
      epoch: normalizeDockerLabelValue(epochRaw),
    };
  } catch (err) {
    if (isDockerProbeTimeoutError(err)) {
      params.onTimeout?.();
    }
    return null;
  }
}

function parsePublishedHostFromDockerPortLine(line: string): string | null {
  const trimmed = normalizeOptionalString(line) ?? "";
  const rhs = trimmed.includes("->")
    ? (normalizeOptionalString(trimmed.split("->").at(-1)) ?? "")
    : trimmed;
  if (!rhs) {
    return null;
  }
  const bracketHost = rhs.match(/^\[([^\]]+)\]:\d+$/);
  if (bracketHost?.[1]) {
    return bracketHost[1];
  }
  const hostPort = rhs.match(/^([^:]+):\d+$/);
  if (hostPort?.[1]) {
    return hostPort[1];
  }
  return null;
}

function isLoopbackPublishHost(host: string): boolean {
  const normalized = normalizeOptionalLowercaseString(host);
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "localhost";
}

async function readSandboxBrowserPortMappings(params: {
  containerName: string;
  execDockerRawFn: ExecDockerRawFn;
  timeoutMs: number;
  onTimeout?: () => void;
}): Promise<string[] | null> {
  try {
    const result = await withDockerProbeTimeout(params.timeoutMs, (signal) =>
      params.execDockerRawFn(["port", params.containerName], {
        allowFailure: true,
        signal,
      }),
    );
    if (result.code !== 0) {
      return null;
    }
    return normalizeStringEntries(result.stdout.toString("utf8").split(/\r?\n/));
  } catch (err) {
    if (isDockerProbeTimeoutError(err)) {
      params.onTimeout?.();
    }
    return null;
  }
}

export async function collectSandboxBrowserHashLabelFindings(params?: {
  execDockerRawFn?: ExecDockerRawFn;
  timeoutMs?: number;
}): Promise<SecurityAuditFinding[]> {
  const findings: SecurityAuditFinding[] = [];
  const timeoutMs = normalizeDockerProbeTimeoutMs(params?.timeoutMs);
  let timedOut = false;
  const markTimedOut = () => {
    timedOut = true;
  };
  const [execFn, browserHashEpoch] = await Promise.all([
    params?.execDockerRawFn ? Promise.resolve(params.execDockerRawFn) : loadExecDockerRaw(),
    loadSandboxBrowserSecurityHashEpoch(),
  ]);
  const containers = await listSandboxBrowserContainers({
    execDockerRawFn: execFn,
    timeoutMs,
    onTimeout: markTimedOut,
  });
  if (!containers || containers.length === 0) {
    if (timedOut) {
      findings.push(buildSandboxBrowserDockerProbeTimeoutFinding(timeoutMs));
    }
    return findings;
  }

  const missingHash: string[] = [];
  const staleEpoch: string[] = [];
  const nonLoopbackPublished: string[] = [];

  for (const containerName of containers) {
    const labels = await readSandboxBrowserHashLabels({
      containerName,
      execDockerRawFn: execFn,
      timeoutMs,
      onTimeout: markTimedOut,
    });
    if (timedOut) {
      break;
    }
    if (!labels) {
      continue;
    }
    if (!labels.configHash) {
      missingHash.push(containerName);
    }
    if (labels.epoch !== browserHashEpoch) {
      staleEpoch.push(containerName);
    }
    const portMappings = await readSandboxBrowserPortMappings({
      containerName,
      execDockerRawFn: execFn,
      timeoutMs,
      onTimeout: markTimedOut,
    });
    if (timedOut) {
      break;
    }
    if (!portMappings?.length) {
      continue;
    }
    const exposedMappings = portMappings.filter((line) => {
      const host = parsePublishedHostFromDockerPortLine(line);
      return Boolean(host && !isLoopbackPublishHost(host));
    });
    if (exposedMappings.length > 0) {
      nonLoopbackPublished.push(`${containerName} (${exposedMappings.join("; ")})`);
    }
  }

  if (missingHash.length > 0) {
    findings.push({
      checkId: "sandbox.browser_container.hash_label_missing",
      severity: "warn",
      title: "Sandbox browser container missing config hash label",
      detail:
        `Containers: ${missingHash.join(", ")}. ` +
        "These browser containers predate hash-based drift checks and may miss security remediations until recreated.",
      remediation: `${formatCliCommand("openclaw sandbox recreate --browser --all")} (add --force to skip prompt).`,
    });
  }

  if (staleEpoch.length > 0) {
    findings.push({
      checkId: "sandbox.browser_container.hash_epoch_stale",
      severity: "warn",
      title: "Sandbox browser container hash epoch is stale",
      detail:
        `Containers: ${staleEpoch.join(", ")}. ` +
        `Expected openclaw.browserConfigEpoch=${browserHashEpoch}.`,
      remediation: `${formatCliCommand("openclaw sandbox recreate --browser --all")} (add --force to skip prompt).`,
    });
  }

  if (nonLoopbackPublished.length > 0) {
    findings.push({
      checkId: "sandbox.browser_container.non_loopback_publish",
      severity: "critical",
      title: "Sandbox browser container publishes ports on non-loopback interfaces",
      detail:
        `Containers: ${nonLoopbackPublished.join(", ")}. ` +
        "Sandbox browser observer/control ports should stay loopback-only to avoid unintended remote access.",
      remediation:
        `${formatCliCommand("openclaw sandbox recreate --browser --all")} (add --force to skip prompt), ` +
        "then verify published ports are bound to 127.0.0.1.",
    });
  }

  if (timedOut) {
    findings.push(buildSandboxBrowserDockerProbeTimeoutFinding(timeoutMs));
  }

  return findings;
}

function buildSandboxBrowserDockerProbeTimeoutFinding(timeoutMs: number): SecurityAuditFinding {
  return {
    checkId: "sandbox.browser_container.docker_probe_timeout",
    severity: "warn",
    title: "Sandbox browser Docker audit probe timed out",
    detail:
      `Docker did not answer within ${timeoutMs}ms while checking sandbox browser containers. ` +
      "OpenClaw skipped any remaining sandbox browser container drift checks for this status run.",
    remediation:
      "Retry after Docker is responsive, or recreate sandbox browser containers if drift is suspected.",
  };
}

export async function collectIncludeFilePermFindings(params: {
  configSnapshot: ConfigFileSnapshot;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  execIcacls?: ExecFn;
}): Promise<SecurityAuditFinding[]> {
  const findings: SecurityAuditFinding[] = [];
  if (!params.configSnapshot.exists) {
    return findings;
  }

  const configPath = params.configSnapshot.path;
  const includePaths = await collectIncludePathsRecursive({
    configPath,
    parsed: params.configSnapshot.parsed,
    env: params.env,
  });
  if (includePaths.length === 0) {
    return findings;
  }

  const { formatPermissionDetail, formatPermissionRemediation, inspectPathPermissions } =
    await loadAuditFsModule();

  for (const p of includePaths) {
    const perms = await inspectPathPermissions(p, {
      env: params.env,
      platform: params.platform,
      exec: params.execIcacls,
    });
    if (!perms.ok) {
      continue;
    }
    if (perms.worldWritable || perms.groupWritable) {
      findings.push({
        checkId: "fs.config_include.perms_writable",
        severity: "critical",
        title: "Config include file is writable by others",
        detail: `${formatPermissionDetail(p, perms)}; another user could influence your effective config.`,
        remediation: formatPermissionRemediation({
          targetPath: p,
          perms,
          isDir: false,
          posixMode: 0o600,
          env: params.env,
        }),
      });
    } else if (perms.worldReadable) {
      findings.push({
        checkId: "fs.config_include.perms_world_readable",
        severity: "critical",
        title: "Config include file is world-readable",
        detail: `${formatPermissionDetail(p, perms)}; include files can contain tokens and private settings.`,
        remediation: formatPermissionRemediation({
          targetPath: p,
          perms,
          isDir: false,
          posixMode: 0o600,
          env: params.env,
        }),
      });
    } else if (perms.groupReadable) {
      findings.push({
        checkId: "fs.config_include.perms_group_readable",
        severity: "warn",
        title: "Config include file is group-readable",
        detail: `${formatPermissionDetail(p, perms)}; include files can contain tokens and private settings.`,
        remediation: formatPermissionRemediation({
          targetPath: p,
          perms,
          isDir: false,
          posixMode: 0o600,
          env: params.env,
        }),
      });
    }
  }

  return findings;
}

export async function collectStateDeepFilesystemFindings(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  stateDir: string;
  platform?: NodeJS.Platform;
  execIcacls?: ExecFn;
}): Promise<SecurityAuditFinding[]> {
  const findings: SecurityAuditFinding[] = [];
  const oauthDir = resolveOAuthDir(params.env, params.stateDir);
  const { formatPermissionDetail, formatPermissionRemediation, inspectPathPermissions } =
    await loadAuditFsModule();

  const oauthPerms = await inspectPathPermissions(oauthDir, {
    env: params.env,
    platform: params.platform,
    exec: params.execIcacls,
  });
  if (oauthPerms.ok && oauthPerms.isDir) {
    if (oauthPerms.worldWritable || oauthPerms.groupWritable) {
      findings.push({
        checkId: "fs.credentials_dir.perms_writable",
        severity: "critical",
        title: "Credentials dir is writable by others",
        detail: `${formatPermissionDetail(oauthDir, oauthPerms)}; another user could drop/modify credential files.`,
        remediation: formatPermissionRemediation({
          targetPath: oauthDir,
          perms: oauthPerms,
          isDir: true,
          posixMode: 0o700,
          env: params.env,
        }),
      });
    } else if (oauthPerms.groupReadable || oauthPerms.worldReadable) {
      findings.push({
        checkId: "fs.credentials_dir.perms_readable",
        severity: "warn",
        title: "Credentials dir is readable by others",
        detail: `${formatPermissionDetail(oauthDir, oauthPerms)}; credentials and allowlists can be sensitive.`,
        remediation: formatPermissionRemediation({
          targetPath: oauthDir,
          perms: oauthPerms,
          isDir: true,
          posixMode: 0o700,
          env: params.env,
        }),
      });
    }
  }

  const agentScope = await loadAgentScopeModule();
  const agentIds = agentScope.listAgentEntries(params.cfg).map((agent) => agent.id);
  let defaultAgentId: string | undefined;
  if (agentIds.length > 0) {
    try {
      defaultAgentId = agentScope.resolveDefaultAgentId(params.cfg);
    } catch {
      // Security audits must still inspect known agent stores when a malformed
      // roster prevents normal default selection; config findings report that defect.
    }
  }
  const ids = uniqueStrings([
    LEGACY_IMPLICIT_AGENT_ID,
    ...(defaultAgentId ? [defaultAgentId] : []),
    ...agentIds,
  ]).map((id) => normalizeAgentId(id));

  for (const agentId of ids) {
    const agentDir = path.join(params.stateDir, "agents", agentId, "agent");
    const authTargets = [
      { path: path.join(agentDir, "auth-profiles.json"), label: "legacy auth-profiles.json" },
      ...resolveAuthProfileDatabaseFilePaths(agentDir).map((targetPath) => ({
        path: targetPath,
        label: "auth profile SQLite store",
      })),
    ];
    for (const authTarget of authTargets) {
      const authPerms = await inspectPathPermissions(authTarget.path, {
        env: params.env,
        platform: params.platform,
        exec: params.execIcacls,
      });
      if (authPerms.ok) {
        if (authPerms.worldWritable || authPerms.groupWritable) {
          findings.push({
            checkId: "fs.auth_profiles.perms_writable",
            severity: "critical",
            title: `${authTarget.label} is writable by others`,
            detail: `${formatPermissionDetail(authTarget.path, authPerms)}; another user could inject credentials.`,
            remediation: formatPermissionRemediation({
              targetPath: authTarget.path,
              perms: authPerms,
              isDir: false,
              posixMode: 0o600,
              env: params.env,
            }),
          });
        } else if (authPerms.worldReadable || authPerms.groupReadable) {
          findings.push({
            checkId: "fs.auth_profiles.perms_readable",
            severity: "warn",
            title: `${authTarget.label} is readable by others`,
            detail: `${formatPermissionDetail(authTarget.path, authPerms)}; auth profile storage contains API keys and OAuth tokens.`,
            remediation: formatPermissionRemediation({
              targetPath: authTarget.path,
              perms: authPerms,
              isDir: false,
              posixMode: 0o600,
              env: params.env,
            }),
          });
        }
      }
    }

    const storePath = path.join(params.stateDir, "agents", agentId, "sessions", "sessions.json");
    const storePerms = await inspectPathPermissions(storePath, {
      env: params.env,
      platform: params.platform,
      exec: params.execIcacls,
    });
    if (storePerms.ok) {
      if (storePerms.worldReadable || storePerms.groupReadable) {
        findings.push({
          checkId: "fs.sessions_store.perms_readable",
          severity: "warn",
          title: "sessions.json is readable by others",
          detail: `${formatPermissionDetail(storePath, storePerms)}; routing and transcript metadata can be sensitive.`,
          remediation: formatPermissionRemediation({
            targetPath: storePath,
            perms: storePerms,
            isDir: false,
            posixMode: 0o600,
            env: params.env,
          }),
        });
      }
    }
  }

  const logFile = normalizeOptionalString(params.cfg.logging?.file) ?? "";
  if (logFile) {
    const expanded = logFile.startsWith("~") ? expandTilde(logFile, params.env) : logFile;
    if (expanded) {
      const logPath = path.resolve(expanded);
      const logPerms = await inspectPathPermissions(logPath, {
        env: params.env,
        platform: params.platform,
        exec: params.execIcacls,
      });
      if (logPerms.ok) {
        if (logPerms.worldReadable || logPerms.groupReadable) {
          findings.push({
            checkId: "fs.log_file.perms_readable",
            severity: "warn",
            title: "Log file is readable by others",
            detail: `${formatPermissionDetail(logPath, logPerms)}; logs can contain private messages and tool output.`,
            remediation: formatPermissionRemediation({
              targetPath: logPath,
              perms: logPerms,
              isDir: false,
              posixMode: 0o600,
              env: params.env,
            }),
          });
        }
      }
    }
  }

  return findings;
}

export async function readConfigSnapshotForAudit(params: {
  env: NodeJS.ProcessEnv;
  configPath: string;
}): Promise<ConfigFileSnapshot> {
  const { createConfigIO } = await loadConfigModule();
  return await createConfigIO({
    env: params.env,
    configPath: params.configPath,
  }).readConfigFileSnapshot();
}
