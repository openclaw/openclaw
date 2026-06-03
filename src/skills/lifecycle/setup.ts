import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { sanitizeHostExecEnv } from "../../infra/host-env-security.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { parseFrontmatter, resolveOpenClawMetadata } from "../loading/frontmatter.js";
import { resolveConfiguredSkillEnvOverrides } from "../runtime/env-overrides.js";

const SKILL_MD_CANDIDATES = ["SKILL.md", "skill.md", "skills.md", "SKILL.MD"] as const;

const DEFAULT_SETUP_TIMEOUT_MS = 60_000;

function isReservedSetupEnvName(rawKey: string): boolean {
  const key = rawKey.trim().toUpperCase();
  return (
    key === "SKILL_DIR" ||
    key === "OPENCLAW_HOOK_KIND" ||
    key.startsWith("OPENCLAW_") ||
    key.startsWith("NPM_") ||
    key.startsWith("GITHUB_")
  );
}

function buildRequiredSetupEnv(params: {
  hookEnv: Record<string, string>;
  requiredEnv: readonly string[];
}): Record<string, string> {
  const requestedEnv: Record<string, string> = {};
  for (const envNameRaw of params.requiredEnv) {
    const envName = envNameRaw.trim();
    if (!envName || params.hookEnv[envName] !== undefined || isReservedSetupEnvName(envName)) {
      continue;
    }
    const value = process.env[envName];
    if (value !== undefined) {
      requestedEnv[envName] = value;
    }
  }
  return sanitizeHostExecEnv({
    baseEnv: {},
    overrides: requestedEnv,
    blockPathOverrides: true,
  });
}

function findSkillMd(targetDir: string): string | null {
  for (const candidate of SKILL_MD_CANDIDATES) {
    const filePath = path.join(targetDir, candidate);
    try {
      fs.accessSync(filePath, fs.constants.F_OK);
      return filePath;
    } catch {
      // try next candidate
    }
  }
  return null;
}

export type SkillSetupResult =
  | { ok: true }
  | { ok: false; error: string; failureKind: "setup-failed" | "timeout" };

export type SkillSetupParams = {
  targetDir: string;
  mode: "install" | "update";
  config?: OpenClawConfig;
  skillKey?: string;
  logger?: {
    info?: (message: string) => void;
  };
};

export async function runSkillSetupHook(params: SkillSetupParams): Promise<SkillSetupResult> {
  const skillMdPath = findSkillMd(params.targetDir);
  if (!skillMdPath) {
    return { ok: true };
  }

  let raw: string;
  try {
    raw = fs.readFileSync(skillMdPath, "utf8");
  } catch (err) {
    return {
      ok: false,
      error: `Failed to read SKILL.md for setup hook: ${formatErrorMessage(err)}`,
      failureKind: "setup-failed",
    };
  }

  let frontmatter: Record<string, string>;
  try {
    frontmatter = parseFrontmatter(raw);
  } catch (err) {
    return {
      ok: false,
      error: `Failed to parse SKILL.md frontmatter for setup hook: ${formatErrorMessage(err)}`,
      failureKind: "setup-failed",
    };
  }

  const metadata = resolveOpenClawMetadata(frontmatter);
  if (metadata?.setupError) {
    return {
      ok: false,
      error: metadata.setupError,
      failureKind: "setup-failed",
    };
  }
  const setup = metadata?.setup;
  if (!setup) {
    return { ok: true };
  }

  const resolvedTargetDir = fs.realpathSync(params.targetDir);
  const skillKey =
    params.skillKey ?? metadata?.skillKey ?? frontmatter.name ?? path.basename(resolvedTargetDir);
  const rawScriptPath = path.resolve(resolvedTargetDir, setup.script);
  if (!rawScriptPath.startsWith(resolvedTargetDir + path.sep)) {
    return {
      ok: false,
      error: `Setup script path escapes skill directory: ${setup.script}`,
      failureKind: "setup-failed",
    };
  }

  let scriptPath: string;
  try {
    fs.accessSync(rawScriptPath, fs.constants.F_OK);
    // Resolve symlinks after confirming the file exists to prevent escapes.
    scriptPath = fs.realpathSync(rawScriptPath);
    if (!scriptPath.startsWith(resolvedTargetDir + path.sep)) {
      return {
        ok: false,
        error: `Setup script resolves outside skill directory: ${setup.script}`,
        failureKind: "setup-failed",
      };
    }
  } catch {
    return {
      ok: false,
      error: `Setup script not found: ${setup.script}`,
      failureKind: "setup-failed",
    };
  }

  let executable = true;
  try {
    fs.accessSync(scriptPath, fs.constants.X_OK);
  } catch {
    executable = false;
  }

  const timeoutMs = DEFAULT_SETUP_TIMEOUT_MS;

  const hookEnv: Record<string, string> = {
    SKILL_DIR: resolvedTargetDir,
    OPENCLAW_HOOK_KIND: params.mode,
  };
  const requiredEnv = metadata?.requires?.env ?? [];
  const requiredSetupEnv = buildRequiredSetupEnv({
    hookEnv,
    requiredEnv,
  });
  const configuredSetupEnv = resolveConfiguredSkillEnvOverrides({
    config: params.config,
    skillKey,
    primaryEnv: metadata?.primaryEnv,
    requiredEnv,
  }).allowed;
  const scriptEnv = sanitizeHostExecEnv({
    baseEnv: {},
    overrides: {
      ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
      ...configuredSetupEnv,
      ...requiredSetupEnv,
      ...hookEnv,
    },
    blockPathOverrides: false,
  });

  const argv = executable ? [scriptPath] : ["sh", scriptPath];

  params.logger?.info?.(`Running setup hook: ${setup.script}`);

  try {
    const result = await runCommandWithTimeout(argv, {
      timeoutMs,
      cwd: resolvedTargetDir,
      env: scriptEnv,
      baseEnv: {},
    });

    if (result.code === 0) {
      return { ok: true };
    }

    const detail =
      result.termination === "timeout"
        ? `Setup hook timed out after ${timeoutMs}ms`
        : `Setup hook exited with code ${result.code ?? "null"}`;
    const stderrSuffix = result.stderr.trim() ? `: ${result.stderr.trim()}` : "";
    return {
      ok: false,
      error: `${detail}${stderrSuffix}`,
      failureKind: result.termination === "timeout" ? "timeout" : "setup-failed",
    };
  } catch (err) {
    return {
      ok: false,
      error: `Setup hook failed: ${formatErrorMessage(err)}`,
      failureKind: "setup-failed",
    };
  }
}
