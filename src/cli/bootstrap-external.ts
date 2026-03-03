import { spawn, type StdioOptions } from "node:child_process";
import { cpSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { confirm, isCancel, spinner } from "@clack/prompts";
import { isTruthyEnvValue } from "../infra/env.js";
import { resolveRequiredHomeDir } from "../infra/home-dir.js";
import { defaultRuntime, type RuntimeEnv } from "../runtime.js";
import { stylePromptMessage } from "../terminal/prompt-style.js";
import { theme } from "../terminal/theme.js";
import { applyCliProfileEnv } from "./profile.js";
import { seedWorkspaceFromAssets, type WorkspaceSeedResult } from "./workspace-seed.js";

const DEFAULT_IRONCLAW_PROFILE = "ironclaw";
const IRONCLAW_STATE_DIRNAME = ".openclaw-ironclaw";
const DEFAULT_GATEWAY_PORT = 18789;
const IRONCLAW_GATEWAY_PORT_START = 19001;
const MAX_PORT_SCAN_ATTEMPTS = 100;
const DEFAULT_WEB_APP_PORT = 3100;
const WEB_APP_PROBE_ATTEMPTS = 20;
const WEB_APP_PROBE_DELAY_MS = 750;
const DEFAULT_BOOTSTRAP_ROLLOUT_STAGE = "default";
const DEFAULT_GATEWAY_LAUNCH_AGENT_LABEL = "ai.openclaw.gateway";

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
    | "cutover-gates";
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
  version?: string;
  command: string;
  globalBinDir?: string;
  shellCommandPath?: string;
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
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += String(chunk);
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
    env.IRONCLAW_BOOTSTRAP_ROLLOUT ?? env.OPENCLAW_BOOTSTRAP_ROLLOUT,
  );
}

export function isLegacyFallbackEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    isTruthyEnvValue(env.IRONCLAW_BOOTSTRAP_LEGACY_FALLBACK) ||
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

function resolveProfileStateDir(profile: string, env: NodeJS.ProcessEnv = process.env): string {
  void profile;
  const home = resolveRequiredHomeDir(env, os.homedir);
  return path.join(home, IRONCLAW_STATE_DIRNAME);
}

function resolveGatewayLaunchAgentLabel(profile: string): string {
  const normalized = profile.trim().toLowerCase();
  if (!normalized || normalized === "default") {
    return DEFAULT_GATEWAY_LAUNCH_AGENT_LABEL;
  }
  return `ai.openclaw.${normalized}`;
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

async function probeForWebApp(port: number): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1_500);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/profiles`, {
      method: "GET",
      signal: controller.signal,
      redirect: "manual",
    });
    if (response.status < 200 || response.status >= 400) {
      return false;
    }
    const payload = (await response.json().catch(() => null)) as {
      profiles?: unknown;
      activeProfile?: unknown;
    } | null;
    return Boolean(
      payload &&
      typeof payload === "object" &&
      Array.isArray(payload.profiles) &&
      typeof payload.activeProfile === "string",
    );
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function waitForWebApp(preferredPort: number): Promise<boolean> {
  for (let attempt = 0; attempt < WEB_APP_PROBE_ATTEMPTS; attempt += 1) {
    if (await probeForWebApp(preferredPort)) {
      return true;
    }
    await sleep(WEB_APP_PROBE_DELAY_MS);
  }
  return false;
}

function resolveCliPackageRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    if (existsSync(path.join(dir, "package.json"))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  return process.cwd();
}

/**
 * Spawn the pre-built standalone Next.js server as a detached background
 * process if it isn't already running on the target port.
 */
function startWebAppIfNeeded(port: number, stateDir: string, gatewayPort: number): void {
  const pkgRoot = resolveCliPackageRoot();
  const standaloneServer = path.join(pkgRoot, "apps/web/.next/standalone/apps/web/server.js");
  if (!existsSync(standaloneServer)) {
    return;
  }

  const logDir = path.join(stateDir, "logs");
  mkdirSync(logDir, { recursive: true });
  const outFd = openSync(path.join(logDir, "web-app.log"), "a");
  const errFd = openSync(path.join(logDir, "web-app.err.log"), "a");

  const child = spawn(process.execPath, [standaloneServer], {
    cwd: path.dirname(standaloneServer),
    detached: true,
    stdio: ["ignore", outFd, errFd],
    env: {
      ...process.env,
      PORT: String(port),
      HOSTNAME: "127.0.0.1",
      OPENCLAW_GATEWAY_PORT: String(gatewayPort),
    },
  });
  child.unref();
}

async function runOpenClaw(
  openclawCommand: string,
  args: string[],
  timeoutMs: number,
  ioMode: "capture" | "inherit" = "capture",
  env?: NodeJS.ProcessEnv,
): Promise<SpawnResult> {
  return await runCommandWithTimeout([openclawCommand, ...args], { timeoutMs, ioMode, env });
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

async function detectGlobalOpenClawInstall(): Promise<{ installed: boolean; version?: string }> {
  const result = await runCommandWithTimeout(
    ["npm", "ls", "-g", "openclaw", "--depth=0", "--json", "--silent"],
    {
      timeoutMs: 15_000,
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

async function resolveNpmGlobalBinDir(): Promise<string | undefined> {
  const result = await runCommandWithTimeout(["npm", "prefix", "-g"], {
    timeoutMs: 8_000,
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

async function resolveShellOpenClawPath(): Promise<string | undefined> {
  const locator = process.platform === "win32" ? "where" : "which";
  const result = await runCommandWithTimeout([locator, "openclaw"], {
    timeoutMs: 4_000,
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

async function ensureOpenClawCliAvailable(): Promise<OpenClawCliAvailability> {
  const globalBefore = await detectGlobalOpenClawInstall();
  let installed = false;
  if (!globalBefore.installed) {
    const install = await runCommandWithTimeout(["npm", "install", "-g", "openclaw@latest"], {
      timeoutMs: 10 * 60_000,
    }).catch(() => null);
    if (!install || install.code !== 0) {
      return {
        available: false,
        installed: false,
        version: undefined,
        command: "openclaw",
      };
    }
    installed = true;
  }

  const globalAfter = installed ? await detectGlobalOpenClawInstall() : globalBefore;
  const globalBinDir = await resolveNpmGlobalBinDir();
  const globalCommand = resolveGlobalOpenClawCommand(globalBinDir);
  const command = globalCommand ?? "openclaw";
  const check = await runOpenClaw(command, ["--version"], 4_000).catch(() => null);
  const shellCommandPath = await resolveShellOpenClawPath();
  const version = normalizeVersionOutput(check?.stdout || check?.stderr || globalAfter.version);
  const available = Boolean(globalAfter.installed && check && check.code === 0);
  return {
    available,
    installed,
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
  return `Run \`openclaw --profile ${profile} doctor --fix\` and retry \`ironclaw bootstrap --profile ${profile} --force-onboard\`.`;
}

function remediationForWebUiFailure(port: number): string {
  return `Web UI did not respond on ${port}. Ensure the apps/web directory exists and rerun with \`ironclaw bootstrap --web-port <port>\` if needed.`;
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
 * Sync bundled Dench skill into the active workspace.
 */
function syncBundledDenchSkill(workspaceDir: string): {
  mode: "installed" | "updated";
  targetDir: string;
} {
  const targetDir = path.join(workspaceDir, "skills", "dench");
  const targetSkillFile = path.join(targetDir, "SKILL.md");
  const mode: "installed" | "updated" = existsSync(targetSkillFile) ? "updated" : "installed";
  const sourceDir = path.join(resolveCliPackageRoot(), "skills", "dench");
  const sourceSkillFile = path.join(sourceDir, "SKILL.md");
  if (!existsSync(sourceSkillFile)) {
    throw new Error(
      `Bundled Dench skill not found at ${sourceDir}. Reinstall ironclaw and rerun bootstrap.`,
    );
  }
  mkdirSync(path.dirname(targetDir), { recursive: true });
  // Always replace with the bundled version so ironclaw updates refresh Dench automatically.
  cpSync(sourceDir, targetDir, { recursive: true, force: true });
  return { mode, targetDir };
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

  if (params.profile === DEFAULT_IRONCLAW_PROFILE) {
    checks.push(createCheck("profile", "pass", `Profile pinned: ${params.profile}.`));
  } else {
    checks.push(
      createCheck(
        "profile",
        "fail",
        `Ironclaw profile drift detected (${params.profile}).`,
        `Ironclaw requires \`--profile ${DEFAULT_IRONCLAW_PROFILE}\`. Re-run bootstrap to repair environment defaults.`,
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
        `Run \`openclaw --profile ${DEFAULT_IRONCLAW_PROFILE} onboard --install-daemon\` to configure API keys.`,
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

  const expectedStateDir = resolveProfileStateDir(DEFAULT_IRONCLAW_PROFILE, env);
  const usesPinnedStateDir = path.resolve(stateDir) === path.resolve(expectedStateDir);
  if (usesPinnedStateDir) {
    checks.push(createCheck("state-isolation", "pass", `State dir pinned: ${stateDir}.`));
  } else {
    checks.push(
      createCheck(
        "state-isolation",
        "fail",
        `Unexpected state dir: ${stateDir}.`,
        `Ironclaw requires \`${expectedStateDir}\`. Re-run bootstrap to restore pinned defaults.`,
      ),
    );
  }

  const launchAgentLabel = resolveGatewayLaunchAgentLabel(params.profile);
  const expectedLaunchAgentLabel = resolveGatewayLaunchAgentLabel(DEFAULT_IRONCLAW_PROFILE);
  if (launchAgentLabel === expectedLaunchAgentLabel) {
    checks.push(createCheck("daemon-label", "pass", `Gateway service label: ${launchAgentLabel}.`));
  } else {
    checks.push(
      createCheck(
        "daemon-label",
        "fail",
        `Gateway service label mismatch (${launchAgentLabel}).`,
        `Ironclaw requires launch agent label ${expectedLaunchAgentLabel}.`,
      ),
    );
  }

  checks.push(
    createCheck(
      "rollout-stage",
      params.rolloutStage === "default" ? "pass" : "warn",
      `Bootstrap rollout stage: ${params.rolloutStage}${params.legacyFallbackEnabled ? " (legacy fallback enabled)" : ""}.`,
      params.rolloutStage === "beta"
        ? "Enable beta cutover by setting IRONCLAW_BOOTSTRAP_BETA_OPT_IN=1."
        : undefined,
    ),
  );

  const migrationSuiteOk = isTruthyEnvValue(env.IRONCLAW_BOOTSTRAP_MIGRATION_SUITE_OK);
  const onboardingE2EOk = isTruthyEnvValue(env.IRONCLAW_BOOTSTRAP_ONBOARDING_E2E_OK);
  const enforceCutoverGates = isTruthyEnvValue(env.IRONCLAW_BOOTSTRAP_ENFORCE_SAFETY_GATES);
  const cutoverGatePassed = migrationSuiteOk && onboardingE2EOk;
  checks.push(
    createCheck(
      "cutover-gates",
      cutoverGatePassed ? "pass" : enforceCutoverGates ? "fail" : "warn",
      `Cutover gate: migrationSuite=${migrationSuiteOk ? "pass" : "missing"}, onboardingE2E=${onboardingE2EOk ? "pass" : "missing"}.`,
      cutoverGatePassed
        ? undefined
        : "Run migration contracts + onboarding E2E and set IRONCLAW_BOOTSTRAP_MIGRATION_SUITE_OK=1 and IRONCLAW_BOOTSTRAP_ONBOARDING_E2E_OK=1 before full cutover.",
    ),
  );

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
  if (appliedProfile.warning && !opts.json) {
    runtime.log(theme.warn(appliedProfile.warning));
  }

  const installResult = await ensureOpenClawCliAvailable();
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

  if (await shouldRunUpdate({ opts, runtime })) {
    await runOpenClawWithProgress({
      openclawCommand,
      args: ["update", "--yes"],
      timeoutMs: 8 * 60_000,
      startMessage: "Checking for OpenClaw updates...",
      successMessage: "OpenClaw is up to date.",
      errorMessage: "OpenClaw update failed",
    });
  }

  // Determine gateway port: use explicit override, or find available port
  const explicitPort = parseOptionalPort(opts.gatewayPort);
  let gatewayPort: number;
  let portAutoAssigned = false;

  if (explicitPort) {
    gatewayPort = explicitPort;
  } else if (await isPortAvailable(DEFAULT_GATEWAY_PORT)) {
    gatewayPort = DEFAULT_GATEWAY_PORT;
  } else {
    // Default port is taken, find an available one starting from Ironclaw range
    const availablePort = await findAvailablePort(
      IRONCLAW_GATEWAY_PORT_START,
      MAX_PORT_SCAN_ATTEMPTS,
    );
    if (!availablePort) {
      throw new Error(
        `Could not find an available gateway port between ${IRONCLAW_GATEWAY_PORT_START} and ${IRONCLAW_GATEWAY_PORT_START + MAX_PORT_SCAN_ATTEMPTS}. ` +
          `Please specify a port explicitly with --gateway-port.`,
      );
    }
    gatewayPort = availablePort;
    portAutoAssigned = true;
  }

  const stateDir = resolveProfileStateDir(profile);
  const workspaceDir = resolveBootstrapWorkspaceDir(stateDir);

  if (portAutoAssigned && !opts.json) {
    runtime.log(
      theme.muted(
        `Default gateway port ${DEFAULT_GATEWAY_PORT} is in use. Using auto-assigned port ${gatewayPort}.`,
      ),
    );
  }

  // Pin OpenClaw to the managed default workspace before onboarding so bootstrap
  // never drifts into creating/using legacy workspace-* paths.
  await ensureDefaultWorkspacePath(openclawCommand, profile, workspaceDir);

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
    onboardArgv.push("--non-interactive", "--accept-risk");
  }
  if (opts.noOpen) {
    onboardArgv.push("--skip-ui");
  }
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

  const denchInstall = syncBundledDenchSkill(workspaceDir);
  const workspaceSeed = seedWorkspaceFromAssets({
    workspaceDir,
    packageRoot: resolveCliPackageRoot(),
  });

  // Ensure gateway.mode=local so the gateway never drifts to remote mode.
  // Keep this post-onboard so we normalize any wizard defaults.
  await ensureGatewayModeLocal(openclawCommand, profile);
  // Persist the assigned port so all runtime clients (including web) resolve
  // the same gateway target on subsequent requests.
  await ensureGatewayPort(openclawCommand, profile, gatewayPort);

  let gatewayProbe = await probeGateway(openclawCommand, profile, gatewayPort);
  let gatewayAutoFix: GatewayAutoFixResult | undefined;
  if (!gatewayProbe.ok) {
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

  if (!(await probeForWebApp(preferredWebPort))) {
    startWebAppIfNeeded(preferredWebPort, stateDir, gatewayPort);
  }

  const webReachable = await waitForWebApp(preferredWebPort);
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
  });

  const shouldOpen = !opts.noOpen && !opts.json;
  const opened = shouldOpen ? await openUrl(webUrl) : false;

  if (!opts.json) {
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

    runtime.log(theme.muted(`Dench skill ${denchInstall.mode}: ${denchInstall.targetDir}`));
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
    runtime.log(theme.heading("IronClaw ready"));
    runtime.log(`Profile: ${profile}`);
    runtime.log(`OpenClaw CLI: ${installResult.version ?? "detected"}`);
    runtime.log(`Gateway: ${gatewayProbe.ok ? "reachable" : "check failed"}`);
    runtime.log(`Web UI: ${webUrl}`);
    runtime.log(
      `Rollout stage: ${rolloutStage}${legacyFallbackEnabled ? " (legacy fallback enabled)" : ""}`,
    );
    if (!opened && shouldOpen) {
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
  if (opts.json) {
    runtime.log(JSON.stringify(summary, null, 2));
  }
  return summary;
}
