import { spawn, type StdioOptions } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { confirm, isCancel, spinner } from "@clack/prompts";
import { isTruthyEnvValue } from "../infra/env.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import { readTelemetryConfig, markNoticeShown } from "../telemetry/config.js";
import { track } from "../telemetry/telemetry.js";
import { stylePromptMessage } from "../terminal/prompt-style.js";
import { theme } from "../terminal/theme.js";
import { VERSION } from "../version.js";
import { applyCliProfileEnv } from "./profile.js";
import {
  DEFAULT_WEB_APP_PORT,
  ensureManagedWebRuntime,
  resolveCliPackageRoot,
  resolveProfileStateDir,
} from "./web-runtime.js";
import { seedWorkspaceFromAssets, type WorkspaceSeedResult } from "./workspace-seed.js";

const DEFAULT_DENCHCLAW_PROFILE = "dench";
const DENCHCLAW_GATEWAY_PORT_START = 19001;
const MAX_PORT_SCAN_ATTEMPTS = 100;
const DEFAULT_BOOTSTRAP_ROLLOUT_STAGE = "default";
const DEFAULT_GATEWAY_LAUNCH_AGENT_LABEL = "ai.openclaw.gateway";
const REQUIRED_TOOLS_PROFILE = "full";
const OPENCLAW_CLI_CHECK_CACHE_TTL_MS = 5 * 60_000;
const OPENCLAW_UPDATE_PROMPT_SUPPRESS_AFTER_INSTALL_MS = 5 * 60_000;
const OPENCLAW_CLI_CHECK_CACHE_FILE = "openclaw-cli-check.json";
const OPENCLAW_SETUP_PROGRESS_BAR_WIDTH = 16;

type BootstrapRolloutStage = "internal" | "beta" | "default";
type BootstrapCheckStatus = "pass" | "warn" | "fail";

export type BootstrapCheck = {
  id:
    | "openclaw-cli"
    | "profile"
    | "gateway"
    | "agent-auth"
    | "web-ui"
    | "state-isolation"
    | "daemon-label"
    | "rollout-stage"
    | "cutover-gates"
    | "posthog-analytics";
  status: BootstrapCheckStatus;
  detail: string;
  remediation?: string;
};

export type BootstrapDiagnostics = {
  rolloutStage: BootstrapRolloutStage;
  legacyFallbackEnabled: boolean;
  checks: BootstrapCheck[];
  hasFailures: boolean;
};

export type BootstrapOptions = {
  profile?: string;
  yes?: boolean;
  nonInteractive?: boolean;
  forceOnboard?: boolean;
  skipUpdate?: boolean;
  updateNow?: boolean;
  noOpen?: boolean;
  json?: boolean;
  gatewayPort?: string | number;
  webPort?: string | number;
};

type BootstrapSummary = {
  profile: string;
  onboarded: boolean;
  installedOpenClawCli: boolean;
  openClawCliAvailable: boolean;
  openClawVersion?: string;
  gatewayUrl: string;
  gatewayReachable: boolean;
  gatewayAutoFix?: {
    attempted: boolean;
    recovered: boolean;
    steps: GatewayAutoFixStep[];
    failureSummary?: string;
    logExcerpts: GatewayLogExcerpt[];
  };
  workspaceSeed?: WorkspaceSeedResult;
  webUrl: string;
  webReachable: boolean;
  webOpened: boolean;
  diagnostics: BootstrapDiagnostics;
};

type SpawnResult = {
  stdout: string;
  stderr: string;
  code: number;
};

type OpenClawCliAvailability = {
  available: boolean;
  installed: boolean;
  installedAt?: number;
  version?: string;
  command: string;
  globalBinDir?: string;
  shellCommandPath?: string;
};

type OutputLineHandler = (line: string, stream: "stdout" | "stderr") => void;

type OpenClawCliCheckCache = {
  checkedAt: number;
  pathEnv: string;
  available: boolean;
  command: string;
  version?: string;
  globalBinDir?: string;
  shellCommandPath?: string;
  installedAt?: number;
};

type OpenClawSetupProgress = {
  startStage: (label: string) => void;
  output: (line: string) => void;
  completeStage: (suffix?: string) => void;
  finish: (message: string) => void;
  fail: (message: string) => void;
};

type GatewayAutoFixStep = {
  name: string;
  ok: boolean;
  detail?: string;
};

type GatewayLogExcerpt = {
  path: string;
  excerpt: string;
};

type GatewayAutoFixResult = {
  attempted: boolean;
  recovered: boolean;
  steps: GatewayAutoFixStep[];
  finalProbe: { ok: boolean; detail?: string };
  failureSummary?: string;
  logExcerpts: GatewayLogExcerpt[];
};

function resolveCommandForPlatform(command: string): string {
  if (process.platform !== "win32") {
    return command;
  }
  if (path.extname(command)) {
    return command;
  }
  const normalized = path.basename(command).toLowerCase();
  if (
    normalized === "npm" ||
    normalized === "pnpm" ||
    normalized === "npx" ||
    normalized === "yarn"
  ) {
    return `${command}.cmd`;
  }
  return command;
}

async function runCommandWithTimeout(
  argv: string[],
  options: {
    timeoutMs: number;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    ioMode?: "capture" | "inherit";
    onOutputLine?: OutputLineHandler;
  },
): Promise<SpawnResult> {
  const [command, ...args] = argv;
  if (!command) {
    return { code: 1, stdout: "", stderr: "missing command" };
  }
  const stdio: StdioOptions = options.ioMode === "inherit" ? "inherit" : ["ignore", "pipe", "pipe"];
  return await new Promise<SpawnResult>((resolve, reject) => {
    const child = spawn(resolveCommandForPlatform(command), args, {
      cwd: options.cwd,
      env: options.env ? { ...process.env, ...options.env } : process.env,
      stdio,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      child.kill("SIGKILL");
    }, options.timeoutMs);

    child.stdout?.on("data", (chunk: Buffer | string) => {
      const text = String(chunk);
      stdout += text;
      if (options.onOutputLine) {
        for (const segment of text.split(/\r?\n/)) {
          const line = segment.trim();
          if (line.length > 0) {
            options.onOutputLine(line, "stdout");
          }
        }
      }
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      const text = String(chunk);
      stderr += text;
      if (options.onOutputLine) {
        for (const segment of text.split(/\r?\n/)) {
          const line = segment.trim();
          if (line.length > 0) {
            options.onOutputLine(line, "stderr");
          }
        }
      }
    });
    child.once("error", (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code: number | null) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({
        code: typeof code === "number" ? code : 1,
        stdout,
        stderr,
      });
    });
  });
}

function parseOptionalPort(value: string | number | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const raw = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  if (!Number.isFinite(raw) || raw <= 0) {
    return undefined;
  }
  return raw;
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

import { createConnection } from "node:net";

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createConnection({ port, host: "127.0.0.1" }, () => {
      // Connection succeeded, port is in use
      server.end();
      resolve(false);
    });
    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ECONNREFUSED") {
        // Port is available (nothing listening)
        resolve(true);
      } else if (err.code === "EADDRNOTAVAIL") {
        // Address not available
        resolve(false);
      } else {
        // Other errors, assume port is not available
        resolve(false);
      }
    });
    server.setTimeout(1000, () => {
      server.destroy();
      resolve(false);
    });
  });
}

async function findAvailablePort(
  startPort: number,
  maxAttempts: number,
): Promise<number | undefined> {
  for (let i = 0; i < maxAttempts; i++) {
    const port = startPort + i;
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  return undefined;
}

/**
 * Port 18789 belongs to the host OpenClaw installation.  A persisted config
 * that drifted to that value (e.g. bootstrap ran while OpenClaw was down)
 * must be rejected to prevent service hijack on launchd restart.
 */
export function isPersistedPortAcceptable(port: number | undefined): port is number {
  return typeof port === "number" && port > 0 && port !== 18789;
}

export function readExistingGatewayPort(stateDir: string): number | undefined {
  for (const name of ["openclaw.json", "config.json"]) {
    try {
      const raw = JSON.parse(readFileSync(path.join(stateDir, name), "utf-8")) as {
        gateway?: { port?: unknown };
      };
      const port =
        typeof raw.gateway?.port === "number"
          ? raw.gateway.port
          : typeof raw.gateway?.port === "string"
            ? Number.parseInt(raw.gateway.port, 10)
            : undefined;
      if (typeof port === "number" && Number.isFinite(port) && port > 0) {
        return port;
      }
    } catch {
      // Config file missing or malformed — try next candidate.
    }
  }
  return undefined;
}

function normalizeBootstrapRolloutStage(raw: string | undefined): BootstrapRolloutStage {
  const normalized = raw?.trim().toLowerCase();
  if (normalized === "internal" || normalized === "beta" || normalized === "default") {
    return normalized;
  }
  return DEFAULT_BOOTSTRAP_ROLLOUT_STAGE;
}

export function resolveBootstrapRolloutStage(
  env: NodeJS.ProcessEnv = process.env,
): BootstrapRolloutStage {
  return normalizeBootstrapRolloutStage(
    env.DENCHCLAW_BOOTSTRAP_ROLLOUT ?? env.OPENCLAW_BOOTSTRAP_ROLLOUT,
  );
}

export function isLegacyFallbackEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    isTruthyEnvValue(env.DENCHCLAW_BOOTSTRAP_LEGACY_FALLBACK) ||
    isTruthyEnvValue(env.OPENCLAW_BOOTSTRAP_LEGACY_FALLBACK)
  );
}

function normalizeVersionOutput(raw: string | undefined): string | undefined {
  const first = raw
    ?.split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return first && first.length > 0 ? first : undefined;
}

function firstNonEmptyLine(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const first = value
      ?.split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    if (first) {
      return first;
    }
  }
  return undefined;
}

function resolveGatewayLaunchAgentLabel(profile: string): string {
  const normalized = profile.trim().toLowerCase();
  if (!normalized || normalized === "default") {
    return DEFAULT_GATEWAY_LAUNCH_AGENT_LABEL;
  }
  return `ai.openclaw.${normalized}`;
}

async function installBundledPlugins(params: {
  openclawCommand: string;
  profile: string;
  stateDir: string;
  posthogKey: string;
}): Promise<boolean> {
  try {
    const pluginSrc = path.join(resolveCliPackageRoot(), "extensions", "posthog-analytics");
    if (!existsSync(pluginSrc)) return false;

    const pluginDest = path.join(params.stateDir, "extensions", "posthog-analytics");
    mkdirSync(path.dirname(pluginDest), { recursive: true });
    cpSync(pluginSrc, pluginDest, { recursive: true, force: true });

    await runOpenClawOrThrow({
      openclawCommand: params.openclawCommand,
      args: [
        "--profile", params.profile,
        "config", "set",
        "plugins.allow", '["posthog-analytics"]',
      ],
      timeoutMs: 30_000,
      errorMessage: "Failed to set plugins.allow for posthog-analytics.",
    });

    await runOpenClawOrThrow({
      openclawCommand: params.openclawCommand,
      args: [
        "--profile", params.profile,
        "config", "set",
        "plugins.load.paths", JSON.stringify([pluginDest]),
      ],
      timeoutMs: 30_000,
      errorMessage: "Failed to set plugins.load.paths for posthog-analytics.",
    });

    if (params.posthogKey) {
      await runOpenClawOrThrow({
        openclawCommand: params.openclawCommand,
        args: [
          "--profile", params.profile,
          "config", "set",
          "plugins.entries.posthog-analytics.enabled", "true",
        ],
        timeoutMs: 30_000,
        errorMessage: "Failed to enable posthog-analytics plugin.",
      });
      await runOpenClawOrThrow({
        openclawCommand: params.openclawCommand,
        args: [
          "--profile", params.profile,
          "config", "set",
          "plugins.entries.posthog-analytics.config.apiKey", params.posthogKey,
        ],
        timeoutMs: 30_000,
        errorMessage: "Failed to set posthog-analytics API key.",
      });
    }
    return true;
  } catch {
    return false;
  }
}

async function ensureGatewayModeLocal(openclawCommand: string, profile: string): Promise<void> {
  const result = await runOpenClaw(
    openclawCommand,
    ["--profile", profile, "config", "get", "gateway.mode"],
    10_000,
  );
  const currentMode = result.stdout.trim();
  if (currentMode === "local") {
    return;
  }
  await runOpenClawOrThrow({
    openclawCommand,
    args: ["--profile", profile, "config", "set", "gateway.mode", "local"],
    timeoutMs: 10_000,
    errorMessage: "Failed to set gateway.mode=local.",
  });
}

async function ensureGatewayPort(
  openclawCommand: string,
  profile: string,
  gatewayPort: number,
): Promise<void> {
  await runOpenClawOrThrow({
    openclawCommand,
    args: ["--profile", profile, "config", "set", "gateway.port", String(gatewayPort)],
    timeoutMs: 10_000,
    errorMessage: `Failed to set gateway.port=${gatewayPort}.`,
  });
}

async function ensureDefaultWorkspacePath(
  openclawCommand: string,
  profile: string,
  workspaceDir: string,
): Promise<void> {
  await runOpenClawOrThrow({
    openclawCommand,
    args: ["--profile", profile, "config", "set", "agents.defaults.workspace", workspaceDir],
    timeoutMs: 10_000,
    errorMessage: `Failed to set agents.defaults.workspace=${workspaceDir}.`,
  });
}

async function ensureSubagentDefaults(openclawCommand: string, profile: string): Promise<void> {
  const settings: Array<[string, string]> = [
    ["agents.defaults.subagents.maxConcurrent", "8"],
    ["agents.defaults.subagents.maxSpawnDepth", "2"],
    ["agents.defaults.subagents.maxChildrenPerAgent", "10"],
    ["agents.defaults.subagents.archiveAfterMinutes", "180"],
    ["agents.defaults.subagents.runTimeoutSeconds", "0"],
    ["tools.subagents.tools.deny", "[]"],
  ];
  for (const [key, value] of settings) {
    await runOpenClawOrThrow({
      openclawCommand,
      args: ["--profile", profile, "config", "set", key, value],
      timeoutMs: 10_000,
      errorMessage: `Failed to set ${key}=${value}.`,
    });
  }
}

async function ensureToolsProfile(openclawCommand: string, profile: string): Promise<void> {
  await runOpenClawOrThrow({
    openclawCommand,
    args: ["--profile", profile, "config", "set", "tools.profile", REQUIRED_TOOLS_PROFILE],
    timeoutMs: 10_000,
    errorMessage: `Failed to set tools.profile=${REQUIRED_TOOLS_PROFILE}.`,
  });
}

async function runOpenClaw(
  openclawCommand: string,
  args: string[],
  timeoutMs: number,
  ioMode: "capture" | "inherit" = "capture",
  env?: NodeJS.ProcessEnv,
  onOutputLine?: OutputLineHandler,
): Promise<SpawnResult> {
  return await runCommandWithTimeout([openclawCommand, ...args], {
    timeoutMs,
    ioMode,
    env,
    onOutputLine,
  });
}

async function runOpenClawOrThrow(params: {
  openclawCommand: string;
  args: string[];
  timeoutMs: number;
  errorMessage: string;
}): Promise<SpawnResult> {
  const result = await runOpenClaw(params.openclawCommand, params.args, params.timeoutMs);
  if (result.code === 0) {
    return result;
  }
  const detail = firstNonEmptyLine(result.stderr, result.stdout);
  throw new Error(detail ? `${params.errorMessage}\n${detail}` : params.errorMessage);
}

/**
 * Runs an OpenClaw command attached to the current terminal.
 * Use this for interactive flows like `openclaw onboard`.
 */
async function runOpenClawInteractiveOrThrow(params: {
  openclawCommand: string;
  args: string[];
  timeoutMs: number;
  errorMessage: string;
}): Promise<SpawnResult> {
  const result = await runOpenClaw(
    params.openclawCommand,
    params.args,
    params.timeoutMs,
    "inherit",
  );
  if (result.code === 0) {
    return result;
  }
  const detail = firstNonEmptyLine(result.stderr, result.stdout);
  throw new Error(detail ? `${params.errorMessage}\n${detail}` : params.errorMessage);
}

/**
 * Runs an openclaw sub-command with a visible spinner that streams progress
 * from the subprocess stdout/stderr into the spinner message.
 */
async function runOpenClawWithProgress(params: {
  openclawCommand: string;
  args: string[];
  timeoutMs: number;
  startMessage: string;
  successMessage: string;
  errorMessage: string;
}): Promise<SpawnResult> {
  const s = spinner();
  s.start(params.startMessage);

  const result = await new Promise<SpawnResult>((resolve, reject) => {
    const child = spawn(resolveCommandForPlatform(params.openclawCommand), params.args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        child.kill("SIGKILL");
      }
    }, params.timeoutMs);

    const updateSpinner = (chunk: string) => {
      const line = chunk
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .pop();
      if (line) {
        s.message(line.length > 72 ? `${line.slice(0, 69)}...` : line);
      }
    };

    child.stdout?.on("data", (chunk) => {
      const text = String(chunk);
      stdout += text;
      updateSpinner(text);
    });
    child.stderr?.on("data", (chunk) => {
      const text = String(chunk);
      stderr += text;
      updateSpinner(text);
    });
    child.once("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ code: typeof code === "number" ? code : 1, stdout, stderr });
    });
  });

  if (result.code === 0) {
    s.stop(params.successMessage);
    return result;
  }

  const detail = firstNonEmptyLine(result.stderr, result.stdout);
  const stopMessage = detail ? `${params.errorMessage}: ${detail}` : params.errorMessage;
  s.stop(stopMessage);
  throw new Error(detail ? `${params.errorMessage}\n${detail}` : params.errorMessage);
}

function parseJsonPayload(raw: string | undefined): Record<string, unknown> | undefined {
  if (!raw) {
    return undefined;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start === -1 || end <= start) {
      return undefined;
    }
    try {
      const parsed = JSON.parse(trimmed.slice(start, end + 1));
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
    } catch {
      return undefined;
    }
  }
}

function resolveOpenClawCliCheckCachePath(stateDir: string): string {
  return path.join(stateDir, "cache", OPENCLAW_CLI_CHECK_CACHE_FILE);
}

function readOpenClawCliCheckCache(stateDir: string): OpenClawCliCheckCache | undefined {
  const cachePath = resolveOpenClawCliCheckCachePath(stateDir);
  if (!existsSync(cachePath)) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(readFileSync(cachePath, "utf-8")) as Partial<OpenClawCliCheckCache>;
    if (
      typeof parsed.checkedAt !== "number" ||
      !Number.isFinite(parsed.checkedAt) ||
      typeof parsed.pathEnv !== "string" ||
      parsed.pathEnv !== (process.env.PATH ?? "") ||
      typeof parsed.available !== "boolean" ||
      !parsed.available ||
      typeof parsed.command !== "string" ||
      parsed.command.length === 0
    ) {
      return undefined;
    }
    const ageMs = Date.now() - parsed.checkedAt;
    if (ageMs < 0 || ageMs > OPENCLAW_CLI_CHECK_CACHE_TTL_MS) {
      return undefined;
    }
    const looksLikePath =
      parsed.command.includes(path.sep) ||
      parsed.command.includes("/") ||
      parsed.command.includes("\\");
    if (looksLikePath && !existsSync(parsed.command)) {
      return undefined;
    }
    return {
      checkedAt: parsed.checkedAt,
      pathEnv: parsed.pathEnv,
      available: parsed.available,
      command: parsed.command,
      version: typeof parsed.version === "string" ? parsed.version : undefined,
      globalBinDir: typeof parsed.globalBinDir === "string" ? parsed.globalBinDir : undefined,
      shellCommandPath:
        typeof parsed.shellCommandPath === "string" ? parsed.shellCommandPath : undefined,
      installedAt: typeof parsed.installedAt === "number" ? parsed.installedAt : undefined,
    };
  } catch {
    return undefined;
  }
}

function writeOpenClawCliCheckCache(
  stateDir: string,
  cache: Omit<OpenClawCliCheckCache, "checkedAt" | "pathEnv">,
): void {
  try {
    const cachePath = resolveOpenClawCliCheckCachePath(stateDir);
    mkdirSync(path.dirname(cachePath), { recursive: true });
    const payload: OpenClawCliCheckCache = {
      ...cache,
      checkedAt: Date.now(),
      pathEnv: process.env.PATH ?? "",
    };
    writeFileSync(cachePath, JSON.stringify(payload, null, 2), "utf-8");
  } catch {
    // Cache write failures should never block bootstrap.
  }
}

function createOpenClawSetupProgress(params: {
  enabled: boolean;
  totalStages: number;
}): OpenClawSetupProgress {
  if (!params.enabled || params.totalStages <= 0 || !process.stdout.isTTY) {
    const noop = () => undefined;
    return {
      startStage: noop,
      output: noop,
      completeStage: noop,
      finish: noop,
      fail: noop,
    };
  }

  const s = spinner();
  let completedStages = 0;
  let activeLabel = "";

  const renderBar = () => {
    const ratio = completedStages / params.totalStages;
    const filled = Math.max(
      0,
      Math.min(
        OPENCLAW_SETUP_PROGRESS_BAR_WIDTH,
        Math.round(ratio * OPENCLAW_SETUP_PROGRESS_BAR_WIDTH),
      ),
    );
    const bar = `${"#".repeat(filled)}${"-".repeat(OPENCLAW_SETUP_PROGRESS_BAR_WIDTH - filled)}`;
    return `[${bar}] ${completedStages}/${params.totalStages}`;
  };

  const truncate = (value: string, max = 84) =>
    value.length > max ? `${value.slice(0, max - 3)}...` : value;

  const renderStageLine = (detail?: string) => {
    const base = `${renderBar()} ${activeLabel}`.trim();
    if (!detail) {
      return base;
    }
    return truncate(`${base} -> ${detail}`);
  };

  return {
    startStage: (label: string) => {
      activeLabel = label;
      s.start(renderStageLine());
    },
    output: (line: string) => {
      if (!line) {
        return;
      }
      s.message(renderStageLine(line));
    },
    completeStage: (suffix?: string) => {
      completedStages = Math.min(params.totalStages, completedStages + 1);
      s.stop(renderStageLine(suffix ?? "done"));
    },
    finish: (message: string) => {
      completedStages = params.totalStages;
      s.stop(`${renderBar()} ${truncate(message)}`.trim());
    },
    fail: (message: string) => {
      s.stop(`${renderBar()} ${truncate(message)}`.trim());
    },
  };
}

async function detectGlobalOpenClawInstall(
  onOutputLine?: OutputLineHandler,
): Promise<{ installed: boolean; version?: string }> {
  const result = await runCommandWithTimeout(
    ["npm", "ls", "-g", "openclaw", "--depth=0", "--json", "--silent"],
    {
      timeoutMs: 15_000,
      onOutputLine,
    },
  ).catch(() => null);

  const parsed = parseJsonPayload(result?.stdout ?? result?.stderr);
  const dependencies = parsed?.dependencies as
    | Record<string, { version?: string } | undefined>
    | undefined;
  const installedVersion = dependencies?.openclaw?.version;
  if (typeof installedVersion === "string" && installedVersion.length > 0) {
    return { installed: true, version: installedVersion };
  }
  return { installed: false };
}

async function resolveNpmGlobalBinDir(
  onOutputLine?: OutputLineHandler,
): Promise<string | undefined> {
  const result = await runCommandWithTimeout(["npm", "prefix", "-g"], {
    timeoutMs: 8_000,
    onOutputLine,
  }).catch(() => null);
  if (!result || result.code !== 0) {
    return undefined;
  }
  const prefix = firstNonEmptyLine(result.stdout);
  if (!prefix) {
    return undefined;
  }
  return process.platform === "win32" ? prefix : path.join(prefix, "bin");
}

function resolveGlobalOpenClawCommand(globalBinDir: string | undefined): string | undefined {
  if (!globalBinDir) {
    return undefined;
  }
  const candidates =
    process.platform === "win32"
      ? [path.join(globalBinDir, "openclaw.cmd"), path.join(globalBinDir, "openclaw.exe")]
      : [path.join(globalBinDir, "openclaw")];
  return candidates.find((candidate) => existsSync(candidate));
}

async function resolveShellOpenClawPath(
  onOutputLine?: OutputLineHandler,
): Promise<string | undefined> {
  const locator = process.platform === "win32" ? "where" : "which";
  const result = await runCommandWithTimeout([locator, "openclaw"], {
    timeoutMs: 4_000,
    onOutputLine,
  }).catch(() => null);
  if (!result || result.code !== 0) {
    return undefined;
  }
  return firstNonEmptyLine(result.stdout);
}

function isProjectLocalOpenClawPath(commandPath: string | undefined): boolean {
  if (!commandPath) {
    return false;
  }
  const normalized = commandPath.replaceAll("\\", "/");
  return normalized.includes("/node_modules/.bin/openclaw");
}

async function ensureOpenClawCliAvailable(params: {
  stateDir: string;
  showProgress: boolean;
}): Promise<OpenClawCliAvailability> {
  const cached = readOpenClawCliCheckCache(params.stateDir);
  if (cached) {
    const ageSeconds = Math.max(0, Math.floor((Date.now() - cached.checkedAt) / 1000));
    const progress = createOpenClawSetupProgress({
      enabled: params.showProgress,
      totalStages: 1,
    });
    progress.startStage("Reusing cached OpenClaw install check");
    progress.completeStage(`cache hit (${ageSeconds}s old)`);
    return {
      available: true,
      installed: false,
      installedAt: cached.installedAt,
      version: cached.version,
      command: cached.command,
      globalBinDir: cached.globalBinDir,
      shellCommandPath: cached.shellCommandPath,
    };
  }

  const progress = createOpenClawSetupProgress({
    enabled: params.showProgress,
    totalStages: 5,
  });
  progress.startStage("Checking global OpenClaw install");

  const globalBefore = await detectGlobalOpenClawInstall((line) => {
    progress.output(`npm ls: ${line}`);
  });
  progress.completeStage(
    globalBefore.installed ? `found ${globalBefore.version ?? "installed"}` : "missing",
  );

  let installed = false;
  let installedAt: number | undefined;
  progress.startStage("Ensuring openclaw@latest is installed globally");
  if (!globalBefore.installed) {
    const install = await runCommandWithTimeout(["npm", "install", "-g", "openclaw@latest"], {
      timeoutMs: 10 * 60_000,
      onOutputLine: (line) => {
        progress.output(`npm install: ${line}`);
      },
    }).catch(() => null);
    if (!install || install.code !== 0) {
      progress.fail("OpenClaw global install failed.");
      return {
        available: false,
        installed: false,
        version: undefined,
        command: "openclaw",
      };
    }
    installed = true;
    installedAt = Date.now();
    progress.completeStage("installed openclaw@latest");
  } else {
    progress.completeStage("already installed; skipping install");
  }

  progress.startStage("Resolving global and shell OpenClaw paths");
  const [globalBinDir, shellCommandPath] = await Promise.all([
    resolveNpmGlobalBinDir((line) => {
      progress.output(`npm prefix: ${line}`);
    }),
    resolveShellOpenClawPath((line) => {
      progress.output(`${process.platform === "win32" ? "where" : "which"}: ${line}`);
    }),
  ]);
  progress.completeStage("path discovery complete");

  const globalAfter = installed ? { installed: true, version: globalBefore.version } : globalBefore;
  const globalCommand = resolveGlobalOpenClawCommand(globalBinDir);
  const command = globalCommand ?? "openclaw";
  progress.startStage("Verifying OpenClaw CLI responsiveness");
  const check = await runOpenClaw(command, ["--version"], 4_000, "capture", undefined, (line) => {
    progress.output(`openclaw --version: ${line}`);
  }).catch(() => null);
  progress.completeStage(
    check?.code === 0 ? "OpenClaw responded" : "OpenClaw version probe failed",
  );

  const version = normalizeVersionOutput(check?.stdout || check?.stderr || globalAfter.version);
  const available = Boolean(globalAfter.installed && check && check.code === 0);
  progress.startStage("Caching OpenClaw check result");
  if (available) {
    writeOpenClawCliCheckCache(params.stateDir, {
      available,
      command,
      version,
      globalBinDir,
      shellCommandPath,
      installedAt,
    });
    progress.completeStage(`saved (${Math.floor(OPENCLAW_CLI_CHECK_CACHE_TTL_MS / 60_000)}m TTL)`);
  } else {
    progress.fail("OpenClaw CLI check failed (cache not written).");
  }

  return {
    available,
    installed,
    installedAt,
    version,
    command,
    globalBinDir,
    shellCommandPath,
  };
}

async function probeGateway(
  openclawCommand: string,
  profile: string,
  gatewayPort?: number,
): Promise<{ ok: boolean; detail?: string }> {
  const env = gatewayPort ? { OPENCLAW_GATEWAY_PORT: String(gatewayPort) } : undefined;
  const result = await runOpenClaw(
    openclawCommand,
    ["--profile", profile, "health", "--json"],
    12_000,
    "capture",
    env,
  ).catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    return {
      code: 1,
      stdout: "",
      stderr: message,
    } as SpawnResult;
  });
  if (result.code === 0) {
    return { ok: true };
  }
  return {
    ok: false,
    detail: firstNonEmptyLine(result.stderr, result.stdout),
  };
}

function readLogTail(logPath: string, maxLines = 16): string | undefined {
  if (!existsSync(logPath)) {
    return undefined;
  }
  try {
    const lines = readFileSync(logPath, "utf-8")
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0);
    if (lines.length === 0) {
      return undefined;
    }
    return lines.slice(-maxLines).join("\n");
  } catch {
    return undefined;
  }
}

function resolveLatestRuntimeLogPath(): string | undefined {
  const runtimeLogDir = "/tmp/openclaw";
  if (!existsSync(runtimeLogDir)) {
    return undefined;
  }
  try {
    const files = readdirSync(runtimeLogDir)
      .filter((name) => /^openclaw-.*\.log$/u.test(name))
      .toSorted((a, b) => b.localeCompare(a));
    if (files.length === 0) {
      return undefined;
    }
    return path.join(runtimeLogDir, files[0]);
  } catch {
    return undefined;
  }
}

function collectGatewayLogExcerpts(stateDir: string): GatewayLogExcerpt[] {
  const candidates = [
    path.join(stateDir, "logs", "gateway.err.log"),
    path.join(stateDir, "logs", "gateway.log"),
    resolveLatestRuntimeLogPath(),
  ].filter((candidate): candidate is string => Boolean(candidate));

  const excerpts: GatewayLogExcerpt[] = [];
  for (const candidate of candidates) {
    const excerpt = readLogTail(candidate);
    if (!excerpt) {
      continue;
    }
    excerpts.push({ path: candidate, excerpt });
  }
  return excerpts;
}

function deriveGatewayFailureSummary(
  probeDetail: string | undefined,
  excerpts: GatewayLogExcerpt[],
): string | undefined {
  const combinedLines = excerpts.flatMap((entry) => entry.excerpt.split(/\r?\n/));
  const signalRegex =
    /(cannot find module|plugin not found|invalid config|unauthorized|token mismatch|device token mismatch|device signature invalid|device signature expired|device-signature|eaddrinuse|address already in use|error:|failed to|failovererror)/iu;
  const likely = [...combinedLines].toReversed().find((line) => signalRegex.test(line));
  if (likely) {
    return likely.length > 220 ? `${likely.slice(0, 217)}...` : likely;
  }
  return probeDetail;
}

async function attemptGatewayAutoFix(params: {
  openclawCommand: string;
  profile: string;
  stateDir: string;
  gatewayPort: number;
}): Promise<GatewayAutoFixResult> {
  const steps: GatewayAutoFixStep[] = [];
  const commands: Array<{
    name: string;
    args: string[];
    timeoutMs: number;
  }> = [
    {
      name: "openclaw gateway stop",
      args: ["--profile", params.profile, "gateway", "stop"],
      timeoutMs: 90_000,
    },
    {
      name: "openclaw doctor --fix",
      args: ["--profile", params.profile, "doctor", "--fix"],
      timeoutMs: 2 * 60_000,
    },
    {
      name: "openclaw gateway install --force",
      args: [
        "--profile",
        params.profile,
        "gateway",
        "install",
        "--force",
        "--port",
        String(params.gatewayPort),
      ],
      timeoutMs: 2 * 60_000,
    },
    {
      name: "openclaw gateway start",
      args: ["--profile", params.profile, "gateway", "start", "--port", String(params.gatewayPort)],
      timeoutMs: 2 * 60_000,
    },
  ];

  for (const command of commands) {
    const result = await runOpenClaw(params.openclawCommand, command.args, command.timeoutMs).catch(
      (error) => {
        const message = error instanceof Error ? error.message : String(error);
        return {
          code: 1,
          stdout: "",
          stderr: message,
        } as SpawnResult;
      },
    );
    steps.push({
      name: command.name,
      ok: result.code === 0,
      detail: result.code === 0 ? undefined : firstNonEmptyLine(result.stderr, result.stdout),
    });
  }

  let finalProbe = await probeGateway(params.openclawCommand, params.profile, params.gatewayPort);
  for (let attempt = 0; attempt < 2 && !finalProbe.ok; attempt += 1) {
    await sleep(1_200);
    finalProbe = await probeGateway(params.openclawCommand, params.profile, params.gatewayPort);
  }

  const logExcerpts = finalProbe.ok ? [] : collectGatewayLogExcerpts(params.stateDir);
  const failureSummary = finalProbe.ok
    ? undefined
    : deriveGatewayFailureSummary(finalProbe.detail, logExcerpts);

  return {
    attempted: true,
    recovered: finalProbe.ok,
    steps,
    finalProbe,
    failureSummary,
    logExcerpts,
  };
}

async function openUrl(url: string): Promise<boolean> {
  const argv =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];
  const result = await runCommandWithTimeout(argv, { timeoutMs: 5_000 }).catch(() => null);
  return Boolean(result && result.code === 0);
}

function remediationForGatewayFailure(
  detail: string | undefined,
  port: number,
  profile: string,
): string {
  const normalized = detail?.toLowerCase() ?? "";
  const isDeviceAuthMismatch =
    normalized.includes("device token mismatch") ||
    normalized.includes("device signature invalid") ||
    normalized.includes("device signature expired") ||
    normalized.includes("device-signature");
  if (isDeviceAuthMismatch) {
    return [
      `Gateway device-auth mismatch detected. Re-run \`openclaw --profile ${profile} onboard --install-daemon --reset\`.`,
      `Last resort (security downgrade): \`openclaw --profile ${profile} config set gateway.controlUi.dangerouslyDisableDeviceAuth true\`. Revert after recovery: \`openclaw --profile ${profile} config set gateway.controlUi.dangerouslyDisableDeviceAuth false\`.`,
    ].join(" ");
  }
  if (
    normalized.includes("unauthorized") ||
    normalized.includes("token") ||
    normalized.includes("password")
  ) {
    return `Gateway auth mismatch detected. Re-run \`openclaw --profile ${profile} onboard --install-daemon --reset\`.`;
  }
  if (normalized.includes("address already in use") || normalized.includes("eaddrinuse")) {
    return `Port ${port} is busy. The bootstrap will auto-assign an available port, or you can explicitly specify one with \`--gateway-port <port>\`.`;
  }
  return `Run \`openclaw --profile ${profile} doctor --fix\` and retry \`npx denchclaw bootstrap\`.`;
}

function remediationForWebUiFailure(port: number): string {
  return [
    `Web UI did not respond on ${port}.`,
    `Run \`npx denchclaw update --web-port ${port}\` to refresh the managed web runtime.`,
    `If the port is stuck, run \`npx denchclaw stop --web-port ${port}\` first.`,
  ].join(" ");
}

function describeWorkspaceSeedResult(result: WorkspaceSeedResult): string {
  if (result.seeded) {
    return `seeded ${result.dbPath}`;
  }
  if (result.reason === "already-exists") {
    return `skipped; existing database found at ${result.dbPath}`;
  }
  if (result.reason === "seed-asset-missing") {
    return `skipped; seed asset missing at ${result.seedDbPath}`;
  }
  if (result.reason === "copy-failed") {
    return `failed to copy seed database: ${result.error ?? "unknown error"}`;
  }
  return `skipped; reason=${result.reason}`;
}

function createCheck(
  id: BootstrapCheck["id"],
  status: BootstrapCheckStatus,
  detail: string,
  remediation?: string,
): BootstrapCheck {
  return { id, status, detail, remediation };
}

/**
 * Load OpenClaw profile config from state dir.
 * Supports both openclaw.json (current) and config.json (legacy).
 */
function readBootstrapConfig(stateDir: string): Record<string, unknown> | undefined {
  for (const name of ["openclaw.json", "config.json"]) {
    const configPath = path.join(stateDir, name);
    if (!existsSync(configPath)) {
      continue;
    }
    try {
      const raw = JSON.parse(readFileSync(configPath, "utf-8"));
      if (raw && typeof raw === "object") {
        return raw as Record<string, unknown>;
      }
    } catch {
      // Config unreadable; skip.
    }
  }
  return undefined;
}

function resolveBootstrapWorkspaceDir(stateDir: string): string {
  return path.join(stateDir, "workspace");
}

/**
 * Resolve the model provider prefix from the config's primary model string.
 * e.g. "vercel-ai-gateway/anthropic/claude-opus-4.6" → "vercel-ai-gateway"
 */
function resolveModelProvider(stateDir: string): string | undefined {
  const raw = readBootstrapConfig(stateDir);
  const model = (raw as { agents?: { defaults?: { model?: { primary?: string } | string } } })
    ?.agents?.defaults?.model;
  const modelName = typeof model === "string" ? model : model?.primary;
  if (typeof modelName === "string" && modelName.includes("/")) {
    return modelName.split("/")[0];
  }
  return undefined;
}

/**
 * Check if the agent auth store has at least one key for the given provider.
 */
export function checkAgentAuth(
  stateDir: string,
  provider: string | undefined,
): { ok: boolean; provider?: string; detail: string } {
  if (!provider) {
    return { ok: false, detail: "No model provider configured." };
  }
  const authPath = path.join(stateDir, "agents", "main", "agent", "auth-profiles.json");
  if (!existsSync(authPath)) {
    return {
      ok: false,
      provider,
      detail: `No auth-profiles.json found for agent (expected at ${authPath}).`,
    };
  }
  try {
    const raw = JSON.parse(readFileSync(authPath, "utf-8"));
    const profiles = raw?.profiles;
    if (!profiles || typeof profiles !== "object") {
      return { ok: false, provider, detail: `auth-profiles.json has no profiles configured.` };
    }
    const hasKey = Object.values(profiles).some(
      (p: unknown) =>
        p &&
        typeof p === "object" &&
        (p as Record<string, unknown>).provider === provider &&
        typeof (p as Record<string, unknown>).key === "string" &&
        ((p as Record<string, unknown>).key as string).length > 0,
    );
    if (!hasKey) {
      return {
        ok: false,
        provider,
        detail: `No API key for provider "${provider}" in agent auth store.`,
      };
    }
    return { ok: true, provider, detail: `API key configured for ${provider}.` };
  } catch {
    return { ok: false, provider, detail: `Failed to read auth-profiles.json.` };
  }
}

export function buildBootstrapDiagnostics(params: {
  profile: string;
  openClawCliAvailable: boolean;
  openClawVersion?: string;
  gatewayPort: number;
  gatewayUrl: string;
  gatewayProbe: { ok: boolean; detail?: string };
  webPort: number;
  webReachable: boolean;
  rolloutStage: BootstrapRolloutStage;
  legacyFallbackEnabled: boolean;
  stateDir?: string;
  env?: NodeJS.ProcessEnv;
  posthogPluginInstalled?: boolean;
}): BootstrapDiagnostics {
  const env = params.env ?? process.env;
  const checks: BootstrapCheck[] = [];

  if (params.openClawCliAvailable) {
    checks.push(
      createCheck(
        "openclaw-cli",
        "pass",
        `OpenClaw CLI detected${params.openClawVersion ? ` (${params.openClawVersion})` : ""}.`,
      ),
    );
  } else {
    checks.push(
      createCheck(
        "openclaw-cli",
        "fail",
        "OpenClaw CLI is missing.",
        "Install OpenClaw globally once: `npm install -g openclaw`.",
      ),
    );
  }

  if (params.profile === DEFAULT_DENCHCLAW_PROFILE) {
    checks.push(createCheck("profile", "pass", `Profile pinned: ${params.profile}.`));
  } else {
    checks.push(
      createCheck(
        "profile",
        "fail",
        `DenchClaw profile drift detected (${params.profile}).`,
        `DenchClaw requires \`--profile ${DEFAULT_DENCHCLAW_PROFILE}\`. Re-run bootstrap to repair environment defaults.`,
      ),
    );
  }

  if (params.gatewayProbe.ok) {
    checks.push(createCheck("gateway", "pass", `Gateway reachable at ${params.gatewayUrl}.`));
  } else {
    checks.push(
      createCheck(
        "gateway",
        "fail",
        `Gateway probe failed at ${params.gatewayUrl}${params.gatewayProbe.detail ? ` (${params.gatewayProbe.detail})` : ""}.`,
        remediationForGatewayFailure(
          params.gatewayProbe.detail,
          params.gatewayPort,
          params.profile,
        ),
      ),
    );
  }

  const stateDir = params.stateDir ?? resolveProfileStateDir(params.profile, env);
  const modelProvider = resolveModelProvider(stateDir);
  const authCheck = checkAgentAuth(stateDir, modelProvider);
  if (authCheck.ok) {
    checks.push(createCheck("agent-auth", "pass", authCheck.detail));
  } else {
    checks.push(
      createCheck(
        "agent-auth",
        "fail",
        authCheck.detail,
        `Run \`openclaw --profile ${DEFAULT_DENCHCLAW_PROFILE} onboard --install-daemon\` to configure API keys.`,
      ),
    );
  }

  if (params.webReachable) {
    checks.push(createCheck("web-ui", "pass", `Web UI reachable on port ${params.webPort}.`));
  } else {
    checks.push(
      createCheck(
        "web-ui",
        "fail",
        `Web UI is not reachable on port ${params.webPort}.`,
        remediationForWebUiFailure(params.webPort),
      ),
    );
  }

  const expectedStateDir = resolveProfileStateDir(DEFAULT_DENCHCLAW_PROFILE, env);
  const usesPinnedStateDir = path.resolve(stateDir) === path.resolve(expectedStateDir);
  if (usesPinnedStateDir) {
    checks.push(createCheck("state-isolation", "pass", `State dir pinned: ${stateDir}.`));
  } else {
    checks.push(
      createCheck(
        "state-isolation",
        "fail",
        `Unexpected state dir: ${stateDir}.`,
        `DenchClaw requires \`${expectedStateDir}\`. Re-run bootstrap to restore pinned defaults.`,
      ),
    );
  }

  const launchAgentLabel = resolveGatewayLaunchAgentLabel(params.profile);
  const expectedLaunchAgentLabel = resolveGatewayLaunchAgentLabel(DEFAULT_DENCHCLAW_PROFILE);
  if (launchAgentLabel === expectedLaunchAgentLabel) {
    checks.push(createCheck("daemon-label", "pass", `Gateway service label: ${launchAgentLabel}.`));
  } else {
    checks.push(
      createCheck(
        "daemon-label",
        "fail",
        `Gateway service label mismatch (${launchAgentLabel}).`,
        `DenchClaw requires launch agent label ${expectedLaunchAgentLabel}.`,
      ),
    );
  }

  checks.push(
    createCheck(
      "rollout-stage",
      params.rolloutStage === "default" ? "pass" : "warn",
      `Bootstrap rollout stage: ${params.rolloutStage}${params.legacyFallbackEnabled ? " (legacy fallback enabled)" : ""}.`,
      params.rolloutStage === "beta"
        ? "Enable beta cutover by setting DENCHCLAW_BOOTSTRAP_BETA_OPT_IN=1."
        : undefined,
    ),
  );

  const migrationSuiteOk = isTruthyEnvValue(env.DENCHCLAW_BOOTSTRAP_MIGRATION_SUITE_OK);
  const onboardingE2EOk = isTruthyEnvValue(env.DENCHCLAW_BOOTSTRAP_ONBOARDING_E2E_OK);
  const enforceCutoverGates = isTruthyEnvValue(env.DENCHCLAW_BOOTSTRAP_ENFORCE_SAFETY_GATES);
  const cutoverGatePassed = migrationSuiteOk && onboardingE2EOk;
  checks.push(
    createCheck(
      "cutover-gates",
      cutoverGatePassed ? "pass" : enforceCutoverGates ? "fail" : "warn",
      `Cutover gate: migrationSuite=${migrationSuiteOk ? "pass" : "missing"}, onboardingE2E=${onboardingE2EOk ? "pass" : "missing"}.`,
      cutoverGatePassed
        ? undefined
        : "Run migration contracts + onboarding E2E and set DENCHCLAW_BOOTSTRAP_MIGRATION_SUITE_OK=1 and DENCHCLAW_BOOTSTRAP_ONBOARDING_E2E_OK=1 before full cutover.",
    ),
  );

  if (params.posthogPluginInstalled != null) {
    checks.push(
      createCheck(
        "posthog-analytics",
        params.posthogPluginInstalled ? "pass" : "warn",
        params.posthogPluginInstalled
          ? "PostHog analytics plugin installed."
          : "PostHog analytics plugin not installed (POSTHOG_KEY missing or extension not bundled).",
      ),
    );
  }

  return {
    rolloutStage: params.rolloutStage,
    legacyFallbackEnabled: params.legacyFallbackEnabled,
    checks,
    hasFailures: checks.some((check) => check.status === "fail"),
  };
}

function formatCheckStatus(status: BootstrapCheckStatus): string {
  if (status === "pass") {
    return theme.success("[ok]");
  }
  if (status === "warn") {
    return theme.warn("[warn]");
  }
  return theme.error("[fail]");
}

function logBootstrapChecklist(diagnostics: BootstrapDiagnostics, runtime: RuntimeEnv) {
  runtime.log("");
  runtime.log(theme.heading("Bootstrap checklist"));
  for (const check of diagnostics.checks) {
    runtime.log(`${formatCheckStatus(check.status)} ${check.detail}`);
    if (check.status !== "pass" && check.remediation) {
      runtime.log(theme.muted(`       remediation: ${check.remediation}`));
    }
  }
}

async function shouldRunUpdate(params: {
  opts: BootstrapOptions;
  runtime: RuntimeEnv;
  installResult: OpenClawCliAvailability;
}): Promise<boolean> {
  if (params.opts.updateNow) {
    return true;
  }
  if (
    params.opts.skipUpdate ||
    params.opts.nonInteractive ||
    params.opts.json ||
    !process.stdin.isTTY
  ) {
    return false;
  }
  const installedRecently =
    params.installResult.installed ||
    (typeof params.installResult.installedAt === "number" &&
      Date.now() - params.installResult.installedAt <=
        OPENCLAW_UPDATE_PROMPT_SUPPRESS_AFTER_INSTALL_MS);
  if (installedRecently) {
    params.runtime.log(
      theme.muted("Skipping update prompt because OpenClaw was installed moments ago."),
    );
    return false;
  }
  const decision = await confirm({
    message: stylePromptMessage("Check and install OpenClaw updates now?"),
    initialValue: false,
  });
  if (isCancel(decision)) {
    params.runtime.log(theme.muted("Update check skipped."));
    return false;
  }
  return Boolean(decision);
}

export async function bootstrapCommand(
  opts: BootstrapOptions,
  runtime: RuntimeEnv = defaultRuntime,
): Promise<BootstrapSummary> {
  const nonInteractive = Boolean(opts.nonInteractive || opts.json);
  const rolloutStage = resolveBootstrapRolloutStage();
  const legacyFallbackEnabled = isLegacyFallbackEnabled();
  const appliedProfile = applyCliProfileEnv({ profile: opts.profile });
  const profile = appliedProfile.effectiveProfile;
  const stateDir = resolveProfileStateDir(profile);
  const workspaceDir = resolveBootstrapWorkspaceDir(stateDir);
  if (appliedProfile.warning && !opts.json) {
    runtime.log(theme.warn(appliedProfile.warning));
  }

  const bootstrapStartTime = Date.now();

  if (!opts.json) {
    const telemetryCfg = readTelemetryConfig();
    if (!telemetryCfg.noticeShown) {
      runtime.log(
        theme.muted(
          "Dench collects anonymous telemetry to improve the product.\n" +
            "No personal data is ever collected. Disable anytime:\n" +
            "  npx denchclaw telemetry disable\n" +
            "  DENCHCLAW_TELEMETRY_DISABLED=1\n" +
            "  DO_NOT_TRACK=1\n" +
            "Learn more: https://github.com/DenchHQ/DenchClaw/blob/main/TELEMETRY.md\n",
        ),
      );
      markNoticeShown();
    }
  }

  track("cli_bootstrap_started", { version: VERSION });

  const installResult = await ensureOpenClawCliAvailable({
    stateDir,
    showProgress: !opts.json,
  });
  if (!installResult.available) {
    throw new Error(
      [
        "OpenClaw CLI is required but unavailable.",
        "Install it with: npm install -g openclaw",
        installResult.globalBinDir
          ? `Expected global binary directory: ${installResult.globalBinDir}`
          : "",
      ]
        .filter((line) => line.length > 0)
        .join("\n"),
    );
  }
  const openclawCommand = installResult.command;

  if (await shouldRunUpdate({ opts, runtime, installResult })) {
    await runOpenClawWithProgress({
      openclawCommand,
      args: ["update", "--yes"],
      timeoutMs: 8 * 60_000,
      startMessage: "Checking for OpenClaw updates...",
      successMessage: "OpenClaw is up to date.",
      errorMessage: "OpenClaw update failed",
    });
  }

  // Determine gateway port: use explicit override, honour previously persisted
  // port, or find an available one in the DenchClaw range (19001+).
  // NEVER claim OpenClaw's default port (18789) — that belongs to the host
  // OpenClaw installation and sharing it causes port-hijack on restart.
  const explicitPort = parseOptionalPort(opts.gatewayPort);
  let gatewayPort: number;
  let portAutoAssigned = false;

  if (explicitPort) {
    gatewayPort = explicitPort;
  } else {
    const existingPort = readExistingGatewayPort(stateDir);
    if (
      isPersistedPortAcceptable(existingPort) &&
      (await isPortAvailable(existingPort))
    ) {
      gatewayPort = existingPort;
    } else if (await isPortAvailable(DENCHCLAW_GATEWAY_PORT_START)) {
      gatewayPort = DENCHCLAW_GATEWAY_PORT_START;
    } else {
      const availablePort = await findAvailablePort(
        DENCHCLAW_GATEWAY_PORT_START + 1,
        MAX_PORT_SCAN_ATTEMPTS,
      );
      if (!availablePort) {
        throw new Error(
          `Could not find an available gateway port between ${DENCHCLAW_GATEWAY_PORT_START} and ${DENCHCLAW_GATEWAY_PORT_START + MAX_PORT_SCAN_ATTEMPTS}. ` +
            `Please specify a port explicitly with --gateway-port.`,
        );
      }
      gatewayPort = availablePort;
      portAutoAssigned = true;
    }
  }

  if (portAutoAssigned && !opts.json) {
    runtime.log(
      theme.muted(
        `Default gateway port ${DENCHCLAW_GATEWAY_PORT_START} is in use. Using auto-assigned port ${gatewayPort}.`,
      ),
    );
  }

  // Pin OpenClaw to the managed default workspace before onboarding so bootstrap
  // never drifts into creating/using legacy workspace-* paths.
  await ensureDefaultWorkspacePath(openclawCommand, profile, workspaceDir);

  const packageRoot = resolveCliPackageRoot();

  // Install bundled plugins BEFORE onboard so the gateway daemon starts with
  // plugins.allow already configured, suppressing "plugins.allow is empty" warnings.
  const posthogPluginInstalled = await installBundledPlugins({
    openclawCommand,
    profile,
    stateDir,
    posthogKey: process.env.POSTHOG_KEY || "",
  });

  const onboardArgv = [
    "--profile",
    profile,
    "onboard",
    "--install-daemon",
    "--gateway-bind",
    "loopback",
    "--gateway-port",
    String(gatewayPort),
  ];
  if (opts.forceOnboard) {
    onboardArgv.push("--reset");
  }
  if (nonInteractive) {
    onboardArgv.push("--non-interactive");
  }

  onboardArgv.push("--accept-risk", "--skip-ui");

  if (nonInteractive) {
    await runOpenClawOrThrow({
      openclawCommand,
      args: onboardArgv,
      timeoutMs: 12 * 60_000,
      errorMessage: "OpenClaw onboarding failed.",
    });
  } else {
    await runOpenClawInteractiveOrThrow({
      openclawCommand,
      args: onboardArgv,
      timeoutMs: 12 * 60_000,
      errorMessage: "OpenClaw onboarding failed.",
    });
  }

  const workspaceSeed = seedWorkspaceFromAssets({
    workspaceDir,
    packageRoot,
  });

  const postOnboardSpinner = !opts.json ? spinner() : null;
  postOnboardSpinner?.start("Finalizing configuration…");

  // Ensure gateway.mode=local so the gateway never drifts to remote mode.
  // Keep this post-onboard so we normalize any wizard defaults.
  await ensureGatewayModeLocal(openclawCommand, profile);
  postOnboardSpinner?.message("Configuring gateway port…");
  // Persist the assigned port so all runtime clients (including web) resolve
  // the same gateway target on subsequent requests.
  await ensureGatewayPort(openclawCommand, profile, gatewayPort);
  postOnboardSpinner?.message("Setting tools profile…");
  // DenchClaw requires the full tool profile; onboarding defaults can drift to
  // messaging-only, so enforce this on every bootstrap run.
  await ensureToolsProfile(openclawCommand, profile);

  postOnboardSpinner?.message("Configuring subagent defaults…");
  await ensureSubagentDefaults(openclawCommand, profile);

  postOnboardSpinner?.message("Probing gateway health…");
  let gatewayProbe = await probeGateway(openclawCommand, profile, gatewayPort);
  let gatewayAutoFix: GatewayAutoFixResult | undefined;
  if (!gatewayProbe.ok) {
    postOnboardSpinner?.message("Gateway unreachable, attempting auto-fix…");
    gatewayAutoFix = await attemptGatewayAutoFix({
      openclawCommand,
      profile,
      stateDir,
      gatewayPort,
    });
    gatewayProbe = gatewayAutoFix.finalProbe;
    if (!gatewayProbe.ok && gatewayAutoFix.failureSummary) {
      gatewayProbe = {
        ...gatewayProbe,
        detail: [gatewayProbe.detail, gatewayAutoFix.failureSummary]
          .filter((value, index, self) => value && self.indexOf(value) === index)
          .join(" | "),
      };
    }
  }
  const gatewayUrl = `ws://127.0.0.1:${gatewayPort}`;
  const preferredWebPort = parseOptionalPort(opts.webPort) ?? DEFAULT_WEB_APP_PORT;
  postOnboardSpinner?.message(`Starting web runtime on port ${preferredWebPort}…`);
  const webRuntimeStatus = await ensureManagedWebRuntime({
    stateDir,
    packageRoot,
    denchVersion: VERSION,
    port: preferredWebPort,
    gatewayPort,
  });
  postOnboardSpinner?.stop(
    webRuntimeStatus.ready
      ? "Post-onboard setup complete."
      : "Post-onboard setup complete (web runtime unhealthy).",
  );
  const webReachable = webRuntimeStatus.ready;
  const webUrl = `http://localhost:${preferredWebPort}`;
  const diagnostics = buildBootstrapDiagnostics({
    profile,
    openClawCliAvailable: installResult.available,
    openClawVersion: installResult.version,
    gatewayPort,
    gatewayUrl,
    gatewayProbe,
    webPort: preferredWebPort,
    webReachable,
    rolloutStage,
    legacyFallbackEnabled,
    stateDir,
    posthogPluginInstalled,
  });

  let opened = false;
  let openAttempted = false;
  if (!opts.noOpen && !opts.json && webReachable) {
    if (nonInteractive) {
      openAttempted = true;
      opened = await openUrl(webUrl);
    } else {
      const wantOpen = await confirm({
        message: stylePromptMessage(`Open ${webUrl} in your browser?`),
        initialValue: true,
      });
      if (!isCancel(wantOpen) && wantOpen) {
        openAttempted = true;
        opened = await openUrl(webUrl);
      }
    }
  }

  if (!opts.json) {
    if (!webRuntimeStatus.ready) {
      runtime.log(theme.warn(`Managed web runtime check failed: ${webRuntimeStatus.reason}`));
    }
    if (installResult.installed) {
      runtime.log(theme.muted("Installed global OpenClaw CLI via npm."));
    }
    if (isProjectLocalOpenClawPath(installResult.shellCommandPath)) {
      runtime.log(
        theme.warn(
          `\`openclaw\` currently resolves to a project-local binary (${installResult.shellCommandPath}).`,
        ),
      );
      runtime.log(
        theme.muted(
          `Bootstrap now uses the global binary (${openclawCommand}) to avoid repo-local drift.`,
        ),
      );
    } else if (!installResult.shellCommandPath && installResult.globalBinDir) {
      runtime.log(
        theme.warn("Global OpenClaw was installed, but `openclaw` is not on shell PATH."),
      );
      runtime.log(
        theme.muted(
          `Add this to your shell profile, then open a new terminal: export PATH="${installResult.globalBinDir}:$PATH"`,
        ),
      );
    }

    runtime.log(theme.muted(`Workspace seed: ${describeWorkspaceSeedResult(workspaceSeed)}`));
    if (gatewayAutoFix?.attempted) {
      runtime.log(
        theme.muted(
          `Gateway auto-fix ${gatewayAutoFix.recovered ? "recovered connectivity" : "ran but gateway is still unhealthy"}.`,
        ),
      );
      for (const step of gatewayAutoFix.steps) {
        runtime.log(
          theme.muted(
            `  ${step.ok ? "[ok]" : "[fail]"} ${step.name}${step.detail ? ` (${step.detail})` : ""}`,
          ),
        );
      }
      if (!gatewayAutoFix.recovered && gatewayAutoFix.failureSummary) {
        runtime.log(theme.error(`Likely gateway cause: ${gatewayAutoFix.failureSummary}`));
      }
      if (!gatewayAutoFix.recovered && gatewayAutoFix.logExcerpts.length > 0) {
        runtime.log(theme.muted("Recent gateway logs:"));
        for (const excerpt of gatewayAutoFix.logExcerpts) {
          runtime.log(theme.muted(`  ${excerpt.path}`));
          for (const line of excerpt.excerpt.split(/\r?\n/)) {
            runtime.log(theme.muted(`    ${line}`));
          }
        }
      }
    }
    logBootstrapChecklist(diagnostics, runtime);
    runtime.log("");
    runtime.log(theme.heading("DenchClaw ready"));
    runtime.log(`Profile: ${profile}`);
    runtime.log(`OpenClaw CLI: ${installResult.version ?? "detected"}`);
    runtime.log(`Gateway: ${gatewayProbe.ok ? "reachable" : "check failed"}`);
    runtime.log(`Web UI: ${webUrl}`);
    runtime.log(
      `Rollout stage: ${rolloutStage}${legacyFallbackEnabled ? " (legacy fallback enabled)" : ""}`,
    );
    if (!opened && openAttempted) {
      runtime.log(theme.muted("Browser open failed; copy/paste the URL above."));
    }
    if (diagnostics.hasFailures) {
      runtime.log(
        theme.warn(
          "Bootstrap completed with failing checks. Address remediation items above before full cutover.",
        ),
      );
    }
  }

  const summary: BootstrapSummary = {
    profile,
    onboarded: true,
    installedOpenClawCli: installResult.installed,
    openClawCliAvailable: installResult.available,
    openClawVersion: installResult.version,
    gatewayUrl,
    gatewayReachable: gatewayProbe.ok,
    gatewayAutoFix: gatewayAutoFix
      ? {
          attempted: gatewayAutoFix.attempted,
          recovered: gatewayAutoFix.recovered,
          steps: gatewayAutoFix.steps,
          failureSummary: gatewayAutoFix.failureSummary,
          logExcerpts: gatewayAutoFix.logExcerpts,
        }
      : undefined,
    workspaceSeed,
    webUrl,
    webReachable,
    webOpened: opened,
    diagnostics,
  };
  track("cli_bootstrap_completed", {
    duration_ms: Date.now() - bootstrapStartTime,
    workspace_created: Boolean(workspaceSeed),
    gateway_reachable: gatewayProbe.ok,
    web_reachable: webReachable,
    version: VERSION,
  });

  if (opts.json) {
    runtime.log(JSON.stringify(summary, null, 2));
  }
  return summary;
}
