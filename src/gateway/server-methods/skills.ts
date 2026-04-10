import fs from "node:fs";
import path from "node:path";
import {
  listAgentIds,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../../agents/agent-scope.js";
import { installSkill } from "../../agents/skills-install.js";
import { buildWorkspaceSkillStatus } from "../../agents/skills-status.js";
import { loadWorkspaceSkillEntries, type SkillEntry } from "../../agents/skills.js";
import { listAgentWorkspaceDirs } from "../../agents/workspace-dirs.js";
import type { OpenClawConfig } from "../../config/config.js";
import { loadConfig, writeConfigFile } from "../../config/config.js";
import { getRemoteSkillEligibility } from "../../infra/skills-remote.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { CONFIG_DIR } from "../../utils.js";
import { normalizeSecretInput } from "../../utils/normalize-secret-input.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateSkillsBinsParams,
  validateSkillsDownloadParams,
  validateSkillsInstallParams,
  validateSkillsRemoveParams,
  validateSkillsStatusParams,
  validateSkillsUpdateParams,
} from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

function collectSkillBins(entries: SkillEntry[]): string[] {
  const bins = new Set<string>();
  for (const entry of entries) {
    const required = entry.metadata?.requires?.bins ?? [];
    const anyBins = entry.metadata?.requires?.anyBins ?? [];
    const install = entry.metadata?.install ?? [];
    for (const bin of required) {
      const trimmed = bin.trim();
      if (trimmed) {
        bins.add(trimmed);
      }
    }
    for (const bin of anyBins) {
      const trimmed = bin.trim();
      if (trimmed) {
        bins.add(trimmed);
      }
    }
    for (const spec of install) {
      const specBins = spec?.bins ?? [];
      for (const bin of specBins) {
        const trimmed = String(bin).trim();
        if (trimmed) {
          bins.add(trimmed);
        }
      }
    }
  }
  return [...bins].toSorted();
}

export const skillsHandlers: GatewayRequestHandlers = {
  "skills.status": ({ params, respond }) => {
    if (!validateSkillsStatusParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid skills.status params: ${formatValidationErrors(validateSkillsStatusParams.errors)}`,
        ),
      );
      return;
    }
    const cfg = loadConfig();
    const agentIdRaw = typeof params?.agentId === "string" ? params.agentId.trim() : "";
    const agentId = agentIdRaw ? normalizeAgentId(agentIdRaw) : resolveDefaultAgentId(cfg);
    if (agentIdRaw) {
      const knownAgents = listAgentIds(cfg);
      if (!knownAgents.includes(agentId)) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `unknown agent id "${agentIdRaw}"`),
        );
        return;
      }
    }
    const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
    const report = buildWorkspaceSkillStatus(workspaceDir, {
      config: cfg,
      eligibility: { remote: getRemoteSkillEligibility() },
    });
    respond(true, report, undefined);
  },
  "skills.bins": ({ params, respond }) => {
    if (!validateSkillsBinsParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid skills.bins params: ${formatValidationErrors(validateSkillsBinsParams.errors)}`,
        ),
      );
      return;
    }
    const cfg = loadConfig();
    const workspaceDirs = listAgentWorkspaceDirs(cfg);
    const bins = new Set<string>();
    for (const workspaceDir of workspaceDirs) {
      const entries = loadWorkspaceSkillEntries(workspaceDir, { config: cfg });
      for (const bin of collectSkillBins(entries)) {
        bins.add(bin);
      }
    }
    respond(true, { bins: [...bins].toSorted() }, undefined);
  },
  "skills.install": async ({ params, respond }) => {
    if (!validateSkillsInstallParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid skills.install params: ${formatValidationErrors(validateSkillsInstallParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as {
      name: string;
      installId: string;
      timeoutMs?: number;
    };
    const cfg = loadConfig();
    const workspaceDirRaw = resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg));
    const result = await installSkill({
      workspaceDir: workspaceDirRaw,
      skillName: p.name,
      installId: p.installId,
      timeoutMs: p.timeoutMs,
      config: cfg,
    });
    respond(
      result.ok,
      result,
      result.ok ? undefined : errorShape(ErrorCodes.UNAVAILABLE, result.message),
    );
  },
  "skills.update": async ({ params, respond }) => {
    if (!validateSkillsUpdateParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid skills.update params: ${formatValidationErrors(validateSkillsUpdateParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as {
      skillKey: string;
      enabled?: boolean;
      apiKey?: string;
      env?: Record<string, string>;
    };
    const cfg = loadConfig();
    const skills = cfg.skills ? { ...cfg.skills } : {};
    const entries = skills.entries ? { ...skills.entries } : {};
    const current = entries[p.skillKey] ? { ...entries[p.skillKey] } : {};
    if (typeof p.enabled === "boolean") {
      current.enabled = p.enabled;
    }
    if (typeof p.apiKey === "string") {
      const trimmed = normalizeSecretInput(p.apiKey);
      if (trimmed) {
        current.apiKey = trimmed;
      } else {
        delete current.apiKey;
      }
    }
    if (p.env && typeof p.env === "object") {
      const nextEnv = current.env ? { ...current.env } : {};
      for (const [key, value] of Object.entries(p.env)) {
        const trimmedKey = key.trim();
        if (!trimmedKey) {
          continue;
        }
        const trimmedVal = value.trim();
        if (!trimmedVal) {
          delete nextEnv[trimmedKey];
        } else {
          nextEnv[trimmedKey] = trimmedVal;
        }
      }
      current.env = nextEnv;
    }
    entries[p.skillKey] = current;
    skills.entries = entries;
    const nextConfig: OpenClawConfig = {
      ...cfg,
      skills,
    };
    await writeConfigFile(nextConfig);
    respond(true, { ok: true, skillKey: p.skillKey, config: current }, undefined);
  },
  "skills.download": async ({ params, respond }) => {
    if (!validateSkillsDownloadParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid skills.download params: ${formatValidationErrors(validateSkillsDownloadParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as {
      slug: string;
      version?: string;
      registryUrl?: string;
      force?: boolean;
    };
    const SAFE_SLUG = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
    if (!SAFE_SLUG.test(p.slug) || p.slug.includes("..")) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `invalid slug: "${p.slug}"`),
      );
      return;
    }
    const skillsDir = path.join(CONFIG_DIR, "skills");
    const targetDir = path.join(skillsDir, p.slug);
    const resolvedTarget = path.resolve(targetDir);
    if (!resolvedTarget.startsWith(path.resolve(skillsDir) + path.sep)) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "path traversal detected"));
      return;
    }
    if (fs.existsSync(targetDir) && !p.force) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `skill "${p.slug}" already installed at ${targetDir}. Use force: true to overwrite.`,
        ),
      );
      return;
    }
    const argv = ["npx", "clawhub", "install", p.slug, "--no-input"];
    if (p.version) {
      argv.push("--version", p.version);
    }
    if (p.force) {
      argv.push("--force");
    }
    if (p.registryUrl) {
      argv.push("--registry", p.registryUrl);
    }
    try {
      const result = await runCommandWithTimeout(argv, {
        timeoutMs: 60_000,
        cwd: CONFIG_DIR,
      });
      if (result.code !== 0) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.UNAVAILABLE,
            `clawhub install failed (exit ${result.code}): ${result.stderr.trim() || result.stdout.trim()}`,
          ),
        );
        return;
      }
      // Enable the skill in config by default.
      const cfg = loadConfig();
      const skills = cfg.skills ? { ...cfg.skills } : {};
      const entries = skills.entries ? { ...skills.entries } : {};
      if (!entries[p.slug]) {
        entries[p.slug] = { enabled: true };
        skills.entries = entries;
        await writeConfigFile({ ...cfg, skills });
      }
      respond(
        true,
        {
          ok: true,
          slug: p.slug,
          version: p.version ?? undefined,
          path: targetDir,
          stdout: result.stdout.trim(),
        },
        undefined,
      );
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          `skills.download failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }
  },
  "skills.remove": async ({ params, respond }) => {
    if (!validateSkillsRemoveParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid skills.remove params: ${formatValidationErrors(validateSkillsRemoveParams.errors)}`,
        ),
      );
      return;
    }
    const p = params as { skillKey: string; force?: boolean };
    const SAFE_KEY = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
    if (!SAFE_KEY.test(p.skillKey) || p.skillKey.includes("..")) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `invalid skillKey: "${p.skillKey}"`),
      );
      return;
    }
    const skillsDir = path.join(CONFIG_DIR, "skills");
    const targetDir = path.join(skillsDir, p.skillKey);
    const resolved = path.resolve(targetDir);
    if (!resolved.startsWith(path.resolve(skillsDir) + path.sep)) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "path traversal detected"));
      return;
    }
    if (!fs.existsSync(targetDir)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `skill "${p.skillKey}" not found`),
      );
      return;
    }
    // When force is not set, require the skill to be disabled in config first.
    if (!p.force) {
      const cfg = loadConfig();
      const entry = cfg.skills?.entries?.[p.skillKey];
      if (entry?.enabled === true) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `skill "${p.skillKey}" is still enabled. Disable it first or use force: true.`,
          ),
        );
        return;
      }
    }
    try {
      fs.rmSync(targetDir, { recursive: true, force: !!p.force });
      // Clean up config entry.
      const cfg = loadConfig();
      const skills = cfg.skills ? { ...cfg.skills } : {};
      const entries = skills.entries ? { ...skills.entries } : {};
      if (entries[p.skillKey]) {
        delete entries[p.skillKey];
        skills.entries = entries;
        await writeConfigFile({ ...cfg, skills });
      }
      respond(true, { ok: true, skillKey: p.skillKey }, undefined);
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          `skills.remove failed: ${err instanceof Error ? err.message : String(err)}`,
        ),
      );
    }
  },
};
