import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  getAgentWorkspaceAccess,
  WorkspaceAccessUnavailableError,
} from "../../agents/workspace-access.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveBrewExecutable } from "../../infra/brew.js";
import { isContainerEnvironment } from "../../infra/container-environment.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { evaluateSkillInstallPolicy } from "../../plugins/install-security-scan.js";
import { runCommandWithTimeout, type CommandOptions } from "../../process/exec.js";
import { resolveUserPath } from "../../utils.js";
import { hasBinary, resolveSkillsInstallPreferences } from "../loading/config.js";
import { resolveSkillKey } from "../loading/frontmatter.js";
import { resolveSkillSource } from "../loading/source.js";
import { prepareWorkspaceSkills } from "../loading/workspace-skill-loader.js";
import type { SkillInstallSpec, SkillsInstallPreferences } from "../types.js";
import { installDownloadSpec } from "./install-download.js";
import { formatInstallFailureMessage } from "./install-output.js";
import {
  findInstallSpec,
  normalizeSkillInstallSpec,
  withSkillInstallPolicySource,
} from "./install-policy-source.js";
import type { SkillInstallResult, SkillInstallSkipReason } from "./install-types.js";
import type { WorkspaceSkillLifecycle } from "./workspace-types.js";

type SkillInstallRequest = {
  workspaceDir: string;
  agentId?: string;
  skillName: string;
  installId: string;
  timeoutMs?: number;
  config?: OpenClawConfig;
};
export type { SkillInstallSkipReason } from "./install-types.js";

function withWarnings(result: SkillInstallResult, warnings: string[]): SkillInstallResult {
  if (warnings.length === 0) {
    return result;
  }
  return {
    ...result,
    warnings: warnings.slice(),
  };
}

const DEFAULT_NODE_INSTALL_COMMAND = ["npm", "install", "-g", "--ignore-scripts"];
const NODE_INSTALL_COMMANDS = new Map([
  ["pnpm", ["pnpm", "add", "-g", "--ignore-scripts"]],
  ["yarn", ["yarn", "global", "add", "--ignore-scripts"]],
  ["bun", ["bun", "add", "-g", "--ignore-scripts"]],
]);

// Strict allowlist patterns to prevent option injection and malicious package names.
const SAFE_BREW_FORMULA = /^[a-z0-9][a-z0-9+._@-]*(\/[a-z0-9][a-z0-9+._@-]*){0,2}$/;
const SAFE_NODE_PACKAGE = /^(@[a-z0-9._-]+\/)?[a-z0-9._-]+(@[a-z0-9^~>=<.*|-]+)?$/;
const SAFE_GO_MODULE = /^[a-zA-Z0-9][a-zA-Z0-9._/-]*@[a-z0-9v._-]+$/;
const SAFE_UV_PACKAGE =
  /^[a-z0-9][a-z0-9._-]*(\[[a-z0-9,._-]+\])?(([><=!~]=?|===?)[a-z0-9.*_-]+)?$/i;

type InstallCommand = { argv: string[] } | { error: string };

function buildValidatedInstallCommand(
  value: string | undefined,
  kind: string,
  pattern: RegExp,
  command: readonly string[],
): InstallCommand {
  if (!value) {
    return { error: `missing ${kind}` };
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("-")) {
    return { error: `${kind} value is empty or starts with a dash` };
  }
  if (!pattern.test(trimmed)) {
    return { error: `${kind} value contains invalid characters: ${trimmed}` };
  }
  return { argv: [...command, trimmed] };
}

function buildInstallCommand(
  spec: SkillInstallSpec,
  prefs: SkillsInstallPreferences,
): InstallCommand {
  switch (spec.kind) {
    case "brew":
      return buildValidatedInstallCommand(spec.formula, "brew formula", SAFE_BREW_FORMULA, [
        "brew",
        "install",
      ]);
    case "node":
      return buildValidatedInstallCommand(
        spec.package,
        "node package",
        SAFE_NODE_PACKAGE,
        NODE_INSTALL_COMMANDS.get(prefs.nodeManager) ?? DEFAULT_NODE_INSTALL_COMMAND,
      );
    case "go":
      return buildValidatedInstallCommand(spec.module, "go module", SAFE_GO_MODULE, [
        "go",
        "install",
      ]);
    case "uv":
      return buildValidatedInstallCommand(spec.package, "uv package", SAFE_UV_PACKAGE, [
        "uv",
        "tool",
        "install",
      ]);
    default:
      return { error: "unsupported installer" };
  }
}

async function resolveBrewBinDir(
  timeoutMs: number,
  brewExe: string,
  fallbackDirs: readonly string[] = ["/opt/homebrew/bin", "/usr/local/bin"],
): Promise<string | undefined> {
  const prefixResult = await runCommandSafely([brewExe, "--prefix"], {
    timeoutMs: Math.min(timeoutMs, 30_000),
  });
  if (prefixResult.code === 0) {
    const prefix = prefixResult.stdout.trim();
    if (prefix) {
      return path.join(prefix, "bin");
    }
  }
  for (const candidate of fallbackDirs) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

type CommandResult = Pick<SkillInstallResult, "code" | "stdout" | "stderr">;

function createInstallFailure(params: {
  message: string;
  stdout?: string;
  stderr?: string;
  code?: number | null;
  skipReason?: SkillInstallSkipReason;
}): SkillInstallResult {
  return {
    ok: false,
    message: params.message,
    stdout: params.stdout?.trim() ?? "",
    stderr: params.stderr?.trim() ?? "",
    code: params.code ?? null,
    ...(params.skipReason ? { skipReason: params.skipReason } : {}),
  };
}

async function runCommandSafely(
  argv: string[],
  optionsOrTimeout: number | CommandOptions,
): Promise<CommandResult> {
  try {
    return await runCommandWithTimeout(argv, optionsOrTimeout);
  } catch (err) {
    return {
      code: null,
      stdout: "",
      stderr: formatErrorMessage(err),
    };
  }
}

function resolveBrewMissingFailure(spec: SkillInstallSpec): SkillInstallResult {
  if (process.platform === "freebsd") {
    return createInstallFailure({
      message:
        "brew not installed — Homebrew is not supported on FreeBSD. Install the required binaries on the Gateway host using pkg or Ports, then run `openclaw skills check` (use `--agent <id>` for a specific agent) to verify readiness.",
    });
  }
  const formula = spec.formula ?? "this package";
  if (process.platform === "linux" && isContainerEnvironment()) {
    return createInstallFailure({
      message: `brew not installed — Homebrew is not installed in this Linux container. Build a custom image with Homebrew or install "${formula}" manually using a supported system package before enabling this skill.`,
    });
  }
  const hint =
    process.platform === "linux"
      ? `Homebrew is not installed. Install it from https://brew.sh or install "${formula}" manually using your system package manager (e.g. apt, dnf, pacman).`
      : "Homebrew is not installed. Install it from https://brew.sh";
  return createInstallFailure({ message: `brew not installed — ${hint}` });
}

// Go 1.21 is the onboarding auto-install baseline. Module-specific toolchain
// requirements stay with `go install`, which can honor local, path, or automatic
// switching according to the user's GOTOOLCHAIN setting.
const MIN_AUTO_GO_MAJOR = 1;
const MIN_AUTO_GO_MINOR = 21;
export const MIN_AUTO_GO_VERSION = `${MIN_AUTO_GO_MAJOR}.${MIN_AUTO_GO_MINOR}`;

const APT_GO_PACKAGE = "golang-go";
const APT_GO_POLICY_ARGV = ["apt-cache", "policy", APT_GO_PACKAGE];
const APT_GO_UPDATE_ARGV = ["apt-get", "update", "-qq"];
const APT_GO_INSTALL_ARGV = ["apt-get", "install", "-y", APT_GO_PACKAGE];
const SUDO_NONINTERACTIVE_PREFIX = ["sudo", "-n"];
const SUDO_APT_GO_CHECK_ARGVS = [
  ["sudo", "-k", "-n", "-ll", ...APT_GO_UPDATE_ARGV],
  ["sudo", "-k", "-n", "-ll", ...APT_GO_INSTALL_ARGV],
];
const GO_VERSION_ENV_ARGV = ["go", "env", "GOVERSION"];

type GoVersion = { major: number; minor: number };

type AptCommandAccess =
  | { available: true; prefix: string[] }
  | {
      available: false;
      reason: "sudo-missing" | "sudo-unusable";
      failure?: CommandResult;
    };

function isSupportedGoVersion(version: GoVersion): boolean {
  return (
    version.major > MIN_AUTO_GO_MAJOR ||
    (version.major === MIN_AUTO_GO_MAJOR && version.minor >= MIN_AUTO_GO_MINOR)
  );
}

function appendPathDirectory(pathEnv: string | undefined, directory: string): string {
  if ((pathEnv ?? "").split(path.delimiter).includes(directory)) {
    return pathEnv ?? directory;
  }
  return pathEnv ? `${pathEnv}${path.delimiter}${directory}` : directory;
}

function sudoListAllowsPasswordlessCommand(output: string): boolean {
  const optionsLine = output.split(/\r?\n/).find((line) => /^\s*Options:\s*/.test(line));
  if (!optionsLine) {
    return false;
  }
  return optionsLine
    .slice(optionsLine.indexOf(":") + 1)
    .split(",")
    .some((option) => option.trim() === "!authenticate");
}

async function resolveAptCommandAccess(): Promise<AptCommandAccess> {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    return { available: true, prefix: [] };
  }
  if (!hasBinary("sudo")) {
    return { available: false, reason: "sudo-missing" };
  }
  for (const argv of SUDO_APT_GO_CHECK_ARGVS) {
    const sudoCheck = await runCommandSafely(argv, {
      timeoutMs: 5_000,
      env: { LC_ALL: "C" },
    });
    if (sudoCheck.code !== 0) {
      return { available: false, reason: "sudo-unusable", failure: sudoCheck };
    }
    if (!sudoListAllowsPasswordlessCommand(sudoCheck.stdout)) {
      return {
        available: false,
        reason: "sudo-unusable",
        failure: {
          code: 1,
          stdout: sudoCheck.stdout,
          stderr: sudoCheck.stderr || "sudo rule requires authentication",
        },
      };
    }
  }
  return { available: true, prefix: SUDO_NONINTERACTIVE_PREFIX };
}

async function installGoViaApt(timeoutMs: number): Promise<SkillInstallResult | undefined> {
  const aptFailureMessage =
    "go not installed — automatic install via apt failed. Install manually: https://go.dev/doc/install";
  const access = await resolveAptCommandAccess();
  if (!access.available && access.reason === "sudo-missing") {
    return createInstallFailure({
      message:
        "go not installed — apt-get is available but sudo is not installed. Install manually: https://go.dev/doc/install",
    });
  }
  if (!access.available) {
    return createInstallFailure({
      message:
        "go not installed — apt-get is available but sudo is not usable (missing or requires a password). Install manually: https://go.dev/doc/install",
      ...access.failure,
    });
  }

  const update = await runCommandSafely([...access.prefix, ...APT_GO_UPDATE_ARGV], {
    timeoutMs,
  });
  const policy = await runCommandSafely(APT_GO_POLICY_ARGV, {
    timeoutMs: Math.min(timeoutMs, 10_000),
    env: { LC_ALL: "C" },
  });
  if (policy.code !== 0) {
    return createInstallFailure({ message: aptFailureMessage, ...policy });
  }
  const candidate = parseGoVersion(/Candidate:\s*(?:\d+:)?(\d+)\.(\d+)/.exec(policy.stdout));
  if (!candidate && update.code !== 0) {
    return createInstallFailure({ message: aptFailureMessage, ...update });
  }
  if (!candidate || !isSupportedGoVersion(candidate)) {
    return createInstallFailure({
      message: `go not installed — apt does not provide a usable Go ${MIN_AUTO_GO_VERSION}+ package. Install manually: https://go.dev/doc/install`,
      skipReason: "go",
    });
  }

  const aptResult = await runCommandSafely([...access.prefix, ...APT_GO_INSTALL_ARGV], {
    timeoutMs,
  });
  if (aptResult.code === 0) {
    return undefined;
  }

  return createInstallFailure({
    message: aptFailureMessage,
    ...aptResult,
  });
}

export type SkillInstallReadiness =
  | { ready: true }
  | { ready: false; reason: SkillInstallSkipReason };

function parseGoVersion(match: RegExpExecArray | null): GoVersion | undefined {
  if (!match) {
    return undefined;
  }
  return { major: Number(match[1]), minor: Number(match[2]) };
}

async function isGoUsableForAutoInstall(): Promise<boolean> {
  const versionResult = await runCommandSafely(GO_VERSION_ENV_ARGV, {
    timeoutMs: 5_000,
    env: { GOTOOLCHAIN: "local" },
  });
  if (versionResult.code !== 0) {
    return false;
  }
  const version = parseGoVersion(/\bgo(\d+)\.(\d+)(?:[.\w-]*)?\b/.exec(versionResult.stdout));
  return version !== undefined && isSupportedGoVersion(version);
}

function isGoToolchainPrerequisiteFailure(result: SkillInstallResult): boolean {
  const output = `${result.message}\n${result.stdout}\n${result.stderr}`;
  return (
    /requires go >= \S+ \(running go \S+(?:; GOTOOLCHAIN=[^)]+)?\)/i.test(output) ||
    /invalid GOTOOLCHAIN/i.test(output) ||
    /cannot find "go[^"]+" in PATH/i.test(output)
  );
}

/**
 * Preflight twin of installSkillDependencies' prerequisite fallbacks. Says whether
 * a recipe can run without manual setup so callers can skip doomed installs.
 *
 * uv bootstraps count only on-PATH brew because the recipe still spawns bare `uv`.
 * Go installs can use a resolved brew prefix because installSkill carries that bin
 * into the child and current PATH. Brew recipes swap argv[0] to the resolved path.
 */
export async function resolveInstallerKindReadiness(kind: string): Promise<SkillInstallReadiness> {
  const brewOnPath = hasBinary("brew");
  const brewExe = brewOnPath ? "brew" : resolveBrewExecutable();
  switch (kind) {
    case "brew":
      return brewExe ? { ready: true } : { ready: false, reason: "brew" };
    case "uv": {
      if (hasBinary("uv")) {
        return { ready: true };
      }
      return brewOnPath ? { ready: true } : { ready: false, reason: "uv" };
    }
    case "go": {
      let ready: boolean;
      if (hasBinary("go")) {
        ready = await isGoUsableForAutoInstall();
      } else if (brewOnPath) {
        ready = true;
      } else if (brewExe) {
        ready = Boolean(await resolveBrewBinDir(10_000, brewExe, []));
      } else {
        ready = hasBinary("apt-get") && (await resolveAptCommandAccess()).available;
      }
      return ready ? { ready: true } : { ready: false, reason: "go" };
    }
    default:
      return { ready: true };
  }
}

export async function installSkill(params: SkillInstallRequest): Promise<SkillInstallResult> {
  const timeoutMs = Math.min(Math.max(params.timeoutMs ?? 300_000, 1_000), 900_000);
  const workspaceDir = resolveUserPath(params.workspaceDir);
  // Match status inventory: operators can install dependencies for hidden skills.
  const entries = await prepareWorkspaceSkills(workspaceDir, {
    config: params.config,
    agentId: params.agentId,
    agentSkillFilter: "ignore",
  });
  const entry = entries.find((item) => item.skill.name === params.skillName);
  if (!entry) {
    return createInstallFailure({ message: `Skill not found: ${params.skillName}` });
  }

  const spec = findInstallSpec(entry, params.installId);
  const warnings: string[] = [];
  const skillSource = resolveSkillSource(entry.skill);
  const normalizedSpec = spec ? normalizeSkillInstallSpec(spec) : undefined;
  const workspaceAccess = getAgentWorkspaceAccess(workspaceDir, "loadSkills");
  const access = workspaceAccess?.loadSkills ? workspaceAccess : undefined;
  if (access && !access.installSkillDependencies) {
    throw new WorkspaceAccessUnavailableError(
      "Remote skill dependency installation is unavailable",
    );
  }
  const scanResult = await withSkillInstallPolicySource(entry.skill, access, (sourceDir) =>
    evaluateSkillInstallPolicy({
      config: params.config,
      installId: params.installId,
      ...(normalizedSpec ? { installSpec: normalizedSpec } : {}),
      logger: {
        warn: (message) => warnings.push(message),
      },
      origin: {
        type: skillSource,
        skillName: params.skillName,
        installId: params.installId,
      },
      source:
        skillSource === "openclaw-bundled"
          ? { kind: "bundled", authority: "openclaw", mutable: false, network: false }
          : skillSource === "openclaw-managed" || skillSource === "openclaw-extra"
            ? { kind: "managed", authority: "openclaw", mutable: false, network: false }
            : { kind: "workspace", authority: "user", mutable: true, network: false },
      requestedSpecifier: `${params.skillName}:${params.installId}`,
      skillName: params.skillName,
      sourceDir,
    }),
  );
  if (scanResult?.blocked) {
    return withWarnings(createInstallFailure({ message: scanResult.blocked.reason }), warnings);
  }
  // Warn when install is triggered from a non-bundled source.
  // Workspace/project/personal agent skills can contain attacker-controlled metadata.
  const trustedInstallSources = new Set(["openclaw-bundled", "openclaw-managed", "openclaw-extra"]);
  if (!trustedInstallSources.has(skillSource)) {
    warnings.push(
      `WARNING: Skill "${params.skillName}" install triggered from non-bundled source "${skillSource}". Verify the install recipe is trusted.`,
    );
  }
  if (!spec) {
    return withWarnings(
      createInstallFailure({ message: `Installer not found: ${params.installId}` }),
      warnings,
    );
  }
  const request = {
    skillKey: resolveSkillKey(entry),
    spec,
    preferences: resolveSkillsInstallPreferences(params.config),
    timeoutMs,
  };
  const result = access
    ? await access.installSkillDependencies!(request)
    : await installSkillDependencies(request);
  return withWarnings(result, warnings);
}

/** Runs only the approved recipe on the host that owns the Harness tools directory. */
export async function installSkillDependencies(
  params: Parameters<WorkspaceSkillLifecycle["installSkillDependencies"]>[0],
): Promise<SkillInstallResult> {
  const { skillKey, spec, preferences: prefs } = params;
  const timeoutMs = Math.min(Math.max(params.timeoutMs, 1_000), 900_000);
  if (spec.kind === "download") {
    return installDownloadSpec({ skillKey, spec, timeoutMs });
  }

  const command = buildInstallCommand(spec, prefs);
  if ("error" in command) {
    return createInstallFailure({ message: command.error });
  }

  const brewExe = hasBinary("brew") ? "brew" : resolveBrewExecutable();
  if (spec.kind === "brew" && !brewExe) {
    return resolveBrewMissingFailure(spec);
  }

  const goWasAlreadyInstalled = spec.kind === "go" && hasBinary("go");
  if ((spec.kind === "uv" && !hasBinary("uv")) || (spec.kind === "go" && !goWasAlreadyInstalled)) {
    if (brewExe) {
      const result = await runCommandSafely([brewExe, "install", spec.kind], { timeoutMs });
      if (result.code !== 0) {
        return createInstallFailure({
          message: `Failed to install ${spec.kind} (brew)`,
          ...result,
        });
      }
    } else if (spec.kind === "go" && hasBinary("apt-get")) {
      const failure = await installGoViaApt(timeoutMs);
      if (failure) {
        return failure;
      }
    } else {
      return createInstallFailure({
        message:
          spec.kind === "uv"
            ? "uv not installed — install manually: https://docs.astral.sh/uv/getting-started/installation/"
            : "go not installed — install manually: https://go.dev/doc/install",
      });
    }
  }

  const { argv } = command;
  if (spec.kind === "brew" && brewExe && argv[0] === "brew") {
    argv[0] = brewExe;
  }

  const envOverrides: NodeJS.ProcessEnv = {};
  let installedGoBin: string | undefined;
  if (spec.kind === "node" && prefs.nodeManager === "npm") {
    const stateDir =
      process.platform !== "win32" && process.getuid?.() === 0
        ? path.join(path.parse(process.cwd()).root, "var", "lib", "openclaw")
        : path.join(os.homedir(), ".openclaw");
    const prefix = path.join(stateDir, "tools", "node", "npm");
    await fs.promises.mkdir(prefix, { recursive: true, mode: 0o700 });
    envOverrides.NPM_CONFIG_PREFIX = prefix;
    envOverrides.npm_config_prefix = prefix;
  }
  if (spec.kind === "go") {
    const brewBin =
      brewExe && !goWasAlreadyInstalled ? await resolveBrewBinDir(timeoutMs, brewExe) : undefined;
    // Skill dependencies use a restart-stable bin directory without changing
    // the operator's Go configuration.
    installedGoBin = brewBin ?? path.join(os.homedir(), ".local", "bin");
    envOverrides.GOBIN = installedGoBin;
    envOverrides.PATH = appendPathDirectory(process.env.PATH, installedGoBin);
  }
  const env = Object.keys(envOverrides).length > 0 ? envOverrides : undefined;

  const result = await runCommandSafely(argv, { timeoutMs, env });
  if (result.code === 0) {
    // Keep the just-installed command discoverable without requiring a gateway restart.
    if (installedGoBin && envOverrides.PATH) {
      process.env.PATH = envOverrides.PATH;
    }
    return {
      ok: true,
      message: "Installed",
      stdout: result.stdout.trim(),
      stderr: result.stderr.trim(),
      code: result.code,
    };
  }
  const installResult = createInstallFailure({
    message: formatInstallFailureMessage(result),
    ...result,
  });
  return spec.kind === "go" && isGoToolchainPrerequisiteFailure(installResult)
    ? { ...installResult, skipReason: "go" as const }
    : installResult;
}
