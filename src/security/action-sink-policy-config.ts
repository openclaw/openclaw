import type { PolicyMode, PolicyActionType } from "./action-sink-policy.js";

export type WorktreeAssignment = {
  issueId?: string;
  repoRoot?: string;
  worktreeRoot: string;
  branchPattern?: string;
};

export type ExternalAllowlistRule = {
  targetPattern: string;
  actionTypes?: PolicyActionType[];
};

export type ActionSinkPolicyConfig = {
  defaultMode: PolicyMode;
  moduleModes: Record<string, PolicyMode>;
  protectedRoots: string[];
  protectedRepoPatterns: string[];
  assignedWorktrees: WorktreeAssignment[];
  externalAllowlist: ExternalAllowlistRule[];
  deniedTargetPatterns: string[];
  riskTiers: Record<string, "internal" | "external" | "customer" | "operator">;
  recovery: {
    operatorIds: string[];
    emergencyLogPath?: string;
  };
};

const MODES = new Set(["shadow", "enforce", "disabled"]);

function asStringArray(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new Error(`${field} must be an array of strings`);
  }
  return [...value];
}

function parseMode(value: unknown, field: string, fallback: PolicyMode): PolicyMode {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !MODES.has(value)) {
    throw new Error(`${field} must be shadow, enforce, or disabled`);
  }
  return value as PolicyMode;
}

export function parseActionSinkPolicyConfig(input: unknown = {}): ActionSinkPolicyConfig {
  const record = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const moduleModes: Record<string, PolicyMode> = {};
  const rawModuleModes = record.moduleModes;
  if (rawModuleModes !== undefined) {
    if (!rawModuleModes || typeof rawModuleModes !== "object" || Array.isArray(rawModuleModes)) {
      throw new Error("moduleModes must be an object");
    }
    for (const [key, value] of Object.entries(rawModuleModes as Record<string, unknown>)) {
      moduleModes[key] = parseMode(value, `moduleModes.${key}`, "enforce");
    }
  }

  return {
    defaultMode: parseMode(record.defaultMode, "defaultMode", "shadow"),
    moduleModes,
    protectedRoots: asStringArray(record.protectedRoots, "protectedRoots"),
    protectedRepoPatterns: asStringArray(record.protectedRepoPatterns, "protectedRepoPatterns"),
    assignedWorktrees: Array.isArray(record.assignedWorktrees)
      ? record.assignedWorktrees.map((item, index) => {
          if (
            !item ||
            typeof item !== "object" ||
            typeof (item as { worktreeRoot?: unknown }).worktreeRoot !== "string"
          ) {
            throw new Error(`assignedWorktrees.${index}.worktreeRoot must be a string`);
          }
          return { ...(item as WorktreeAssignment) };
        })
      : [],
    externalAllowlist: Array.isArray(record.externalAllowlist)
      ? record.externalAllowlist.map((item, index) => {
          if (
            !item ||
            typeof item !== "object" ||
            typeof (item as { targetPattern?: unknown }).targetPattern !== "string"
          ) {
            throw new Error(`externalAllowlist.${index}.targetPattern must be a string`);
          }
          return { ...(item as ExternalAllowlistRule) };
        })
      : [],
    deniedTargetPatterns: asStringArray(record.deniedTargetPatterns, "deniedTargetPatterns"),
    riskTiers:
      record.riskTiers && typeof record.riskTiers === "object" && !Array.isArray(record.riskTiers)
        ? {
            ...(record.riskTiers as Record<
              string,
              "internal" | "external" | "customer" | "operator"
            >),
          }
        : {},
    recovery: {
      operatorIds: asStringArray(
        (record.recovery as { operatorIds?: unknown } | undefined)?.operatorIds,
        "recovery.operatorIds",
      ),
      emergencyLogPath:
        typeof (record.recovery as { emergencyLogPath?: unknown } | undefined)?.emergencyLogPath ===
        "string"
          ? (record.recovery as { emergencyLogPath: string }).emergencyLogPath
          : undefined,
    },
  };
}

export function createMissionControlActionSinkPolicyFixture(): ActionSinkPolicyConfig {
  return parseActionSinkPolicyConfig({
    defaultMode: "shadow",
    protectedRoots: ["/Users/admin/Projects/mission-control-production"],
    assignedWorktrees: [
      {
        repoRoot: "/Users/admin/Projects/mission-control-production",
        worktreeRoot: "/Users/admin/Projects/mc-workers/",
        branchPattern: "agent/*",
      },
    ],
    moduleModes: {
      protectedWorktree: "enforce",
      externalActionFirewall: "shadow",
      evidenceGate: "shadow",
    },
  });
}
