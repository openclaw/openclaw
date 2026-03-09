import path from "node:path";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { CHANNEL_IDS, normalizeChatChannelId } from "../channels/registry.js";
import {
  normalizePluginsConfig,
  resolveEffectiveEnableState,
  resolveMemorySlotDecision,
} from "../plugins/config-state.js";
import { loadPluginManifestRegistry } from "../plugins/manifest-registry.js";
import { validateJsonSchemaValue } from "../plugins/schema-validator.js";
import {
  hasAvatarUriScheme,
  isAvatarDataUrl,
  isAvatarHttpUrl,
  isPathWithinRoot,
  isWindowsAbsolutePath,
} from "../shared/avatar-policy.js";
import { isCanonicalDottedDecimalIPv4, isLoopbackIpAddress } from "../shared/net/ip.js";
import { isRecord } from "../utils.js";
import { findDuplicateAgentDirs, formatDuplicateAgentDirError } from "./agent-dirs.js";
import { appendAllowedValuesHint, summarizeAllowedValues } from "./allowed-values.js";
import { applyAgentDefaults, applyModelDefaults, applySessionDefaults } from "./defaults.js";
import { findLegacyConfigIssues } from "./legacy.js";
import type { OpenClawConfig, ConfigValidationIssue } from "./types.js";
import { OpenClawSchema } from "./zod-schema.js";

const LEGACY_REMOVED_PLUGIN_IDS = new Set(["google-antigravity-auth"]);

type UnknownIssueRecord = Record<string, unknown>;
type AllowedValuesCollection = {
  values: unknown[];
  incomplete: boolean;
  hasValues: boolean;
};
type IssueScore = {
  rootTypeMismatch: number;
  discriminatorMismatch: number;
  unknown: number;
  otherHard: number;
  missingDiscriminator: number;
  total: number;
};

type UnknownKeyIssue = {
  path: string;
  pathSegments: Array<string | number>;
  keys: string[];
};

const MAX_UNKNOWN_KEY_STRIP_PASSES = 3;

function toIssueRecord(value: unknown): UnknownIssueRecord | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  return value as UnknownIssueRecord;
}

function toIssuePathSegments(issue: unknown): Array<string | number> {
  const record = toIssueRecord(issue);
  if (!Array.isArray(record?.path)) {
    return [];
  }
  return record.path.filter((segment): segment is string | number => {
    const segmentType = typeof segment;
    return segmentType === "string" || segmentType === "number";
  });
}

function toIssuePathLabel(issue: unknown): string {
  return toIssuePathSegments(issue).join(".");
}

function pathStartsWith(path: Array<string | number>, prefix: Array<string | number>): boolean {
  if (prefix.length > path.length) {
    return false;
  }
  for (let i = 0; i < prefix.length; i += 1) {
    if (path[i] !== prefix[i]) {
      return false;
    }
  }
  return true;
}

function combineIssuePathSegments(
  basePath: Array<string | number>,
  issuePath: Array<string | number>,
): Array<string | number> {
  if (basePath.length === 0) {
    return issuePath;
  }
  if (issuePath.length === 0) {
    return basePath;
  }
  if (pathStartsWith(issuePath, basePath)) {
    return issuePath;
  }
  return [...basePath, ...issuePath];
}

function toUnknownKeyIssue(
  issue: unknown,
  pathSegments: Array<string | number> = toIssuePathSegments(issue),
): UnknownKeyIssue | null {
  const record = toIssueRecord(issue);
  if (record?.code !== "unrecognized_keys") {
    return null;
  }
  if (!Array.isArray(record.keys)) {
    return null;
  }
  const keys = record.keys.filter((entry): entry is string => typeof entry === "string");
  if (keys.length === 0) {
    return null;
  }
  return {
    path: pathSegments.join("."),
    pathSegments,
    keys,
  };
}

function collectUnknownKeyIssues(
  issues: ReadonlyArray<unknown>,
  rootRaw: unknown,
): UnknownKeyIssue[] {
  const collected: UnknownKeyIssue[] = [];
  for (const issue of issues) {
    collectUnknownKeyIssuesFromIssue(issue, collected, [], rootRaw);
  }
  return collected;
}

function collectUnknownKeyIssuesFromIssue(
  issue: unknown,
  collected: UnknownKeyIssue[],
  basePathSegments: Array<string | number>,
  rootRaw: unknown,
): void {
  const effectivePathSegments = combineIssuePathSegments(
    basePathSegments,
    toIssuePathSegments(issue),
  );
  const unknownKeyIssue = toUnknownKeyIssue(issue, effectivePathSegments);
  if (unknownKeyIssue) {
    collected.push(unknownKeyIssue);
  }

  const record = toIssueRecord(issue);
  if (!record || record.code !== "invalid_union") {
    return;
  }

  const nested = record.errors;
  if (!Array.isArray(nested) || nested.length === 0) {
    return;
  }

  // Evaluate only the most plausible union branch. Collecting unknown keys
  // from every branch can strip fields that are valid in the intended branch
  // (for example bindings[].acp when route/acp union branches both fail).
  const scopeValue = resolveIssuePathValue(rootRaw, effectivePathSegments);
  const selectedBranch = selectBestUnionIssueBranch(nested, scopeValue);
  if (!selectedBranch) {
    return;
  }
  for (const nestedIssue of selectedBranch) {
    collectUnknownKeyIssuesFromIssue(nestedIssue, collected, effectivePathSegments, rootRaw);
  }
}

function addIssueScore(left: IssueScore, right: IssueScore): IssueScore {
  return {
    rootTypeMismatch: left.rootTypeMismatch + right.rootTypeMismatch,
    discriminatorMismatch: left.discriminatorMismatch + right.discriminatorMismatch,
    unknown: left.unknown + right.unknown,
    otherHard: left.otherHard + right.otherHard,
    missingDiscriminator: left.missingDiscriminator + right.missingDiscriminator,
    total: left.total + right.total,
  };
}

function compareIssueScore(a: IssueScore, b: IssueScore): number {
  if (a.rootTypeMismatch !== b.rootTypeMismatch) {
    return a.rootTypeMismatch - b.rootTypeMismatch;
  }
  if (a.discriminatorMismatch !== b.discriminatorMismatch) {
    return a.discriminatorMismatch - b.discriminatorMismatch;
  }
  if (a.unknown !== b.unknown) {
    return a.unknown - b.unknown;
  }
  if (a.otherHard !== b.otherHard) {
    return a.otherHard - b.otherHard;
  }
  if (a.missingDiscriminator !== b.missingDiscriminator) {
    return a.missingDiscriminator - b.missingDiscriminator;
  }
  return a.total - b.total;
}

function resolveIssuePathValue(root: unknown, pathSegments: Array<string | number>): unknown {
  let current: unknown = root;
  for (const segment of pathSegments) {
    if (typeof segment === "number") {
      if (!Array.isArray(current)) {
        return undefined;
      }
      current = current[segment];
      continue;
    }
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

function isLiteralTypeIssue(record: UnknownIssueRecord | null): boolean {
  if (!record || record.code !== "invalid_value") {
    return false;
  }
  if (!Array.isArray(record.path) || record.path.length === 0) {
    return false;
  }
  if (record.path.at(-1) !== "type") {
    return false;
  }
  const values = record.values;
  return (
    Array.isArray(values) && values.length > 0 && values.every((entry) => typeof entry === "string")
  );
}

function classifyLiteralTypeIssue(
  record: UnknownIssueRecord | null,
  scopeValue: unknown,
): "mismatch" | "missing" | "other" {
  if (!isLiteralTypeIssue(record) || !isRecord(scopeValue)) {
    return "other";
  }
  const rawType = scopeValue.type;
  if (typeof rawType === "string") {
    const values = record?.values;
    if (Array.isArray(values) && !values.includes(rawType)) {
      return "mismatch";
    }
    return "other";
  }
  if (rawType == null || typeof rawType !== "string") {
    return "missing";
  }
  return "other";
}

function scoreIssueForUnknownKeyStripping(issue: unknown, scopeValue: unknown): IssueScore {
  const record = toIssueRecord(issue);
  const code = typeof record?.code === "string" ? record.code : "";
  if (code === "unrecognized_keys") {
    return {
      rootTypeMismatch: 0,
      discriminatorMismatch: 0,
      unknown: 1,
      otherHard: 0,
      missingDiscriminator: 0,
      total: 1,
    };
  }
  if (code === "invalid_type" && Array.isArray(record?.path) && record.path.length === 0) {
    return {
      rootTypeMismatch: 1,
      discriminatorMismatch: 0,
      unknown: 0,
      otherHard: 0,
      missingDiscriminator: 0,
      total: 1,
    };
  }
  const typeIssueKind = classifyLiteralTypeIssue(record, scopeValue);
  if (typeIssueKind === "mismatch") {
    return {
      rootTypeMismatch: 0,
      discriminatorMismatch: 1,
      unknown: 0,
      otherHard: 0,
      missingDiscriminator: 0,
      total: 1,
    };
  }
  if (typeIssueKind === "missing") {
    return {
      rootTypeMismatch: 0,
      discriminatorMismatch: 0,
      unknown: 0,
      otherHard: 0,
      missingDiscriminator: 1,
      total: 1,
    };
  }
  if (code === "invalid_union") {
    const nested = record?.errors;
    if (!Array.isArray(nested) || nested.length === 0) {
      return {
        rootTypeMismatch: 0,
        discriminatorMismatch: 0,
        unknown: 0,
        otherHard: 1,
        missingDiscriminator: 0,
        total: 1,
      };
    }
    const nestedScopeValue = resolveIssuePathValue(scopeValue, toIssuePathSegments(issue));
    const selectedBranch = selectBestUnionIssueBranch(nested, nestedScopeValue);
    if (!selectedBranch) {
      return {
        rootTypeMismatch: 0,
        discriminatorMismatch: 0,
        unknown: 0,
        otherHard: 1,
        missingDiscriminator: 0,
        total: 1,
      };
    }
    return scoreIssueListForUnknownKeyStripping(selectedBranch, nestedScopeValue);
  }
  return {
    rootTypeMismatch: 0,
    discriminatorMismatch: 0,
    unknown: 0,
    otherHard: 1,
    missingDiscriminator: 0,
    total: 1,
  };
}

function scoreIssueListForUnknownKeyStripping(
  issues: ReadonlyArray<unknown>,
  scopeValue: unknown,
): IssueScore {
  let score: IssueScore = {
    rootTypeMismatch: 0,
    discriminatorMismatch: 0,
    unknown: 0,
    otherHard: 0,
    missingDiscriminator: 0,
    total: 0,
  };
  for (const issue of issues) {
    score = addIssueScore(score, scoreIssueForUnknownKeyStripping(issue, scopeValue));
  }
  return score;
}

function selectBestUnionIssueBranch(
  nested: unknown[],
  scopeValue: unknown,
): ReadonlyArray<unknown> | null {
  let bestBranch: ReadonlyArray<unknown> | null = null;
  let bestScore: IssueScore | null = null;
  for (const branch of nested) {
    if (!Array.isArray(branch) || branch.length === 0) {
      continue;
    }
    const branchScore = scoreIssueListForUnknownKeyStripping(branch, scopeValue);
    if (!bestScore || compareIssueScore(branchScore, bestScore) < 0) {
      bestScore = branchScore;
      bestBranch = branch;
    }
  }
  return bestBranch;
}

function resolveIssuePathObject(
  root: unknown,
  pathSegments: Array<string | number>,
): Record<string, unknown> | null {
  let current: unknown = root;
  for (const segment of pathSegments) {
    if (typeof segment === "number") {
      if (!Array.isArray(current)) {
        return null;
      }
      current = current[segment];
      continue;
    }
    if (!isRecord(current)) {
      return null;
    }
    current = current[segment];
  }
  return isRecord(current) ? current : null;
}

function formatUnknownKeysWarning(issue: UnknownKeyIssue): ConfigValidationIssue {
  const keyList = issue.keys.map((key) => `"${key}"`).join(", ");
  return {
    path: issue.path,
    message:
      issue.keys.length === 1
        ? `unknown config key ignored: ${keyList}`
        : `unknown config keys ignored: ${keyList}`,
  };
}

function stripUnknownKeysWithWarnings(raw: unknown): {
  sanitizedRaw: unknown;
  warnings: ConfigValidationIssue[];
} {
  let sanitizedRaw = raw;
  let cloned = false;
  const warnings: ConfigValidationIssue[] = [];
  const warningKeys = new Set<string>();

  for (let pass = 0; pass < MAX_UNKNOWN_KEY_STRIP_PASSES; pass += 1) {
    const parsed = OpenClawSchema.safeParse(sanitizedRaw);
    if (parsed.success) {
      if (!cloned) {
        return { sanitizedRaw: raw, warnings: [] };
      }
      return { sanitizedRaw, warnings };
    }

    const unknownKeyIssues = collectUnknownKeyIssues(parsed.error.issues, sanitizedRaw);
    if (unknownKeyIssues.length === 0) {
      if (!cloned) {
        return { sanitizedRaw: raw, warnings: [] };
      }
      return { sanitizedRaw, warnings };
    }

    if (!cloned) {
      sanitizedRaw = structuredClone(raw);
      cloned = true;
    }

    let removedInPass = false;
    for (const issue of unknownKeyIssues) {
      const target = resolveIssuePathObject(sanitizedRaw, issue.pathSegments);
      if (!target) {
        continue;
      }
      let removedFromIssue = false;
      for (const key of issue.keys) {
        if (!Object.prototype.hasOwnProperty.call(target, key)) {
          continue;
        }
        delete target[key];
        removedFromIssue = true;
      }
      if (!removedFromIssue) {
        continue;
      }
      removedInPass = true;
      const warning = formatUnknownKeysWarning(issue);
      const warningKey = `${warning.path}\u0000${warning.message}`;
      if (warningKeys.has(warningKey)) {
        continue;
      }
      warningKeys.add(warningKey);
      warnings.push(warning);
    }

    if (!removedInPass) {
      // If no reported key could be removed, fail closed with the current payload.
      break;
    }
  }

  return { sanitizedRaw, warnings };
}

function setOwnConfigProperty(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function mergeValidatedConfigWithUnknownRawKeys(validated: unknown, raw: unknown): unknown {
  if (Array.isArray(validated)) {
    if (!Array.isArray(raw)) {
      return validated;
    }
    return validated.map((entry, index) =>
      mergeValidatedConfigWithUnknownRawKeys(entry, raw[index]),
    );
  }

  if (isRecord(validated)) {
    if (!isRecord(raw)) {
      return validated;
    }
    const merged: Record<string, unknown> = {};
    for (const [key, rawValue] of Object.entries(raw)) {
      if (Object.prototype.hasOwnProperty.call(validated, key)) {
        continue;
      }
      setOwnConfigProperty(merged, key, rawValue);
    }
    for (const [key, validatedValue] of Object.entries(validated)) {
      setOwnConfigProperty(
        merged,
        key,
        mergeValidatedConfigWithUnknownRawKeys(validatedValue, raw[key]),
      );
    }
    return merged;
  }

  return validated;
}

function collectAllowedValuesFromIssue(issue: unknown): AllowedValuesCollection {
  const record = toIssueRecord(issue);
  if (!record) {
    return { values: [], incomplete: false, hasValues: false };
  }
  const code = typeof record.code === "string" ? record.code : "";

  if (code === "invalid_value") {
    const values = record.values;
    if (!Array.isArray(values)) {
      return { values: [], incomplete: true, hasValues: false };
    }
    return { values, incomplete: false, hasValues: values.length > 0 };
  }

  if (code === "invalid_type") {
    const expected = typeof record.expected === "string" ? record.expected : "";
    if (expected === "boolean") {
      return { values: [true, false], incomplete: false, hasValues: true };
    }
    return { values: [], incomplete: true, hasValues: false };
  }

  if (code !== "invalid_union") {
    return { values: [], incomplete: false, hasValues: false };
  }

  const nested = record.errors;
  if (!Array.isArray(nested) || nested.length === 0) {
    return { values: [], incomplete: true, hasValues: false };
  }

  const collected: unknown[] = [];
  for (const branch of nested) {
    if (!Array.isArray(branch) || branch.length === 0) {
      return { values: [], incomplete: true, hasValues: false };
    }
    const branchCollected = collectAllowedValuesFromIssueList(branch);
    if (branchCollected.incomplete || !branchCollected.hasValues) {
      return { values: [], incomplete: true, hasValues: false };
    }
    collected.push(...branchCollected.values);
  }

  return { values: collected, incomplete: false, hasValues: collected.length > 0 };
}

function collectAllowedValuesFromIssueList(
  issues: ReadonlyArray<unknown>,
): AllowedValuesCollection {
  const collected: unknown[] = [];
  let hasValues = false;
  for (const issue of issues) {
    const branch = collectAllowedValuesFromIssue(issue);
    if (branch.incomplete) {
      return { values: [], incomplete: true, hasValues: false };
    }
    if (!branch.hasValues) {
      continue;
    }
    hasValues = true;
    collected.push(...branch.values);
  }
  return { values: collected, incomplete: false, hasValues };
}

function collectAllowedValuesFromUnknownIssue(issue: unknown): unknown[] {
  const collection = collectAllowedValuesFromIssue(issue);
  if (collection.incomplete || !collection.hasValues) {
    return [];
  }
  return collection.values;
}

function mapZodIssueToConfigIssue(issue: unknown): ConfigValidationIssue {
  const record = toIssueRecord(issue);
  const path = toIssuePathLabel(issue);
  const message = typeof record?.message === "string" ? record.message : "Invalid input";
  const allowedValuesSummary = summarizeAllowedValues(collectAllowedValuesFromUnknownIssue(issue));

  if (!allowedValuesSummary) {
    return { path, message };
  }

  return {
    path,
    message: appendAllowedValuesHint(message, allowedValuesSummary),
    allowedValues: allowedValuesSummary.values,
    allowedValuesHiddenCount: allowedValuesSummary.hiddenCount,
  };
}

function isWorkspaceAvatarPath(value: string, workspaceDir: string): boolean {
  const workspaceRoot = path.resolve(workspaceDir);
  const resolved = path.resolve(workspaceRoot, value);
  return isPathWithinRoot(workspaceRoot, resolved);
}

function validateIdentityAvatar(config: OpenClawConfig): ConfigValidationIssue[] {
  const agents = config.agents?.list;
  if (!Array.isArray(agents) || agents.length === 0) {
    return [];
  }
  const issues: ConfigValidationIssue[] = [];
  for (const [index, entry] of agents.entries()) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const avatarRaw = entry.identity?.avatar;
    if (typeof avatarRaw !== "string") {
      continue;
    }
    const avatar = avatarRaw.trim();
    if (!avatar) {
      continue;
    }
    if (isAvatarDataUrl(avatar) || isAvatarHttpUrl(avatar)) {
      continue;
    }
    if (avatar.startsWith("~")) {
      issues.push({
        path: `agents.list.${index}.identity.avatar`,
        message: "identity.avatar must be a workspace-relative path, http(s) URL, or data URI.",
      });
      continue;
    }
    const hasScheme = hasAvatarUriScheme(avatar);
    if (hasScheme && !isWindowsAbsolutePath(avatar)) {
      issues.push({
        path: `agents.list.${index}.identity.avatar`,
        message: "identity.avatar must be a workspace-relative path, http(s) URL, or data URI.",
      });
      continue;
    }
    const workspaceDir = resolveAgentWorkspaceDir(
      config,
      entry.id ?? resolveDefaultAgentId(config),
    );
    if (!isWorkspaceAvatarPath(avatar, workspaceDir)) {
      issues.push({
        path: `agents.list.${index}.identity.avatar`,
        message: "identity.avatar must stay within the agent workspace.",
      });
    }
  }
  return issues;
}

function validateGatewayTailscaleBind(config: OpenClawConfig): ConfigValidationIssue[] {
  const tailscaleMode = config.gateway?.tailscale?.mode ?? "off";
  if (tailscaleMode !== "serve" && tailscaleMode !== "funnel") {
    return [];
  }
  const bindMode = config.gateway?.bind ?? "loopback";
  if (bindMode === "loopback") {
    return [];
  }
  const customBindHost = config.gateway?.customBindHost;
  if (
    bindMode === "custom" &&
    isCanonicalDottedDecimalIPv4(customBindHost) &&
    isLoopbackIpAddress(customBindHost)
  ) {
    return [];
  }
  return [
    {
      path: "gateway.bind",
      message:
        `gateway.bind must resolve to loopback when gateway.tailscale.mode=${tailscaleMode} ` +
        '(use gateway.bind="loopback" or gateway.bind="custom" with gateway.customBindHost="127.0.0.1")',
    },
  ];
}

function getLegacyValidationIssues(raw: unknown): ConfigValidationIssue[] {
  return findLegacyConfigIssues(raw).map((iss) => ({
    path: iss.path,
    message: iss.message,
  }));
}

/**
 * Validates config without applying runtime defaults.
 * Use this when you need the raw validated config (e.g., for writing back to file).
 */
export function validateConfigObjectRaw(
  raw: unknown,
): { ok: true; config: OpenClawConfig } | { ok: false; issues: ConfigValidationIssue[] } {
  const legacyIssues = getLegacyValidationIssues(raw);
  if (legacyIssues.length > 0) {
    return {
      ok: false,
      issues: legacyIssues,
    };
  }
  const validated = OpenClawSchema.safeParse(raw);
  if (!validated.success) {
    return {
      ok: false,
      issues: validated.error.issues.map((issue) => mapZodIssueToConfigIssue(issue)),
    };
  }
  const duplicates = findDuplicateAgentDirs(validated.data as OpenClawConfig);
  if (duplicates.length > 0) {
    return {
      ok: false,
      issues: [
        {
          path: "agents.list",
          message: formatDuplicateAgentDirError(duplicates),
        },
      ],
    };
  }
  const avatarIssues = validateIdentityAvatar(validated.data as OpenClawConfig);
  if (avatarIssues.length > 0) {
    return { ok: false, issues: avatarIssues };
  }
  const gatewayTailscaleBindIssues = validateGatewayTailscaleBind(validated.data as OpenClawConfig);
  if (gatewayTailscaleBindIssues.length > 0) {
    return { ok: false, issues: gatewayTailscaleBindIssues };
  }
  return {
    ok: true,
    config: validated.data as OpenClawConfig,
  };
}

export function validateConfigObject(
  raw: unknown,
): { ok: true; config: OpenClawConfig } | { ok: false; issues: ConfigValidationIssue[] } {
  const result = validateConfigObjectRaw(raw);
  if (!result.ok) {
    return result;
  }
  return {
    ok: true,
    config: applyModelDefaults(applyAgentDefaults(applySessionDefaults(result.config))),
  };
}

type ValidateConfigWithPluginsResult =
  | {
      ok: true;
      config: OpenClawConfig;
      warnings: ConfigValidationIssue[];
    }
  | {
      ok: false;
      issues: ConfigValidationIssue[];
      warnings: ConfigValidationIssue[];
    };

export function validateConfigObjectWithPlugins(raw: unknown): ValidateConfigWithPluginsResult {
  return validateConfigObjectWithPluginsInternal(raw, { preserveUnknownKeys: false });
}

export function validateConfigObjectWithPluginsInternal(
  raw: unknown,
  opts: { preserveUnknownKeys: boolean },
): ValidateConfigWithPluginsResult {
  return validateConfigObjectWithPluginsBase(raw, {
    applyDefaults: true,
    preserveUnknownKeys: opts.preserveUnknownKeys,
  });
}

export function validateConfigObjectRawWithPlugins(raw: unknown): ValidateConfigWithPluginsResult {
  return validateConfigObjectWithPluginsBase(raw, {
    applyDefaults: false,
    preserveUnknownKeys: true,
  });
}

function validateConfigObjectWithPluginsBase(
  raw: unknown,
  opts: { applyDefaults: boolean; preserveUnknownKeys: boolean },
): ValidateConfigWithPluginsResult {
  // Must run on the original payload. If we strip unknown keys first, legacy
  // keys that are outside OpenClawSchema can be deleted before fail-closed
  // migration checks run.
  const legacyIssues = getLegacyValidationIssues(raw);
  if (legacyIssues.length > 0) {
    return {
      ok: false,
      issues: legacyIssues,
      warnings: [],
    };
  }

  const { sanitizedRaw, warnings: unknownKeyWarnings } = stripUnknownKeysWithWarnings(raw);
  const base = opts.applyDefaults
    ? validateConfigObject(sanitizedRaw)
    : validateConfigObjectRaw(sanitizedRaw);
  if (!base.ok) {
    return { ok: false, issues: base.issues, warnings: unknownKeyWarnings };
  }

  const config = base.config;
  const configForReturn = opts.preserveUnknownKeys
    ? (mergeValidatedConfigWithUnknownRawKeys(config, raw) as OpenClawConfig)
    : config;
  const issues: ConfigValidationIssue[] = [];
  const warnings: ConfigValidationIssue[] = [...unknownKeyWarnings];
  const hasExplicitPluginsConfig =
    isRecord(sanitizedRaw) && Object.prototype.hasOwnProperty.call(sanitizedRaw, "plugins");

  const resolvePluginConfigIssuePath = (pluginId: string, errorPath: string): string => {
    const base = `plugins.entries.${pluginId}.config`;
    if (!errorPath || errorPath === "<root>") {
      return base;
    }
    return `${base}.${errorPath}`;
  };

  type RegistryInfo = {
    registry: ReturnType<typeof loadPluginManifestRegistry>;
    knownIds?: Set<string>;
    normalizedPlugins?: ReturnType<typeof normalizePluginsConfig>;
  };

  let registryInfo: RegistryInfo | null = null;

  const ensureRegistry = (): RegistryInfo => {
    if (registryInfo) {
      return registryInfo;
    }

    const workspaceDir = resolveAgentWorkspaceDir(config, resolveDefaultAgentId(config));
    const registry = loadPluginManifestRegistry({
      config,
      workspaceDir: workspaceDir ?? undefined,
    });

    for (const diag of registry.diagnostics) {
      let path = diag.pluginId ? `plugins.entries.${diag.pluginId}` : "plugins";
      if (!diag.pluginId && diag.message.includes("plugin path not found")) {
        path = "plugins.load.paths";
      }
      const pluginLabel = diag.pluginId ? `plugin ${diag.pluginId}` : "plugin";
      const message = `${pluginLabel}: ${diag.message}`;
      if (diag.level === "error") {
        issues.push({ path, message });
      } else {
        warnings.push({ path, message });
      }
    }

    registryInfo = { registry };
    return registryInfo;
  };

  const ensureKnownIds = (): Set<string> => {
    const info = ensureRegistry();
    if (!info.knownIds) {
      info.knownIds = new Set(info.registry.plugins.map((record) => record.id));
    }
    return info.knownIds;
  };

  const ensureNormalizedPlugins = (): ReturnType<typeof normalizePluginsConfig> => {
    const info = ensureRegistry();
    if (!info.normalizedPlugins) {
      info.normalizedPlugins = normalizePluginsConfig(config.plugins);
    }
    return info.normalizedPlugins;
  };

  const allowedChannels = new Set<string>(["defaults", "modelByChannel", ...CHANNEL_IDS]);

  if (config.channels && isRecord(config.channels)) {
    for (const key of Object.keys(config.channels)) {
      const trimmed = key.trim();
      if (!trimmed) {
        continue;
      }
      if (!allowedChannels.has(trimmed)) {
        const { registry } = ensureRegistry();
        for (const record of registry.plugins) {
          for (const channelId of record.channels) {
            allowedChannels.add(channelId);
          }
        }
      }
      if (!allowedChannels.has(trimmed)) {
        issues.push({
          path: `channels.${trimmed}`,
          message: `unknown channel id: ${trimmed}`,
        });
      }
    }
  }

  const heartbeatChannelIds = new Set<string>();
  for (const channelId of CHANNEL_IDS) {
    heartbeatChannelIds.add(channelId.toLowerCase());
  }

  const validateHeartbeatTarget = (target: string | undefined, path: string) => {
    if (typeof target !== "string") {
      return;
    }
    const trimmed = target.trim();
    if (!trimmed) {
      issues.push({ path, message: "heartbeat target must not be empty" });
      return;
    }
    const normalized = trimmed.toLowerCase();
    if (normalized === "last" || normalized === "none") {
      return;
    }
    if (normalizeChatChannelId(trimmed)) {
      return;
    }
    if (!heartbeatChannelIds.has(normalized)) {
      const { registry } = ensureRegistry();
      for (const record of registry.plugins) {
        for (const channelId of record.channels) {
          const pluginChannel = channelId.trim();
          if (pluginChannel) {
            heartbeatChannelIds.add(pluginChannel.toLowerCase());
          }
        }
      }
    }
    if (heartbeatChannelIds.has(normalized)) {
      return;
    }
    issues.push({ path, message: `unknown heartbeat target: ${target}` });
  };

  validateHeartbeatTarget(
    config.agents?.defaults?.heartbeat?.target,
    "agents.defaults.heartbeat.target",
  );
  if (Array.isArray(config.agents?.list)) {
    for (const [index, entry] of config.agents.list.entries()) {
      validateHeartbeatTarget(entry?.heartbeat?.target, `agents.list.${index}.heartbeat.target`);
    }
  }

  if (!hasExplicitPluginsConfig) {
    if (issues.length > 0) {
      return { ok: false, issues, warnings };
    }
    return { ok: true, config: configForReturn, warnings };
  }

  const { registry } = ensureRegistry();
  const knownIds = ensureKnownIds();
  const normalizedPlugins = ensureNormalizedPlugins();
  const pushMissingPluginIssue = (
    path: string,
    pluginId: string,
    opts?: { warnOnly?: boolean },
  ) => {
    if (LEGACY_REMOVED_PLUGIN_IDS.has(pluginId)) {
      warnings.push({
        path,
        message: `plugin removed: ${pluginId} (stale config entry ignored; remove it from plugins config)`,
      });
      return;
    }
    if (opts?.warnOnly) {
      warnings.push({
        path,
        message: `plugin not found: ${pluginId} (stale config entry ignored; remove it from plugins config)`,
      });
      return;
    }
    issues.push({
      path,
      message: `plugin not found: ${pluginId}`,
    });
  };

  const pluginsConfig = config.plugins;

  const entries = pluginsConfig?.entries;
  if (entries && isRecord(entries)) {
    for (const pluginId of Object.keys(entries)) {
      if (!knownIds.has(pluginId)) {
        // Keep gateway startup resilient when plugins are removed/renamed across upgrades.
        pushMissingPluginIssue(`plugins.entries.${pluginId}`, pluginId, { warnOnly: true });
      }
    }
  }

  const allow = pluginsConfig?.allow ?? [];
  for (const pluginId of allow) {
    if (typeof pluginId !== "string" || !pluginId.trim()) {
      continue;
    }
    if (!knownIds.has(pluginId)) {
      pushMissingPluginIssue("plugins.allow", pluginId);
    }
  }

  const deny = pluginsConfig?.deny ?? [];
  for (const pluginId of deny) {
    if (typeof pluginId !== "string" || !pluginId.trim()) {
      continue;
    }
    if (!knownIds.has(pluginId)) {
      pushMissingPluginIssue("plugins.deny", pluginId);
    }
  }

  const memorySlot = normalizedPlugins.slots.memory;
  if (typeof memorySlot === "string" && memorySlot.trim() && !knownIds.has(memorySlot)) {
    pushMissingPluginIssue("plugins.slots.memory", memorySlot);
  }

  let selectedMemoryPluginId: string | null = null;
  const seenPlugins = new Set<string>();
  for (const record of registry.plugins) {
    const pluginId = record.id;
    if (seenPlugins.has(pluginId)) {
      continue;
    }
    seenPlugins.add(pluginId);
    const entry = normalizedPlugins.entries[pluginId];
    const entryHasConfig = Boolean(entry?.config);

    const enableState = resolveEffectiveEnableState({
      id: pluginId,
      origin: record.origin,
      config: normalizedPlugins,
      rootConfig: config,
    });
    let enabled = enableState.enabled;
    let reason = enableState.reason;

    if (enabled) {
      const memoryDecision = resolveMemorySlotDecision({
        id: pluginId,
        kind: record.kind,
        slot: memorySlot,
        selectedId: selectedMemoryPluginId,
      });
      if (!memoryDecision.enabled) {
        enabled = false;
        reason = memoryDecision.reason;
      }
      if (memoryDecision.selected && record.kind === "memory") {
        selectedMemoryPluginId = pluginId;
      }
    }

    const shouldValidate = enabled || entryHasConfig;
    if (shouldValidate) {
      if (record.configSchema) {
        const res = validateJsonSchemaValue({
          schema: record.configSchema,
          cacheKey: record.schemaCacheKey ?? record.manifestPath ?? pluginId,
          value: entry?.config ?? {},
        });
        if (!res.ok) {
          for (const error of res.errors) {
            issues.push({
              path: resolvePluginConfigIssuePath(pluginId, error.path),
              message: `invalid config: ${error.message}`,
              allowedValues: error.allowedValues,
              allowedValuesHiddenCount: error.allowedValuesHiddenCount,
            });
          }
        }
      } else {
        issues.push({
          path: `plugins.entries.${pluginId}`,
          message: `plugin schema missing for ${pluginId}`,
        });
      }
    }

    if (!enabled && entryHasConfig) {
      warnings.push({
        path: `plugins.entries.${pluginId}`,
        message: `plugin disabled (${reason ?? "disabled"}) but config is present`,
      });
    }
  }

  if (issues.length > 0) {
    return { ok: false, issues, warnings };
  }

  return { ok: true, config: configForReturn, warnings };
}
