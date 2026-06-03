import fs from "node:fs";
import path from "node:path";
import { formatErrorMessage } from "../../infra/errors.js";
import { sanitizeHostExecEnv } from "../../infra/host-env-security.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { parseFrontmatter, resolveOpenClawMetadata } from "../loading/frontmatter.js";

const SKILL_MD_CANDIDATES = ["SKILL.md", "skill.md", "skills.md", "SKILL.MD"] as const;

const DEFAULT_SETUP_TIMEOUT_MS = 60_000;

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

function setupFailed(
  error: string,
  failureKind: "setup-failed" | "timeout" = "setup-failed",
): SkillSetupResult {
  return { ok: false, error, failureKind };
}

export type SkillSetupParams = {
  targetDir: string;
  mode: "install" | "update";
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
    return setupFailed(`Failed to read SKILL.md for setup hook: ${formatErrorMessage(err)}`);
  }

  let frontmatter: Record<string, string>;
  try {
    frontmatter = parseFrontmatter(raw);
  } catch (err) {
    return setupFailed(
      `Failed to parse SKILL.md frontmatter for setup hook: ${formatErrorMessage(err)}`,
    );
  }

  const metadata = resolveOpenClawMetadata(frontmatter);
  if (metadata?.setupError) {
    return setupFailed(metadata.setupError);
  }
  const setup = metadata?.setup;
  if (!setup) {
    return { ok: true };
  }

  const resolvedTargetDir = fs.realpathSync(params.targetDir);
  const rawScriptPath = path.resolve(resolvedTargetDir, setup.script);
  if (!rawScriptPath.startsWith(resolvedTargetDir + path.sep)) {
    return setupFailed(`Setup script path escapes skill directory: ${setup.script}`);
  }

  let scriptPath: string;
  try {
    fs.accessSync(rawScriptPath, fs.constants.F_OK);
    // Resolve symlinks after confirming the file exists to prevent escapes.
    scriptPath = fs.realpathSync(rawScriptPath);
    if (!scriptPath.startsWith(resolvedTargetDir + path.sep)) {
      return setupFailed(`Setup script resolves outside skill directory: ${setup.script}`);
    }
  } catch {
    return setupFailed(`Setup script not found: ${setup.script}`);
  }

  let executable = true;
  try {
    fs.accessSync(scriptPath, fs.constants.X_OK);
  } catch {
    executable = false;
  }

  const timeoutMs = DEFAULT_SETUP_TIMEOUT_MS;

  const scriptEnv = sanitizeHostExecEnv({
    baseEnv: {},
    overrides: {
      ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
      SKILL_DIR: resolvedTargetDir,
      OPENCLAW_HOOK_KIND: params.mode,
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
    return setupFailed(
      `${detail}${stderrSuffix}`,
      result.termination === "timeout" ? "timeout" : "setup-failed",
    );
  } catch (err) {
    return setupFailed(`Setup hook failed: ${formatErrorMessage(err)}`);
  }
}
