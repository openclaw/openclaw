// Skill command spec helpers expose skill-provided commands to model/tool surfaces.
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "@openclaw/normalization-core/string-coerce";
import { canonicalizePath } from "../../agents/utils/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createDedupeCache } from "../../infra/dedupe.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { loadEnabledClaudeBundleCommands } from "../../plugins/bundle-commands.js";
import { resolveSelectedPluginCommandRegistry } from "../../plugins/plugin-command-registry.js";
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
function debugSkillCommandOnce(
  messageKey: string,
  message: string,
  meta?: Record<string, unknown>,
) {
  if (skillCommandDebugOnce.check(messageKey)) {
    return;
  }
  skillsLogger.debug(message, meta);
}

function traceSkillCommandOnce(
  messageKey: string,
  message: string,
  meta?: Record<string, unknown>,
) {
  if (skillCommandDebugOnce.check(messageKey)) {
    return;
  }
  skillsLogger.trace(message, meta);
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
): Promise<SkillCommandSpec[]> {
  const eligible = await prepareWorkspaceSkills(workspaceDir, {
    ...resolveCommandSkillLoadOptions(opts),
    eligibility: opts.eligibility,
  });
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
  for (const entry of userInvocable) {
    const rawName = entry.skill.name;
    const base = sanitizeSkillCommandName(rawName);
    if (base !== rawName) {
      traceSkillCommandOnce(
        `sanitize:${rawName}:${base}`,
        `Sanitized skill command name "${rawName}" to "/${base}".`,
        { rawName, sanitized: `/${base}` },
      );
    }
    const unique = resolveUniqueSkillCommandName(base, used);
    if (unique !== base) {
      traceSkillCommandOnce(
        `dedupe:${rawName}:${unique}`,
        `De-duplicated skill command name for "${rawName}" to "/${unique}".`,
        { rawName, deduped: `/${unique}` },
      );
    }
    used.add(normalizeLowercaseStringOrEmpty(unique));
    const description = entry.skill.description?.trim() || rawName;
    const dispatch = entry.disableCommandDispatch
      ? undefined
      : (() => {
          const kindRaw = normalizeLowercaseStringOrEmpty(
            entry.frontmatter?.["command-dispatch"] ??
              entry.frontmatter?.["command_dispatch"] ??
              "",
          );
          if (!kindRaw || kindRaw !== "tool") {
            return undefined;
          }

          const toolName = (
            entry.frontmatter?.["command-tool"] ??
            entry.frontmatter?.["command_tool"] ??
            ""
          ).trim();
          if (!toolName) {
            debugSkillCommandOnce(
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
          const argMode = !argModeRaw || argModeRaw === "raw" ? "raw" : null;
          if (!argMode) {
            debugSkillCommandOnce(
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
    const base = sanitizeSkillCommandName(entry.rawName);
    if (base !== entry.rawName) {
      debugSkillCommandOnce(
        `bundle-sanitize:${entry.rawName}:${base}`,
        `Sanitized bundle command name "${entry.rawName}" to "/${base}".`,
        { rawName: entry.rawName, sanitized: `/${base}` },
      );
    }
    const unique = resolveUniqueSkillCommandName(base, used);
    if (unique !== base) {
      debugSkillCommandOnce(
        `bundle-dedupe:${entry.rawName}:${unique}`,
        `De-duplicated bundle command name for "${entry.rawName}" to "/${unique}".`,
        { rawName: entry.rawName, deduped: `/${unique}` },
      );
    }
    used.add(normalizeLowercaseStringOrEmpty(unique));
    specs.push({
      name: unique,
      skillName: entry.rawName,
      description: entry.description,
      modelVisible: false,
      promptTemplate: entry.promptTemplate,
      sourceFilePath: entry.sourceFilePath,
    });
  }
  // Project friendly invocations only after reserving every existing command.
  // The pinned manifest, not a mutable library slug/title, owns the short name.
  const shortNames = new Map<SkillEntry, string>();
  const counts = new Map<string, number>();
  for (const entry of userInvocable) {
    if (entry.skill.source !== "openclaw-library" || !entry.frontmatter.name?.trim()) {
      continue;
    }
    const short = sanitizeSkillCommandName(entry.frontmatter.name);
    shortNames.set(entry, short);
    counts.set(short, (counts.get(short) ?? 0) + 1);
  }
  // /skill and inline references also accept original, unsanitized skill names.
  for (const spec of specs) {
    used.add(sanitizeSkillCommandName(spec.skillName));
  }
  // Inspect the selected registry without loading plugins or changing registration.
  for (const { command } of resolveSelectedPluginCommandRegistry()?.commands ?? []) {
    for (const name of [command.name, ...Object.values(command.nativeNames ?? {})]) {
      if (typeof name === "string") {
        used.add(sanitizeSkillCommandName(name));
      }
    }
  }
  for (const [index, spec] of specs.entries()) {
    // Bundle commands follow the skill entries and cannot inherit their aliases.
    const entry = userInvocable[index];
    const short = entry && shortNames.get(entry);
    if (!short || counts.get(short) !== 1 || used.has(short)) {
      continue;
    }
    // Never choose a winner by discovery order when two owners want one alias.
    // Keep the stable command available in text without adding native menu slots.
    spec.aliases = [spec.name];
    spec.name = short;
  }
  return specs;
}
