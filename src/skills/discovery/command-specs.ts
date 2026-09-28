import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "@openclaw/normalization-core/string-coerce";
import { canonicalizePath } from "../../agents/utils/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createDedupeCache } from "../../infra/dedupe.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { loadEnabledClaudeBundleCommands } from "../../plugins/bundle-commands.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { resolveSkillTelemetrySource } from "../loading/source.js";
import {
  filterWorkspaceSkills,
  loadVisibleSkills,
  prepareWorkspaceSkills,
} from "../loading/workspace-skill-loader.js";
import type {
  SkillEligibilityContext,
  SkillCommandSpec,
  SkillEntry,
  SkillSnapshot,
} from "../types.js";
import { resolveEffectiveAgentSkillFilter } from "./agent-filter.js";
import { sanitizeSkillCommandName, SKILL_COMMAND_MAX_LENGTH } from "./command-name.js";
import { filterUserInvocableSkillEntries, isSkillPromptVisible } from "./skill-index.js";

const skillsLogger = createSubsystemLogger("skills");
const skillCommandDebugOnce = createDedupeCache({ ttlMs: 0, maxSize: 1024 });

// De-duplicate noisy skill command diagnostics across large workspace scans.
function logSkillCommandOnce(
  messageKey: string,
  message: string,
  meta?: Record<string, unknown>,
  level: "debug" | "trace" = "debug",
) {
  if (skillCommandDebugOnce.check(messageKey)) {
    return;
  }
  skillsLogger[level](message, meta);
}

function resolveUniqueSkillCommandName(base: string, used: Set<string>): string {
  const normalizedBase = normalizeLowercaseStringOrEmpty(base);
  if (!used.has(normalizedBase)) {
    return base;
  }
  for (let index = 2; index < 1000; index += 1) {
    const suffix = `_${index}`;
    const maxBaseLength = Math.max(1, SKILL_COMMAND_MAX_LENGTH - suffix.length);
    const trimmedBase = base.slice(0, maxBaseLength);
    const candidate = `${trimmedBase}${suffix}`;
    const candidateKey = normalizeLowercaseStringOrEmpty(candidate);
    if (!used.has(candidateKey)) {
      return candidate;
    }
  }
  return `${base.slice(0, Math.max(1, SKILL_COMMAND_MAX_LENGTH - 2))}_x`;
}

type WorkspaceSkillCommandOptions = {
  bundledSkillName?: string;
  config?: OpenClawConfig;
  managedSkillsDir?: string;
  bundledSkillsDir?: string;
  entries?: SkillEntry[];
  librarySelections?: SkillSnapshot["librarySelections"];
  agentId?: string;
  skillFilter?: string[];
  includeAllowlistHidden?: boolean;
  eligibility?: SkillEligibilityContext;
  pluginMetadataSnapshot?: PluginMetadataSnapshot;
  reservedNames?: Set<string>;
};

function resolveCommandSkillLoadOptions(opts?: WorkspaceSkillCommandOptions) {
  return {
    bundledSkillName: opts?.bundledSkillName,
    config: opts?.config,
    managedSkillsDir: opts?.managedSkillsDir,
    bundledSkillsDir: opts?.bundledSkillsDir,
    librarySelections: opts?.librarySelections,
    agentId: opts?.agentId,
    agentSkillFilter: opts?.includeAllowlistHidden ? ("ignore" as const) : ("apply" as const),
    skillFilter: opts?.includeAllowlistHidden
      ? undefined
      : (opts?.skillFilter ?? resolveEffectiveAgentSkillFilter(opts?.config, opts?.agentId)),
    eligibility: opts?.eligibility,
    pluginMetadataSnapshot: opts?.pluginMetadataSnapshot,
  };
}

/** Builds user-invocable slash command specs for synchronous SDK consumers. */
export function buildWorkspaceSkillCommandSpecs(
  workspaceDir: string,
  opts?: WorkspaceSkillCommandOptions & { gatewayOnly?: boolean },
): SkillCommandSpec[] {
  const loadOptions = { ...resolveCommandSkillLoadOptions(opts), gatewayOnly: opts?.gatewayOnly };
  const eligible = opts?.entries
    ? filterWorkspaceSkills(opts.entries, {
        config: opts?.config,
        skillFilter: loadOptions.skillFilter,
        eligibility: opts?.eligibility,
      })
    : loadVisibleSkills(workspaceDir, loadOptions);
  return assembleWorkspaceSkillCommandSpecs(workspaceDir, eligible, opts);
}

/** Prepares eligibility once before sharing the synchronous command assembly. */
export async function prepareWorkspaceSkillCommandSpecs(
  workspaceDir: string,
  opts: Omit<WorkspaceSkillCommandOptions, "entries" | "eligibility"> & {
    eligibility: SkillEligibilityContext;
  },
  assertCurrent?: () => void,
): Promise<SkillCommandSpec[]> {
  const eligible = await prepareWorkspaceSkills(
    workspaceDir,
    {
      ...resolveCommandSkillLoadOptions(opts),
      eligibility: opts.eligibility,
    },
    assertCurrent,
  );
  assertCurrent?.();
  return assembleWorkspaceSkillCommandSpecs(workspaceDir, eligible, opts);
}

function assembleWorkspaceSkillCommandSpecs(
  workspaceDir: string,
  eligible: SkillEntry[],
  opts?: WorkspaceSkillCommandOptions,
): SkillCommandSpec[] {
  const userInvocable = filterUserInvocableSkillEntries(eligible);
  const used = new Set<string>();
  for (const reserved of opts?.reservedNames ?? []) {
    used.add(normalizeLowercaseStringOrEmpty(reserved));
  }

  const specs: SkillCommandSpec[] = [];
  const claimName = (rawName: string, bundle = false) => {
    const prefix = bundle ? "bundle-" : "";
    const label = bundle ? "bundle" : "skill";
    const level = bundle ? "debug" : "trace";
    const base = sanitizeSkillCommandName(rawName);
    if (base !== rawName) {
      logSkillCommandOnce(
        `${prefix}sanitize:${rawName}:${base}`,
        `Sanitized ${label} command name "${rawName}" to "/${base}".`,
        { rawName, sanitized: `/${base}` },
        level,
      );
    }
    const unique = resolveUniqueSkillCommandName(base, used);
    if (unique !== base) {
      logSkillCommandOnce(
        `${prefix}dedupe:${rawName}:${unique}`,
        `De-duplicated ${label} command name for "${rawName}" to "/${unique}".`,
        { rawName, deduped: `/${unique}` },
        level,
      );
    }
    used.add(normalizeLowercaseStringOrEmpty(unique));
    return unique;
  };
  for (const entry of userInvocable) {
    const rawName = entry.skill.name;
    const unique = claimName(rawName);
    const description = entry.skill.description?.trim() || rawName;
    const dispatch = entry.disableCommandDispatch
      ? undefined
      : (() => {
          const kindRaw = normalizeLowercaseStringOrEmpty(
            entry.frontmatter?.["command-dispatch"] ??
              entry.frontmatter?.["command_dispatch"] ??
              "",
          );
          if (kindRaw !== "tool") {
            return undefined;
          }

          const toolName = (
            entry.frontmatter?.["command-tool"] ??
            entry.frontmatter?.["command_tool"] ??
            ""
          ).trim();
          if (!toolName) {
            logSkillCommandOnce(
              `dispatch:missingTool:${rawName}`,
              `Skill command "/${unique}" requested tool dispatch but did not provide command-tool. Ignoring dispatch.`,
              { skillName: rawName, command: unique },
            );
            return undefined;
          }

          const argModeRaw = normalizeOptionalLowercaseString(
            entry.frontmatter?.["command-arg-mode"] ??
              entry.frontmatter?.["command_arg_mode"] ??
              "",
          );
          if (argModeRaw && argModeRaw !== "raw") {
            logSkillCommandOnce(
              `dispatch:badArgMode:${rawName}:${argModeRaw}`,
              `Skill command "/${unique}" requested tool dispatch but has unknown command-arg-mode. Falling back to raw.`,
              { skillName: rawName, command: unique, argMode: argModeRaw },
            );
          }

          return { kind: "tool", toolName, argMode: "raw" } as const;
        })();

    specs.push({
      name: unique,
      displayName: entry.skill.displayName ?? rawName,
      skillFile: canonicalizePath(entry.skill.filePath),
      skillName: rawName,
      description,
      modelVisible: isSkillPromptVisible(entry),
      skillSource: resolveSkillTelemetrySource(entry.skill),
      ...(dispatch ? { dispatch } : {}),
    });
  }

  const bundleCommands = loadEnabledClaudeBundleCommands({
    workspaceDir,
    cfg: opts?.config,
  });
  for (const entry of bundleCommands) {
    specs.push({
      name: claimName(entry.rawName, true),
      skillName: entry.rawName,
      description: entry.description,
      modelVisible: false,
      promptTemplate: entry.promptTemplate,
      sourceFilePath: entry.sourceFilePath,
    });
  }
  return specs;
}
