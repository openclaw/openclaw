import type { OpenClawConfig } from "../config/types.openclaw.js";

export type MigrationProviderId = "hermes" | (string & {});

export type MigrationStatus =
  | "planned"
  | "migrated"
  | "skipped"
  | "archived"
  | "manual"
  | "conflict"
  | "error";

export type MigrationConflictMode = "fail" | "skip" | "rename" | "overwrite";

export type MigrationCategory =
  | "identity"
  | "workspace"
  | "memory"
  | "models"
  | "secrets"
  | "skills"
  | "plugins"
  | "mcp"
  | "channels"
  | "automation"
  | "archive"
  | "manual";

export type MigrationDetection = {
  providerId: MigrationProviderId;
  label: string;
  sourceDir: string;
  confidence: "high" | "medium" | "low";
  reasons: string[];
};

export type MigrationSourceSnapshot = {
  providerId: MigrationProviderId;
  sourceDir: string;
  label: string;
  config?: Record<string, unknown>;
  env?: Record<string, string>;
  files: Record<string, string>;
  directories: Record<string, string>;
  warnings: string[];
};

export type MigrationActionBase = {
  id: string;
  category: MigrationCategory;
  reason: string;
};

export type MigrationAction =
  | (MigrationActionBase & {
      kind: "copyFile";
      source: string;
      target: string;
      conflict: MigrationConflictMode;
    })
  | (MigrationActionBase & {
      kind: "copyTree";
      source: string;
      target: string;
      conflict: MigrationConflictMode;
    })
  | (MigrationActionBase & {
      kind: "mergeConfig";
      path: string[];
      value: unknown;
    })
  | (MigrationActionBase & {
      kind: "writeEnv";
      key: string;
      value?: string;
      sourceLabel: string;
    })
  | (MigrationActionBase & {
      kind: "writeSecretRef";
      targetPath: string[];
      envKey: string;
    })
  | (MigrationActionBase & {
      kind: "enablePlugin";
      pluginId: string;
      config?: Record<string, unknown>;
    })
  | (MigrationActionBase & {
      kind: "archiveOnly";
      source: string;
      archivePath: string;
    })
  | (MigrationActionBase & {
      kind: "manual";
      source?: string;
      recommendation?: string;
    });

export type MigrationActionInput = MigrationAction extends infer Action
  ? Action extends MigrationAction
    ? Omit<Action, "id">
    : never
  : never;

export type MigrationPlan = {
  id: string;
  providerId: MigrationProviderId;
  label: string;
  sourceDir: string;
  targetStateDir: string;
  targetWorkspaceDir: string;
  createdAt: string;
  migrateSecrets: boolean;
  actions: MigrationAction[];
  warnings: string[];
};

export type MigrationPlanOptions = {
  providerId: MigrationProviderId;
  sourceDir?: string;
  targetStateDir?: string;
  targetWorkspaceDir?: string;
  migrateSecrets?: boolean;
  env?: NodeJS.ProcessEnv;
};

export type MigrationApplyOptions = {
  plan: MigrationPlan;
  dryRun?: boolean;
  yes?: boolean;
  allowExisting?: boolean;
  env?: NodeJS.ProcessEnv;
  baseConfig?: OpenClawConfig;
};

export type MigrationItemResult = {
  actionId: string;
  kind: MigrationAction["kind"];
  category: MigrationCategory;
  status: MigrationStatus;
  reason: string;
  source?: string;
  target?: string;
  details?: string;
};

export type MigrationApplyResult = {
  planId: string;
  dryRun: boolean;
  reportDir: string;
  results: MigrationItemResult[];
  nextConfig?: OpenClawConfig;
};

export type MigrationProvider = {
  id: MigrationProviderId;
  label: string;
  candidateSourceDirs: (env?: NodeJS.ProcessEnv) => string[];
  detect: (env?: NodeJS.ProcessEnv) => Promise<MigrationDetection[]>;
  inspect: (sourceDir: string) => Promise<MigrationSourceSnapshot>;
  plan: (options: MigrationPlanOptions) => Promise<MigrationPlan>;
};
