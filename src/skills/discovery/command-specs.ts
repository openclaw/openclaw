import fs from "node:fs";
import path from "node:path";
import { readRegularFileSync } from "@openclaw/fs-safe/advanced";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { normalizeUniqueSingleOrTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import {
  parseFrontmatterBlock,
  stripFrontmatterBlock,
} from "../../../packages/markdown-core/src/frontmatter.js";
import { canonicalizePath } from "../../agents/utils/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createDedupeCache } from "../../infra/dedupe.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { walkDirectorySync } from "../../infra/fs-safe.js";
import { readRootJsonObjectSync } from "../../infra/json-files.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  CLAUDE_BUNDLE_MANIFEST_RELATIVE_PATH,
  mergeBundlePathLists,
} from "../../plugins/bundle-manifest.js";
import {
  hasExplicitPluginConfig,
  normalizePluginsConfig,
  resolveEffectivePluginActivationState,
} from "../../plugins/config-state.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { loadPluginManifestRegistryForPluginRegistry } from "../../plugins/plugin-registry-contributions.js";
import { isPathInsideWithRealpath } from "../../security/scan-paths.js";
import { parseFrontmatterBool } from "../../shared/frontmatter.js";
import { resolveSkillTelemetrySource } from "../loading/source.js";
import { filterSkillEntries } from "../loading/workspace-skill-filter.js";
import { loadVisibleSkills, prepareWorkspaceSkills } from "../loading/workspace-skill-loader.js";
import { resolveSkillFileHost } from "../skill-file-host.js";
import type {
  SkillEligibilityContext,
  SkillCommandSpec,
  SkillEntry,
  SkillSnapshot,
} from "../types.js";
import { resolveEffectiveAgentSkillFilter } from "./agent-filter.js";
import { sanitizeSkillCommandName, SKILL_COMMAND_MAX_LENGTH } from "./command-name.js";
import { recordSkillCommandFileHost } from "./skill-command-provenance.js";
import { isSkillPromptVisible, isSkillUserInvocable } from "./skill-index.js";

const skillsLogger = createSubsystemLogger("skills");
const skillCommandDebugOnce = createDedupeCache({ ttlMs: 0, maxSize: 1024 });
const BUNDLE_COMMAND_MAX_BYTES = 1 * 1024 * 1024;
const bundleCommandsLogger = createSubsystemLogger("plugins/bundle-commands");

function readClaudeBundleManifest(rootDir: string): Record<string, unknown> {
  const result = readRootJsonObjectSync({
    rootDir,
    relativePath: CLAUDE_BUNDLE_MANIFEST_RELATIVE_PATH,
    boundaryLabel: "plugin root",
    rejectHardlinks: true,
  });
  return result.ok ? result.value : {};
}

function resolveClaudeCommandRootDirs(rootDir: string): string[] {
  const raw = readClaudeBundleManifest(rootDir);
  const declared = normalizeUniqueSingleOrTrimmedStringList(raw.commands);
  const defaults = fs.existsSync(path.join(rootDir, "commands")) ? ["commands"] : [];
  return mergeBundlePathLists(defaults, declared);
}

function listMarkdownFilesRecursive(rootDir: string): string[] {
  return walkDirectorySync(rootDir, {
    symlinks: "skip",
    descend: ({ name }) => !name.startsWith("."),
    include: ({ kind, name }) =>
      kind === "file" &&
      !name.startsWith(".") &&
      Boolean(normalizeOptionalLowercaseString(name)?.endsWith(".md")),
  })
    .entries.map((entry) => entry.path)
    .toSorted((a, b) => a.localeCompare(b));
}

function toDefaultCommandName(rootDir: string, filePath: string): string {
  const relativePath = path.relative(rootDir, filePath);
  const withoutExt = relativePath.replace(/\.[^.]+$/u, "");
  return withoutExt.split(path.sep).join(":");
}

function toDefaultDescription(promptTemplate: string): string {
  // stripFrontmatterBlock already normalized line endings and trimmed the nonempty body.
  const lineEnd = promptTemplate.indexOf("\n");
  return (lineEnd < 0 ? promptTemplate : promptTemplate.slice(0, lineEnd)).trimEnd();
}

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
  if (!used.has(base)) {
    return base;
  }
  for (let index = 2; index < 1000; index += 1) {
    const suffix = `_${index}`;
    const candidate = `${base.slice(0, SKILL_COMMAND_MAX_LENGTH - suffix.length)}${suffix}`;
    if (!used.has(candidate)) {
      return candidate;
    }
  }
  return `${base.slice(0, SKILL_COMMAND_MAX_LENGTH - 2)}_x`;
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
  gatewayOnly?: boolean;
  executionWorkspaceDir?: string;
  executionWorkspaceFileHost?: "gateway";
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
    gatewayOnly: opts?.gatewayOnly,
    executionWorkspaceDir: opts?.executionWorkspaceDir,
    executionWorkspaceFileHost: opts?.executionWorkspaceFileHost,
  };
}

/** Builds user-invocable slash command specs for synchronous SDK consumers. */
export function buildWorkspaceSkillCommandSpecs(
  workspaceDir: string,
  opts?: WorkspaceSkillCommandOptions,
): SkillCommandSpec[] {
  const loadOptions = resolveCommandSkillLoadOptions(opts);
  const eligible = opts?.entries
    ? filterSkillEntries(opts.entries, loadOptions)
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
    resolveCommandSkillLoadOptions(opts),
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
  const userInvocable = eligible.filter(isSkillUserInvocable);
  const used = new Set<string>();
  for (const reserved of opts?.reservedNames ?? []) {
    used.add(normalizeLowercaseStringOrEmpty(reserved));
    used.add(sanitizeSkillCommandName(reserved));
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
    used.add(unique);
    return unique;
  };
  for (const entry of userInvocable) {
    const rawName = entry.skill.name;
    const unique = claimName(rawName);
    const description = entry.skill.description?.trim() || rawName;
    const dispatch = entry.disableCommandDispatch
      ? undefined
      : (() => {
          const readCommandField = (key: string) =>
            entry.frontmatter?.[key] ?? entry.frontmatter?.[key.replaceAll("-", "_")] ?? "";
          const kindRaw = normalizeLowercaseStringOrEmpty(readCommandField("command-dispatch"));
          if (kindRaw !== "tool") {
            return undefined;
          }

          const toolName = readCommandField("command-tool").trim();
          if (!toolName) {
            logSkillCommandOnce(
              `dispatch:missingTool:${rawName}`,
              `Skill command "/${unique}" requested tool dispatch but did not provide command-tool. Ignoring dispatch.`,
              { skillName: rawName, command: unique },
            );
            return undefined;
          }

          const argModeRaw = normalizeOptionalLowercaseString(readCommandField("command-arg-mode"));
          if (argModeRaw && argModeRaw !== "raw") {
            logSkillCommandOnce(
              `dispatch:badArgMode:${rawName}:${argModeRaw}`,
              `Skill command "/${unique}" requested tool dispatch but has unknown command-arg-mode. Falling back to raw.`,
              { skillName: rawName, command: unique, argMode: argModeRaw },
            );
          }

          return { kind: "tool", toolName, argMode: "raw" } as const;
        })();

    const spec: SkillCommandSpec = {
      name: unique,
      displayName: entry.skill.displayName ?? rawName,
      skillFile: canonicalizePath(entry.skill.filePath),
      skillName: rawName,
      description,
      modelVisible: isSkillPromptVisible(entry),
      skillSource: resolveSkillTelemetrySource(entry.skill),
      ...(dispatch ? { dispatch } : {}),
    };
    const fileHost = resolveSkillFileHost(entry.skill);
    if (fileHost) {
      recordSkillCommandFileHost(spec, fileHost);
    }
    specs.push(spec);
  }

  if (hasExplicitPluginConfig(opts?.config?.plugins)) {
    const registry = loadPluginManifestRegistryForPluginRegistry({
      workspaceDir,
      config: opts?.config,
      includeDisabled: true,
    });
    const normalizedPlugins = normalizePluginsConfig(opts?.config?.plugins);
    for (const record of registry.plugins) {
      if (
        record.format !== "bundle" ||
        record.bundleFormat !== "claude" ||
        !(record.bundleCapabilities ?? []).includes("commands")
      ) {
        continue;
      }
      const activationState = resolveEffectivePluginActivationState({
        id: record.id,
        origin: record.origin,
        channelIds: record.channels,
        config: normalizedPlugins,
        rootConfig: opts?.config,
      });
      if (!activationState.activated) {
        continue;
      }
      for (const relativeRoot of resolveClaudeCommandRootDirs(record.rootDir)) {
        const commandRoot = path.resolve(record.rootDir, relativeRoot);
        if (!fs.existsSync(commandRoot)) {
          continue;
        }
        if (!isPathInsideWithRealpath(record.rootDir, commandRoot, { requireRealpath: true })) {
          continue;
        }
        for (const filePath of listMarkdownFilesRecursive(commandRoot)) {
          let raw: string;
          try {
            raw = readRegularFileSync({
              filePath,
              maxBytes: BUNDLE_COMMAND_MAX_BYTES,
            }).buffer.toString("utf-8");
          } catch (error) {
            bundleCommandsLogger.warn(
              `skipping unreadable bundle command file ${filePath}: ${formatErrorMessage(error)}`,
            );
            continue;
          }
          const frontmatter = parseFrontmatterBlock(raw);
          if (!parseFrontmatterBool(frontmatter["user-invocable"], true)) {
            continue;
          }
          const promptTemplate = stripFrontmatterBlock(raw);
          if (!promptTemplate) {
            continue;
          }
          const rawName =
            normalizeOptionalString(frontmatter.name) ||
            toDefaultCommandName(commandRoot, filePath);
          if (!rawName) {
            continue;
          }
          const description =
            normalizeOptionalString(frontmatter.description) ||
            toDefaultDescription(promptTemplate);
          specs.push({
            name: claimName(rawName, true),
            skillName: rawName,
            description,
            modelVisible: false,
            promptTemplate,
            sourceFilePath: filePath,
          });
        }
      }
    }
  }
  return specs;
}
