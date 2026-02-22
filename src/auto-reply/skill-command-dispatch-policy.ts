import type { OpenClawConfig } from "../config/config.js";

export const DEFAULT_SKILL_COMMAND_DISPATCH_MAX_ARG_LENGTH = 4000;

export const DEFAULT_SKILL_COMMAND_DISPATCH_DENY_PATTERNS = [
  "exec",
  "system.run",
  "nodes.run",
  "gateway/*",
] as const;

type SkillCommandDispatchConfig = NonNullable<OpenClawConfig["skills"]>["commandDispatch"];

function normalizeToken(input: string): string {
  return input.trim().toLowerCase();
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function matchesSkillCommandDispatchToolPattern(toolName: string, pattern: string): boolean {
  const normalizedTool = normalizeToken(toolName);
  const normalizedPattern = normalizeToken(pattern);
  if (!normalizedTool || !normalizedPattern) {
    return false;
  }

  if (normalizedPattern.endsWith("/*")) {
    const prefix = normalizedPattern.slice(0, -2);
    return (
      normalizedTool === prefix ||
      normalizedTool.startsWith(`${prefix}/`) ||
      normalizedTool.startsWith(`${prefix}.`)
    );
  }

  if (normalizedPattern.includes("*")) {
    const regex = new RegExp(`^${escapeRegExp(normalizedPattern).replaceAll("\\*", ".*")}$`, "i");
    return regex.test(normalizedTool);
  }

  return normalizedTool === normalizedPattern;
}

function normalizePatternList(input: string[] | undefined): string[] | undefined {
  if (!Array.isArray(input)) {
    return undefined;
  }
  return input.map((entry) => normalizeToken(entry)).filter(Boolean);
}

function resolveDispatchConfig(
  cfg: OpenClawConfig,
): Required<Pick<NonNullable<SkillCommandDispatchConfig>, "maxArgLength">> &
  Pick<NonNullable<SkillCommandDispatchConfig>, "allowTools" | "requireStructuredArgsTools"> {
  const commandDispatch = cfg.skills?.commandDispatch;
  const maxArgLength =
    typeof commandDispatch?.maxArgLength === "number" && commandDispatch.maxArgLength > 0
      ? commandDispatch.maxArgLength
      : DEFAULT_SKILL_COMMAND_DISPATCH_MAX_ARG_LENGTH;
  return {
    maxArgLength,
    allowTools: normalizePatternList(commandDispatch?.allowTools),
    requireStructuredArgsTools: normalizePatternList(commandDispatch?.requireStructuredArgsTools),
  };
}

export type SkillCommandDispatchPreparationResult =
  | { ok: true; toolName: string; toolParams: Record<string, unknown> }
  | { ok: false; message: string };

function isToolAllowed(toolName: string, cfg: ReturnType<typeof resolveDispatchConfig>): boolean {
  if (cfg.allowTools) {
    return cfg.allowTools.some((pattern) =>
      matchesSkillCommandDispatchToolPattern(toolName, pattern),
    );
  }
  return !DEFAULT_SKILL_COMMAND_DISPATCH_DENY_PATTERNS.some((pattern) =>
    matchesSkillCommandDispatchToolPattern(toolName, pattern),
  );
}

function requiresStructuredArgs(
  toolName: string,
  cfg: ReturnType<typeof resolveDispatchConfig>,
): boolean {
  return (
    cfg.requireStructuredArgsTools?.some((pattern) =>
      matchesSkillCommandDispatchToolPattern(toolName, pattern),
    ) === true
  );
}

export function prepareSkillCommandToolDispatch(params: {
  cfg: OpenClawConfig;
  toolName: string;
  rawArgs: string;
  commandName: string;
  skillName: string;
}): SkillCommandDispatchPreparationResult {
  const dispatchCfg = resolveDispatchConfig(params.cfg);
  const toolName = params.toolName.trim();
  if (!toolName) {
    return { ok: false, message: "Skill command dispatch is missing command-tool." };
  }
  if (!isToolAllowed(toolName, dispatchCfg)) {
    return {
      ok: false,
      message: `Tool dispatch blocked by skills.commandDispatch policy: ${toolName}`,
    };
  }
  if (params.rawArgs.length > dispatchCfg.maxArgLength) {
    return {
      ok: false,
      message:
        `Skill command args exceed skills.commandDispatch.maxArgLength ` +
        `(${dispatchCfg.maxArgLength} chars).`,
    };
  }

  if (!requiresStructuredArgs(toolName, dispatchCfg)) {
    return {
      ok: true,
      toolName,
      toolParams: {
        command: params.rawArgs,
        commandName: params.commandName,
        skillName: params.skillName,
      },
    };
  }

  const trimmed = params.rawArgs.trim();
  if (!trimmed) {
    return {
      ok: false,
      message:
        `Tool dispatch for ${toolName} requires a JSON object argument ` +
        `(skills.commandDispatch.requireStructuredArgsTools).`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return {
      ok: false,
      message:
        `Tool dispatch for ${toolName} requires JSON object arguments ` +
        `(skills.commandDispatch.requireStructuredArgsTools).`,
    };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      ok: false,
      message:
        `Tool dispatch for ${toolName} requires a JSON object argument ` +
        `(skills.commandDispatch.requireStructuredArgsTools).`,
    };
  }
  return {
    ok: true,
    toolName,
    toolParams: {
      ...(parsed as Record<string, unknown>),
      commandName: params.commandName,
      skillName: params.skillName,
    },
  };
}
