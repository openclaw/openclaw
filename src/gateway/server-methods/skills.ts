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
import { normalizeAgentId } from "../../routing/session-key.js";
import { buildSkillSecurityVerdictExplainability } from "../../security/skill-verdict.js";
import { normalizeSecretInput } from "../../utils/normalize-secret-input.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateSkillsBinsParams,
  validateSkillsInstallParams,
  validateSkillsStatusParams,
  validateSkillsVerdictParams,
  validateSkillsUpdateParams,
} from "../protocol/index.js";
import type { GatewayRequestHandlers } from "./types.js";

const SKILL_VERDICT_CACHE_TTL_MS = 30_000;
const SKILL_VERDICT_CACHE_MAX_ENTRIES = 200;

type SkillVerdictCacheEntry = {
  expiresAtMs: number;
  verdict: Awaited<ReturnType<typeof buildSkillSecurityVerdictExplainability>>;
};

const skillVerdictCache = new Map<string, SkillVerdictCacheEntry>();

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

function resolveSkillKey(entry: SkillEntry): string {
  return entry.metadata?.skillKey ?? entry.skill.name;
}

function resolveAgentWorkspace(params: {
  config: OpenClawConfig;
  agentIdRaw?: string;
}): { ok: true; agentId: string; workspaceDir: string } | { ok: false; message: string } {
  const agentIdRaw = typeof params.agentIdRaw === "string" ? params.agentIdRaw.trim() : "";
  const agentId = agentIdRaw ? normalizeAgentId(agentIdRaw) : resolveDefaultAgentId(params.config);
  if (agentIdRaw) {
    const knownAgents = listAgentIds(params.config);
    if (!knownAgents.includes(agentId)) {
      return { ok: false, message: `unknown agent id "${agentIdRaw}"` };
    }
  }
  return {
    ok: true,
    agentId,
    workspaceDir: resolveAgentWorkspaceDir(params.config, agentId),
  };
}

function getCachedSkillVerdict(cacheKey: string) {
  const cached = skillVerdictCache.get(cacheKey);
  if (!cached) {
    return undefined;
  }
  if (cached.expiresAtMs <= Date.now()) {
    skillVerdictCache.delete(cacheKey);
    return undefined;
  }
  return cached.verdict;
}

function setCachedSkillVerdict(
  cacheKey: string,
  verdict: Awaited<ReturnType<typeof buildSkillSecurityVerdictExplainability>>,
) {
  if (skillVerdictCache.size >= SKILL_VERDICT_CACHE_MAX_ENTRIES) {
    const oldestKey = skillVerdictCache.keys().next().value;
    if (oldestKey) {
      skillVerdictCache.delete(oldestKey);
    }
  }
  skillVerdictCache.set(cacheKey, {
    expiresAtMs: Date.now() + SKILL_VERDICT_CACHE_TTL_MS,
    verdict,
  });
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
    const workspace = resolveAgentWorkspace({
      config: cfg,
      agentIdRaw: typeof params?.agentId === "string" ? params.agentId : undefined,
    });
    if (!workspace.ok) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, workspace.message));
      return;
    }
    const report = buildWorkspaceSkillStatus(workspace.workspaceDir, {
      config: cfg,
      eligibility: { remote: getRemoteSkillEligibility() },
    });
    respond(true, report, undefined);
  },
  "skills.verdict": async ({ params, respond }) => {
    if (!validateSkillsVerdictParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid skills.verdict params: ${formatValidationErrors(validateSkillsVerdictParams.errors)}`,
        ),
      );
      return;
    }

    const cfg = loadConfig();
    const workspace = resolveAgentWorkspace({
      config: cfg,
      agentIdRaw: typeof params?.agentId === "string" ? params.agentId : undefined,
    });
    if (!workspace.ok) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, workspace.message));
      return;
    }

    const entries = loadWorkspaceSkillEntries(workspace.workspaceDir, { config: cfg });
    const requestedSkillKey = typeof params?.skillKey === "string" ? params.skillKey.trim() : "";
    const entry = entries.find((item) => resolveSkillKey(item) === requestedSkillKey);
    if (!entry) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `unknown skill key "${requestedSkillKey}"`),
      );
      return;
    }

    const resolvedSkillKey = resolveSkillKey(entry);
    const cacheKey = `${workspace.workspaceDir}::${resolvedSkillKey}`;
    const cachedVerdict = getCachedSkillVerdict(cacheKey);
    if (cachedVerdict) {
      respond(true, cachedVerdict, undefined);
      return;
    }

    try {
      const verdict = await buildSkillSecurityVerdictExplainability({
        skillKey: resolvedSkillKey,
        skillName: entry.skill.name,
        skillDir: entry.skill.baseDir,
      });
      setCachedSkillVerdict(cacheKey, verdict);
      respond(true, verdict, undefined);
    } catch (err) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.UNAVAILABLE,
          `failed to scan skill "${entry.skill.name}": ${String(err)}`,
        ),
      );
    }
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
    skillVerdictCache.clear();
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
};
