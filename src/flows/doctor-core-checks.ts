import path from "node:path";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import type { SkillStatusEntry } from "../agents/skills-status.js";
import {
  detectLegacyClawdBrowserProfileResidue,
  maybeArchiveLegacyClawdBrowserProfileResidue,
  type LegacyClawdBrowserProfileResidue,
} from "../commands/doctor-browser.js";
import { hasConfiguredCommandOwners } from "../commands/doctor-command-owner.js";
import type { DoctorPrompter } from "../commands/doctor-prompter.js";
import type { SandboxImageIssue } from "../commands/doctor-sandbox.js";
import { disableUnavailableSkillsInConfig } from "../commands/doctor-skills-core.js";
import type { ConfigValidationIssue, OpenClawConfig } from "../config/types.openclaw.js";
import { resolveSecretInputRef } from "../config/types.secrets.js";
import { hasAmbiguousGatewayAuthModeConfig } from "../gateway/auth-mode-policy.js";
import { resolveGatewayAuth } from "../gateway/auth.js";
import { registerHealthCheck } from "./health-check-registry.js";
import type { HealthCheck, HealthFinding, HealthRepairContext } from "./health-checks.js";

const BROWSER_CLAWD_PROFILE_RESIDUE_CHECK_ID = "core/doctor/browser-clawd-profile-residue";
const FINAL_CONFIG_VALIDATION_CHECK_ID = "core/doctor/final-config-validation";

export type CoreHealthCheckDeps = {
  readonly detectUnavailableSkills: (cfg: OpenClawConfig) => Promise<readonly SkillStatusEntry[]>;
  readonly collectSecurityWarnings: (cfg: OpenClawConfig) => Promise<readonly string[]>;
  readonly collectWorkspaceSuggestionNotes: (workspaceDir: string) => Promise<readonly string[]>;
};

async function detectUnavailableSkillsWithRuntime(
  cfg: OpenClawConfig,
): Promise<readonly SkillStatusEntry[]> {
  const runtime = await import("./doctor-core-checks.runtime.js");
  return runtime.detectUnavailableSkills(cfg);
}

async function collectSecurityWarningsWithRuntime(cfg: OpenClawConfig): Promise<readonly string[]> {
  const { collectSecurityWarnings } = await import("../commands/doctor-security.js");
  return collectSecurityWarnings(cfg);
}

async function collectWorkspaceSuggestionNotesWithRuntime(
  workspaceDir: string,
): Promise<readonly string[]> {
  const { collectWorkspaceBackupTip } = await import("../commands/doctor-state-integrity.js");
  const { MEMORY_SYSTEM_PROMPT, shouldSuggestMemorySystem } =
    await import("../commands/doctor-workspace.js");
  const notes: string[] = [];
  const backupTip = collectWorkspaceBackupTip(workspaceDir);
  if (backupTip) {
    notes.push(backupTip);
  }
  if (await shouldSuggestMemorySystem(workspaceDir)) {
    notes.push(MEMORY_SYSTEM_PROMPT);
  }
  return notes;
}

const defaultCoreHealthCheckDeps: CoreHealthCheckDeps = {
  detectUnavailableSkills: detectUnavailableSkillsWithRuntime,
  collectSecurityWarnings: collectSecurityWarningsWithRuntime,
  collectWorkspaceSuggestionNotes: collectWorkspaceSuggestionNotesWithRuntime,
};

export function configValidationIssuesToHealthFindings(
  issues: readonly ConfigValidationIssue[],
): readonly HealthFinding[] {
  return issues.map(
    (issue): HealthFinding => ({
      checkId: FINAL_CONFIG_VALIDATION_CHECK_ID,
      severity: "error",
      message: issue.message,
      path: issue.path || "<root>",
    }),
  );
}

const gatewayConfigCheck: HealthCheck = {
  id: "core/doctor/gateway-config",
  kind: "core",
  description: "openclaw.jsonc gateway block is set and unambiguous.",
  source: "doctor",
  async detect(ctx) {
    const findings: HealthFinding[] = [];
    if (!ctx.cfg.gateway?.mode) {
      findings.push({
        checkId: "core/doctor/gateway-config",
        severity: "warning",
        message: "gateway.mode is unset; gateway start will be blocked.",
        path: "gateway.mode",
        fixHint:
          "Run `openclaw configure` and set Gateway mode (local/remote), or `openclaw config set gateway.mode local`.",
      });
    }
    if (ctx.cfg.gateway?.mode !== "remote" && hasAmbiguousGatewayAuthModeConfig(ctx.cfg)) {
      findings.push({
        checkId: "core/doctor/gateway-config",
        severity: "warning",
        message:
          "gateway.auth.token and gateway.auth.password are both configured while gateway.auth.mode is unset; auth selection is ambiguous.",
        path: "gateway.auth.mode",
        fixHint:
          "Set an explicit mode: `openclaw config set gateway.auth.mode token` or `... password`.",
      });
    }
    return findings;
  },
};

const commandOwnerCheck: HealthCheck = {
  id: "core/doctor/command-owner",
  kind: "core",
  description: "An owner account is configured for owner-only commands.",
  source: "doctor",
  async detect(ctx) {
    if (hasConfiguredCommandOwners(ctx.cfg)) {
      return [];
    }
    return [
      {
        checkId: "core/doctor/command-owner",
        severity: "info",
        message:
          "No command owner is configured. Owner-only commands (/diagnostics, /export-trajectory, /config, exec approvals) have no allowed sender.",
        path: "commands.ownerAllowFrom",
        fixHint:
          "Set commands.ownerAllowFrom to your channel user id, e.g. `openclaw config set commands.ownerAllowFrom '[\"telegram:123456789\"]'`.",
      },
    ];
  },
};

function resolveDoctorMode(cfg: OpenClawConfig): "local" | "remote" {
  return cfg.gateway?.mode === "remote" ? "remote" : "local";
}

const gatewayAuthCheck: HealthCheck = {
  id: "core/doctor/gateway-auth",
  kind: "core",
  description: "Local Gateway auth mode has a usable token or another explicit auth mode.",
  source: "doctor",
  async detect(ctx) {
    if (resolveDoctorMode(ctx.cfg) !== "local") {
      return [];
    }
    const gatewayTokenRef = resolveSecretInputRef({
      value: ctx.cfg.gateway?.auth?.token,
      defaults: ctx.cfg.secrets?.defaults,
    }).ref;
    const auth = resolveGatewayAuth({
      authConfig: ctx.cfg.gateway?.auth,
      tailscaleMode: ctx.cfg.gateway?.tailscale?.mode ?? "off",
    });
    const needsToken =
      auth.mode !== "password" &&
      auth.mode !== "none" &&
      auth.mode !== "trusted-proxy" &&
      (auth.mode !== "token" || !auth.token);
    if (!needsToken) {
      return [];
    }
    if (gatewayTokenRef) {
      return [
        {
          checkId: "core/doctor/gateway-auth",
          severity: "warning",
          message: "Gateway token is managed via SecretRef and is currently unavailable.",
          path: "gateway.auth.token",
          fixHint: "Resolve or rotate the external secret source, then rerun doctor.",
        },
      ];
    }
    return [
      {
        checkId: "core/doctor/gateway-auth",
        severity: "warning",
        message: "Gateway auth is off or missing a token.",
        path: "gateway.auth",
        fixHint: "Run `openclaw doctor --fix --generate-gateway-token` to generate a token.",
      },
    ];
  },
};

const hooksModelCheck: HealthCheck = {
  id: "core/doctor/hooks-model",
  kind: "core",
  description: "hooks.gmail.model resolves to an allowed catalog model.",
  source: "doctor",
  async detect(ctx) {
    if (!ctx.cfg.hooks?.gmail?.model?.trim()) {
      return [];
    }
    const { DEFAULT_MODEL, DEFAULT_PROVIDER } = await import("../agents/defaults.js");
    const { loadModelCatalog } = await import("../agents/model-catalog.js");
    const { getModelRefStatus, resolveConfiguredModelRef, resolveHooksGmailModel } =
      await import("../agents/model-selection.js");
    const hooksModelRef = resolveHooksGmailModel({
      cfg: ctx.cfg,
      defaultProvider: DEFAULT_PROVIDER,
    });
    if (!hooksModelRef) {
      return [
        {
          checkId: "core/doctor/hooks-model",
          severity: "warning",
          message: `hooks.gmail.model "${ctx.cfg.hooks.gmail.model}" could not be resolved.`,
          path: "hooks.gmail.model",
        },
      ];
    }
    const { provider: defaultProvider, model: defaultModel } = resolveConfiguredModelRef({
      cfg: ctx.cfg,
      defaultProvider: DEFAULT_PROVIDER,
      defaultModel: DEFAULT_MODEL,
    });
    const catalog = await loadModelCatalog({ config: ctx.cfg });
    const status = getModelRefStatus({
      cfg: ctx.cfg,
      catalog,
      ref: hooksModelRef,
      defaultProvider,
      defaultModel,
    });
    const findings: HealthFinding[] = [];
    if (!status.allowed) {
      findings.push({
        checkId: "core/doctor/hooks-model",
        severity: "warning",
        message: `hooks.gmail.model "${status.key}" is not in agents.defaults.models allowlist.`,
        path: "hooks.gmail.model",
        fixHint: "Add the model to agents.defaults.models or remove hooks.gmail.model.",
      });
    }
    if (!status.inCatalog) {
      findings.push({
        checkId: "core/doctor/hooks-model",
        severity: "warning",
        message: `hooks.gmail.model "${status.key}" is not in the model catalog.`,
        path: "hooks.gmail.model",
        fixHint: "Choose a model from the configured provider catalog.",
      });
    }
    return findings;
  },
};

const legacyStateCheck: HealthCheck = {
  id: "core/doctor/legacy-state",
  kind: "core",
  description: "Legacy sessions, agent state, and channel auth paths have been migrated.",
  source: "doctor",
  async detect(ctx) {
    const { detectLegacyStateMigrations } = await import("../commands/doctor-state-migrations.js");
    const detected = await detectLegacyStateMigrations({ cfg: ctx.cfg });
    return detected.preview.map(
      (line): HealthFinding => ({
        checkId: "core/doctor/legacy-state",
        severity: "warning",
        message: line.replace(/^- /, ""),
        path: detected.stateDir,
        fixHint: "Run `openclaw doctor --fix` to migrate legacy state.",
      }),
    );
  },
};

const legacyPluginManifestsCheck: HealthCheck = {
  id: "core/doctor/legacy-plugin-manifests",
  kind: "core",
  description: "Legacy top-level plugin manifest capability keys are moved under contracts.",
  source: "doctor",
  async detect(ctx, scope) {
    const { collectLegacyPluginManifestContractMigrations } =
      await import("../commands/doctor-plugin-manifests.js");
    const migrations = collectLegacyPluginManifestContractMigrations({
      config: ctx.cfg,
      ...(ctx.env ? { env: ctx.env } : {}),
      ...(ctx.cfg.plugins?.load?.paths ? { manifestRoots: ctx.cfg.plugins.load.paths } : {}),
      ...(ctx.cwd ? { workspaceDir: ctx.cwd } : {}),
    });
    const scopedPaths = new Set(scope?.paths ?? []);
    return migrations
      .filter((migration) => scopedPaths.size === 0 || scopedPaths.has(migration.manifestPath))
      .map(
        (migration): HealthFinding => ({
          checkId: "core/doctor/legacy-plugin-manifests",
          severity: "warning",
          message: `Plugin manifest ${migration.pluginId} uses legacy top-level capability keys.`,
          path: migration.manifestPath,
          fixHint: "Run `openclaw doctor --fix` to move legacy manifest keys under contracts.",
        }),
      );
  },
  async repair(ctx, findings) {
    const { collectLegacyPluginManifestContractMigrations, repairLegacyPluginManifestContracts } =
      await import("../commands/doctor-plugin-manifests.js");
    const findingPaths = new Set(
      findings.map((finding) => finding.path).filter((path): path is string => Boolean(path)),
    );
    const migrations = collectLegacyPluginManifestContractMigrations({
      config: ctx.cfg,
      ...(ctx.env ? { env: ctx.env } : {}),
      ...(ctx.cfg.plugins?.load?.paths ? { manifestRoots: ctx.cfg.plugins.load.paths } : {}),
      ...(ctx.cwd ? { workspaceDir: ctx.cwd } : {}),
    }).filter((migration) => findingPaths.size === 0 || findingPaths.has(migration.manifestPath));
    const repaired = await repairLegacyPluginManifestContracts({
      config: ctx.cfg,
      runtime: ctx.runtime,
      migrations,
      ...(ctx.env ? { env: ctx.env } : {}),
      ...(ctx.cwd ? { workspaceDir: ctx.cwd } : {}),
      ...(ctx.dryRun !== undefined ? { dryRun: ctx.dryRun } : {}),
      ...(ctx.diff !== undefined ? { diff: ctx.diff } : {}),
    });
    return repaired;
  },
};

function configuredPluginInstallEffects(params: {
  pluginIds: readonly string[];
  channelIds: readonly string[];
  dryRun: boolean;
}) {
  const actionPrefix = params.dryRun ? "would-" : "";
  return [
    ...params.pluginIds.map((pluginId) => ({
      kind: "package" as const,
      action: `${actionPrefix}install-configured-plugin`,
      target: pluginId,
      dryRunSafe: false,
    })),
    ...params.channelIds.map((channelId) => ({
      kind: "package" as const,
      action: `${actionPrefix}install-configured-channel-plugin`,
      target: channelId,
      dryRunSafe: false,
    })),
  ];
}

function configuredPluginInstallDryRunChanges(params: {
  pluginIds: readonly string[];
  channelIds: readonly string[];
  shouldTouchConfig: boolean;
}): string[] {
  const changes: string[] = [];
  if (params.pluginIds.length > 0) {
    changes.push(`Would repair configured plugin install(s): ${params.pluginIds.join(", ")}.`);
  }
  if (params.channelIds.length > 0) {
    changes.push(
      `Would repair configured channel plugin install(s): ${params.channelIds.join(", ")}.`,
    );
  }
  if (params.shouldTouchConfig) {
    changes.push("Would mark configured plugin install release repair complete.");
  }
  return changes;
}

const configuredPluginInstallsCheck: HealthCheck = {
  id: "core/doctor/configured-plugin-installs",
  kind: "core",
  description: "Configured official plugins and channels have install records after migration.",
  source: "doctor",
  async detect(ctx, scope) {
    if (ctx.mode === "fix" && scope?.findings === undefined) {
      return [
        {
          checkId: "core/doctor/configured-plugin-installs",
          severity: "info",
          message: "Configured plugin install repair should run at this doctor position.",
          path: "plugins",
        },
      ];
    }
    const { collectReleaseConfiguredPluginIds, shouldRunConfiguredPluginInstallReleaseStep } =
      await import("../commands/doctor/shared/release-configured-plugin-installs.js");
    const configured = collectReleaseConfiguredPluginIds({
      cfg: ctx.cfg,
      env: ctx.env ?? process.env,
    });
    const touchedVersion =
      scope?.findings === undefined
        ? (ctx.doctor?.sourceLastTouchedVersion ?? ctx.cfg.meta?.lastTouchedVersion ?? null)
        : (ctx.cfg.meta?.lastTouchedVersion ?? null);
    const shouldRunReleaseStep = shouldRunConfiguredPluginInstallReleaseStep({
      touchedVersion,
    });
    if (!shouldRunReleaseStep) {
      return [];
    }
    const paths = [
      configured.pluginIds.length > 0 ? `plugins:${configured.pluginIds.join(",")}` : undefined,
      configured.channelIds.length > 0 ? `channels:${configured.channelIds.join(",")}` : undefined,
      shouldRunReleaseStep ? "meta.lastTouchedVersion" : undefined,
    ].filter((entry): entry is string => entry !== undefined);
    return [
      {
        checkId: "core/doctor/configured-plugin-installs",
        severity: "warning",
        message: "Configured plugin install repair should run for this config.",
        path: paths.join(" "),
        fixHint: "Run `openclaw doctor --fix` to install missing configured plugins.",
      },
    ];
  },
  async repair(ctx) {
    const {
      collectReleaseConfiguredPluginIds,
      maybeRunConfiguredPluginInstallReleaseStep,
      shouldRunConfiguredPluginInstallReleaseStep,
    } = await import("../commands/doctor/shared/release-configured-plugin-installs.js");
    const { isLegacyParentWritableUpdateDoctorPass, shouldDeferConfiguredPluginInstallRepair } =
      await import("../commands/doctor/shared/update-phase.js");
    const { VERSION } = await import("../version.js");
    const env = ctx.env ?? process.env;
    const touchedVersion =
      ctx.doctor?.sourceLastTouchedVersion ?? ctx.cfg.meta?.lastTouchedVersion ?? null;
    const configured = collectReleaseConfiguredPluginIds({ cfg: ctx.cfg, env });
    const shouldRunReleaseStep = shouldRunConfiguredPluginInstallReleaseStep({ touchedVersion });
    const effects = configuredPluginInstallEffects({
      pluginIds: configured.pluginIds,
      channelIds: configured.channelIds,
      dryRun: ctx.dryRun === true,
    });
    const shouldTouchConfig =
      shouldRunReleaseStep && !shouldDeferConfiguredPluginInstallRepair(env);
    if (ctx.dryRun === true) {
      return {
        changes: configuredPluginInstallDryRunChanges({
          pluginIds: configured.pluginIds,
          channelIds: configured.channelIds,
          shouldTouchConfig,
        }),
        effects: [
          ...effects,
          ...(shouldTouchConfig
            ? [
                {
                  kind: "config" as const,
                  action: "would-stamp-configured-plugin-install-release",
                  target: "meta.lastTouchedVersion",
                  dryRunSafe: true,
                },
              ]
            : []),
        ],
        diffs:
          shouldTouchConfig && ctx.diff === true
            ? [
                {
                  kind: "config" as const,
                  path: "meta",
                  before: JSON.stringify(ctx.cfg.meta ?? null, null, 2),
                  after: JSON.stringify(
                    {
                      ...ctx.cfg.meta,
                      lastTouchedVersion: VERSION,
                      lastTouchedAt: "<doctor-run timestamp>",
                    },
                    null,
                    2,
                  ),
                },
              ]
            : [],
      };
    }
    const result = await maybeRunConfiguredPluginInstallReleaseStep({
      cfg: ctx.cfg,
      env,
      touchedVersion,
    });
    if (!result.touchedConfig) {
      return {
        changes: result.changes,
        warnings: result.warnings,
        effects: result.changes.length > 0 ? effects : [],
      };
    }
    const lastTouchedVersion = isLegacyParentWritableUpdateDoctorPass(env)
      ? ctx.doctor?.sourceLastTouchedVersion?.trim() || ctx.cfg.meta?.lastTouchedVersion || VERSION
      : VERSION;
    const nextConfig = {
      ...ctx.cfg,
      meta: {
        ...ctx.cfg.meta,
        lastTouchedVersion,
        lastTouchedAt: new Date().toISOString(),
      },
    };
    return {
      config: nextConfig,
      changes: result.changes,
      warnings: result.warnings,
      effects: [
        ...effects,
        {
          kind: "config" as const,
          action: "stamp-configured-plugin-install-release",
          target: "meta.lastTouchedVersion",
          dryRunSafe: true,
        },
      ],
      diffs:
        ctx.diff === true
          ? [
              {
                kind: "config" as const,
                path: "meta",
                before: JSON.stringify(ctx.cfg.meta ?? null, null, 2),
                after: JSON.stringify(nextConfig.meta, null, 2),
              },
            ]
          : [],
    };
  },
};

function pluginRegistryIssueFindingMessage(kind: string): string {
  switch (kind) {
    case "migration":
      return "Persisted plugin registry is missing or stale.";
    case "disabled":
      return "Plugin registry repair is disabled by environment.";
    case "stale-managed-npm-bundled-plugin":
      return "Managed npm plugin package shadows a bundled plugin.";
    case "stale-local-bundled-plugin-install-record":
      return "Local bundled plugin install record shadows a bundled plugin.";
    case "managed-npm-peer-link":
      return "Managed npm plugin package has a broken OpenClaw host peer link.";
    default:
      return "Plugin registry repair should run.";
  }
}

function pluginRegistryIssuePath(issue: {
  kind: string;
  filePath?: string;
  packageDir?: string;
  packageName?: string;
  stalePath?: string;
}): string {
  return (
    issue.filePath ?? issue.packageDir ?? issue.packageName ?? issue.stalePath ?? "plugin-registry"
  );
}

function pluginRegistryRepairEffects(
  issues: readonly {
    kind: string;
    filePath?: string;
    packageDir?: string;
    packageName?: string;
    pluginId?: string;
    stalePath?: string;
  }[],
  dryRun: boolean,
) {
  const actionPrefix = dryRun ? "would-" : "";
  return issues
    .filter((issue) => issue.kind !== "disabled")
    .map((issue) => {
      if (issue.kind === "stale-managed-npm-bundled-plugin") {
        return {
          kind: "package" as const,
          action: `${actionPrefix}remove-stale-managed-npm-plugin`,
          target: issue.packageName ?? issue.pluginId ?? "managed npm plugin",
          dryRunSafe: false,
        };
      }
      if (issue.kind === "stale-local-bundled-plugin-install-record") {
        return {
          kind: "state" as const,
          action: `${actionPrefix}remove-stale-local-plugin-install-record`,
          target: issue.pluginId ?? issue.stalePath ?? "local install record",
          dryRunSafe: false,
        };
      }
      if (issue.kind === "managed-npm-peer-link") {
        return {
          kind: "package" as const,
          action: `${actionPrefix}repair-openclaw-peer-link`,
          target: issue.packageName ?? "managed npm plugin",
          dryRunSafe: false,
        };
      }
      return {
        kind: "state" as const,
        action: `${actionPrefix}refresh-plugin-registry`,
        target: issue.filePath ?? "installed plugin registry",
        dryRunSafe: true,
      };
    });
}

function pluginRegistryDryRunChanges(
  issues: readonly {
    kind: string;
    filePath?: string;
    packageName?: string;
    pluginId?: string;
    stalePath?: string;
  }[],
): string[] {
  return issues.map((issue) => {
    if (issue.kind === "stale-managed-npm-bundled-plugin") {
      return `Would remove stale managed npm plugin package ${issue.packageName ?? issue.pluginId}.`;
    }
    if (issue.kind === "managed-npm-peer-link") {
      return `Would repair OpenClaw host peer link for managed npm plugin ${issue.packageName}.`;
    }
    if (issue.kind === "stale-local-bundled-plugin-install-record") {
      return `Would remove stale local bundled plugin install record for ${issue.pluginId}.`;
    }
    if (issue.kind === "disabled") {
      return "Would skip plugin registry repair because it is disabled by environment.";
    }
    return `Would rebuild plugin registry${issue.filePath ? ` at ${issue.filePath}` : ""}.`;
  });
}

function filterPluginRegistryIssuesForFindings<
  T extends {
    kind: string;
    filePath?: string;
    packageDir?: string;
    packageName?: string;
  },
>(issues: readonly T[], findings: readonly HealthFinding[]): T[] {
  const findingPaths = new Set(
    findings.map((finding) => finding.path).filter((path): path is string => Boolean(path)),
  );
  if (findingPaths.size === 0 || findingPaths.has("plugin-registry")) {
    return [...issues];
  }
  return issues.filter((issue) => findingPaths.has(pluginRegistryIssuePath(issue)));
}

const pluginRegistryCheck: HealthCheck = {
  id: "core/doctor/plugin-registry",
  kind: "core",
  description:
    "Persisted plugin registry state is current and managed plugin packages are healthy.",
  source: "doctor",
  async detect(ctx, scope) {
    if (ctx.mode === "fix" && scope?.findings === undefined) {
      return [
        {
          checkId: "core/doctor/plugin-registry",
          severity: "info",
          message: "Plugin registry repair should run at this doctor position.",
          path: "plugin-registry",
        },
      ];
    }
    const { detectPluginRegistryStateIssues } =
      await import("../commands/doctor-plugin-registry.js");
    const issues = await detectPluginRegistryStateIssues({
      config: ctx.cfg,
      env: ctx.env ?? process.env,
      prompter: { shouldRepair: false },
    });
    return issues.map(
      (issue): HealthFinding => ({
        checkId: "core/doctor/plugin-registry",
        severity: issue.kind === "disabled" ? "info" : "warning",
        message: pluginRegistryIssueFindingMessage(issue.kind),
        path: pluginRegistryIssuePath(issue),
        fixHint:
          issue.kind === "disabled"
            ? "Unset the plugin registry migration disable environment variable to allow repair."
            : "Run `openclaw doctor --fix` to repair plugin registry state.",
      }),
    );
  },
  async repair(ctx, findings) {
    const { detectPluginRegistryStateIssues, repairPluginRegistryState } =
      await import("../commands/doctor-plugin-registry.js");
    const params = {
      config: ctx.cfg,
      env: ctx.env ?? process.env,
      prompter: { shouldRepair: ctx.dryRun !== true },
    };
    const issues = filterPluginRegistryIssuesForFindings(
      await detectPluginRegistryStateIssues(params),
      findings,
    );
    const shouldRunPositionalRepair = findings.some(
      (finding) => finding.path === "plugin-registry",
    );
    if (issues.length === 0 && !shouldRunPositionalRepair) {
      return {
        status: "skipped",
        reason: "plugin registry finding no longer exists",
        changes: [],
      };
    }
    const repairIssues = issues.length === 0 && shouldRunPositionalRepair ? undefined : issues;
    const previewIssues = repairIssues ?? [{ kind: "migration" }];
    if (ctx.dryRun === true) {
      return {
        changes: pluginRegistryDryRunChanges(previewIssues),
        effects: pluginRegistryRepairEffects(previewIssues, true),
      };
    }
    const result = await repairPluginRegistryState(params, repairIssues);
    return {
      config: result.config,
      status: result.status,
      reason: result.reason,
      changes: result.changes,
      warnings: result.warnings,
      effects: pluginRegistryRepairEffects(previewIssues, false),
    };
  },
};

const sessionLocksCheck: HealthCheck = {
  id: "core/doctor/session-locks",
  kind: "core",
  description: "Stale session write locks are detected and removed by doctor repair.",
  source: "doctor",
  async detect(ctx, scope) {
    const { detectSessionLockHealthIssues } = await import("../commands/doctor-session-locks.js");
    const issues = await detectSessionLockHealthIssues({
      config: ctx.cfg,
      env: ctx.env ?? process.env,
    });
    const scopedPaths = new Set(scope?.paths ?? []);
    const scopedIssues =
      scopedPaths.size === 0 ? issues : issues.filter((issue) => scopedPaths.has(issue.lockPath));
    return scopedIssues.map(
      (issue): HealthFinding => ({
        checkId: "core/doctor/session-locks",
        severity: "warning",
        message: `Stale session lock detected: ${path.basename(issue.lockPath)}.`,
        path: issue.lockPath,
        fixHint: "Run `openclaw doctor --fix` to remove stale session lock files.",
      }),
    );
  },
  async repair(ctx, findings) {
    const { detectSessionLockHealthIssues, repairSessionLockHealthIssues } =
      await import("../commands/doctor-session-locks.js");
    const params = {
      config: ctx.cfg,
      env: ctx.env ?? process.env,
    };
    const findingPaths = new Set(
      findings.map((finding) => finding.path).filter((path): path is string => path !== undefined),
    );
    const issues = (await detectSessionLockHealthIssues(params)).filter((issue) =>
      findingPaths.has(issue.lockPath),
    );
    if (ctx.dryRun === true) {
      return {
        changes: issues.map((issue) => `Would remove stale session lock ${issue.lockPath}.`),
        effects: issues.map((issue) => ({
          kind: "file" as const,
          action: "would-remove-stale-session-lock",
          target: issue.lockPath,
          dryRunSafe: false,
        })),
      };
    }
    const repaired = await repairSessionLockHealthIssues({
      ...params,
      lockPaths: [...findingPaths],
    });
    return {
      changes: repaired
        .filter((issue) => issue.removed)
        .map((issue) => `Removed stale session lock ${issue.lockPath}.`),
      effects: repaired.map((issue) => ({
        kind: "file" as const,
        action: "remove-stale-session-lock",
        target: issue.lockPath,
        dryRunSafe: false,
      })),
    };
  },
};

const sessionTranscriptsCheck: HealthCheck = {
  id: "core/doctor/session-transcripts",
  kind: "core",
  description: "Broken prompt-rewrite transcript branches are detected and repaired.",
  source: "doctor",
  async detect(ctx, scope) {
    const { detectSessionTranscriptHealthIssues } =
      await import("../commands/doctor-session-transcripts.js");
    const issues = await detectSessionTranscriptHealthIssues({ env: ctx.env ?? process.env });
    const scopedPaths = new Set(scope?.paths ?? []);
    const scopedIssues =
      scopedPaths.size === 0 ? issues : issues.filter((issue) => scopedPaths.has(issue.filePath));
    return scopedIssues.map(
      (issue): HealthFinding => ({
        checkId: "core/doctor/session-transcripts",
        severity: "warning",
        message: `Session transcript has duplicated prompt-rewrite branches: ${path.basename(
          issue.filePath,
        )}.`,
        path: issue.filePath,
        fixHint: "Run `openclaw doctor --fix` to rewrite the transcript to its active branch.",
      }),
    );
  },
  async repair(ctx, findings) {
    const { detectSessionTranscriptHealthIssues, repairSessionTranscriptHealthIssues } =
      await import("../commands/doctor-session-transcripts.js");
    const params = { env: ctx.env ?? process.env };
    const findingPaths = new Set(
      findings.map((finding) => finding.path).filter((path): path is string => path !== undefined),
    );
    const issues = (await detectSessionTranscriptHealthIssues(params)).filter((issue) =>
      findingPaths.has(issue.filePath),
    );
    if (ctx.dryRun === true) {
      return {
        changes: issues.map(
          (issue) => `Would rewrite session transcript active branch ${issue.filePath}.`,
        ),
        effects: issues.map((issue) => ({
          kind: "file" as const,
          action: "would-rewrite-session-transcript-active-branch",
          target: issue.filePath,
          dryRunSafe: true,
        })),
      };
    }
    const repaired = await repairSessionTranscriptHealthIssues({
      ...params,
      filePaths: [...findingPaths],
    });
    return {
      changes: repaired
        .filter((issue) => issue.repaired)
        .map((issue) => `Rewrote session transcript active branch ${issue.filePath}.`),
      effects: repaired.map((issue) => ({
        kind: "file" as const,
        action: "rewrite-session-transcript-active-branch",
        target: issue.filePath,
        dryRunSafe: true,
      })),
    };
  },
};

function sandboxRegistryDryRunChanges(
  issues: readonly {
    kind: string;
    registryPath: string;
    valid: boolean;
    entries: number;
  }[],
): string[] {
  return issues.map((issue) => {
    if (!issue.valid) {
      return `Would quarantine invalid legacy sandbox ${issue.kind} registry ${issue.registryPath}.`;
    }
    if (issue.entries === 0) {
      return `Would remove empty legacy sandbox ${issue.kind} registry ${issue.registryPath}.`;
    }
    return `Would migrate legacy sandbox ${issue.kind} registry ${issue.registryPath} into sharded registry files.`;
  });
}

function sandboxRegistryEffects(
  issues: readonly {
    kind: string;
    registryPath: string;
    shardedDir: string;
    valid: boolean;
    entries: number;
  }[],
  dryRun: boolean,
) {
  const actionPrefix = dryRun ? "would-" : "";
  return issues.map((issue) => ({
    kind: "state" as const,
    action: `${actionPrefix}${
      !issue.valid
        ? "quarantine-legacy-sandbox-registry"
        : issue.entries === 0
          ? "remove-empty-legacy-sandbox-registry"
          : "migrate-legacy-sandbox-registry"
    }`,
    target: issue.registryPath,
    dryRunSafe: true,
  }));
}

const sandboxRegistryFilesCheck: HealthCheck = {
  id: "core/doctor/sandbox/registry-files",
  kind: "core",
  description: "Legacy monolithic sandbox registry files have been migrated to shards.",
  source: "doctor",
  async detect() {
    const { detectSandboxRegistryFileIssues } = await import("../commands/doctor-sandbox.js");
    const issues = await detectSandboxRegistryFileIssues();
    return issues.map(
      (issue): HealthFinding => ({
        checkId: "core/doctor/sandbox/registry-files",
        severity: "warning",
        message: `Legacy sandbox ${issue.kind} registry file detected.`,
        path: issue.registryPath,
        fixHint: "Run `openclaw doctor --fix` to migrate it to sharded registry files.",
      }),
    );
  },
  async repair(ctx) {
    const { detectSandboxRegistryFileIssues, formatLegacySandboxRegistryMigrationLine } =
      await import("../commands/doctor-sandbox.js");
    const { migrateLegacySandboxRegistryFiles } = await import("../agents/sandbox/registry.js");
    const issues = await detectSandboxRegistryFileIssues();
    if (ctx.dryRun === true) {
      return {
        changes: sandboxRegistryDryRunChanges(issues),
        effects: sandboxRegistryEffects(issues, true),
      };
    }
    const changes = (await migrateLegacySandboxRegistryFiles())
      .filter((result) => result.status !== "missing")
      .map(formatLegacySandboxRegistryMigrationLine)
      .filter((line) => line.length > 0);
    return {
      changes,
      effects: sandboxRegistryEffects(issues, false),
    };
  },
};

function sandboxImageIssueEffect(
  issue: {
    kind: string;
    imageKind?: "base" | "browser";
    image?: string;
    path: string;
    buildScript?: string;
  },
  dryRun: boolean,
) {
  const actionPrefix = dryRun ? "would-" : "";
  if (issue.kind === "missing-image" && issue.buildScript) {
    return {
      kind: "process" as const,
      action: `${actionPrefix}build-sandbox-${issue.imageKind}-image`,
      target: issue.image,
      dryRunSafe: false,
    };
  }
  return {
    kind: "other" as const,
    action: `${actionPrefix}inspect-sandbox-images`,
    target: issue.path,
    dryRunSafe: true,
  };
}

function sandboxImageDryRunChange(issue: {
  kind: string;
  imageKind?: "base" | "browser";
  image?: string;
  buildScript?: string;
  message: string;
}): string {
  if (issue.kind === "missing-image" && issue.buildScript) {
    return `Would build or pull missing sandbox ${issue.imageKind} image ${issue.image} with ${issue.buildScript}.`;
  }
  return `Would leave sandbox image issue for operator action: ${issue.message}`;
}

function sandboxImageOperatorWarning(issue: { message: string; fixHint?: string }): string {
  return issue.fixHint ? `${issue.message} ${issue.fixHint}` : issue.message;
}

type RepairableSandboxImageIssue = Extract<SandboxImageIssue, { kind: "missing-image" }> & {
  buildScript: string;
};

function isRepairableSandboxImageIssue(
  issue: SandboxImageIssue,
): issue is RepairableSandboxImageIssue {
  return issue.kind === "missing-image" && typeof issue.buildScript === "string";
}

const sandboxImagesCheck: HealthCheck = {
  id: "core/doctor/sandbox/images",
  kind: "core",
  description: "Sandbox Docker daemon and configured sandbox images are ready.",
  source: "doctor",
  async detect(ctx) {
    const { detectSandboxImageIssues } = await import("../commands/doctor-sandbox.js");
    const issues = await detectSandboxImageIssues(ctx.cfg);
    return issues.map(
      (issue): HealthFinding => ({
        checkId: "core/doctor/sandbox/images",
        severity: "warning",
        message: issue.message,
        path: issue.path,
        fixHint: issue.fixHint,
      }),
    );
  },
  async repair(ctx) {
    const { detectSandboxImageIssues, repairSandboxImages } =
      await import("../commands/doctor-sandbox.js");
    const issues = await detectSandboxImageIssues(ctx.cfg);
    const effects = issues.map((issue) => sandboxImageIssueEffect(issue, ctx.dryRun === true));
    if (ctx.dryRun === true) {
      return {
        changes: issues.map(sandboxImageDryRunChange),
        effects,
      };
    }
    const repairableIssues: RepairableSandboxImageIssue[] = issues.filter(
      isRepairableSandboxImageIssue,
    );
    const nonRepairableWarnings = issues
      .filter((issue) => issue.kind !== "missing-image" || !issue.buildScript)
      .map(sandboxImageOperatorWarning);
    if (repairableIssues.length === 0) {
      return {
        status: "skipped",
        reason: "sandbox image issue needs operator action",
        changes: [],
        warnings: nonRepairableWarnings,
        effects,
      };
    }
    const prompter = {
      confirmRuntimeRepair: async (params: Parameters<DoctorPrompter["confirmRuntimeRepair"]>[0]) =>
        ctx.doctor?.confirmRuntimeRepair?.(params) ?? ctx.doctor?.confirm?.(params) ?? true,
      note: async (message: string, title: string) => {
        await ctx.doctor?.note?.(message, title);
      },
    };
    const repaired = await repairSandboxImages({
      cfg: ctx.cfg,
      runtime: ctx.runtime,
      prompter,
      issues: repairableIssues,
    });
    return {
      status: repaired.status,
      reason: repaired.reason,
      config: repaired.config,
      changes: repaired.changes,
      warnings: [...nonRepairableWarnings, ...repaired.warnings],
      effects,
    };
  },
};

const sandboxScopeCheck: HealthCheck = {
  id: "core/doctor/sandbox-scope",
  kind: "core",
  description: "Per-agent sandbox overrides are not hidden by shared sandbox scope.",
  source: "doctor",
  async detect(ctx) {
    const { collectSandboxScopeWarnings } = await import("../commands/doctor-sandbox.js");
    return collectSandboxScopeWarnings(ctx.cfg).map(
      (warning): HealthFinding => ({
        checkId: "core/doctor/sandbox-scope",
        severity: "warning",
        message: warning.message,
        path: warning.path,
        fixHint: warning.fixHint,
      }),
    );
  },
};

const bootstrapSizeCheck: HealthCheck = {
  id: "core/doctor/bootstrap-size",
  kind: "core",
  description: "Workspace bootstrap files fit within configured injection limits.",
  source: "doctor",
  async detect(ctx) {
    const { buildBootstrapInjectionStats, analyzeBootstrapBudget } =
      await import("../agents/bootstrap-budget.js");
    const { resolveBootstrapContextForRun } = await import("../agents/bootstrap-files.js");
    const { resolveBootstrapMaxChars, resolveBootstrapTotalMaxChars } =
      await import("../agents/pi-embedded-helpers.js");
    const workspaceDir = resolveAgentWorkspaceDir(ctx.cfg, resolveDefaultAgentId(ctx.cfg));
    const { bootstrapFiles, contextFiles } = await resolveBootstrapContextForRun({
      workspaceDir,
      config: ctx.cfg,
    });
    const analysis = analyzeBootstrapBudget({
      files: buildBootstrapInjectionStats({
        bootstrapFiles,
        injectedFiles: contextFiles,
      }),
      bootstrapMaxChars: resolveBootstrapMaxChars(ctx.cfg),
      bootstrapTotalMaxChars: resolveBootstrapTotalMaxChars(ctx.cfg),
    });
    const findings: HealthFinding[] = [];
    for (const file of analysis.truncatedFiles) {
      findings.push({
        checkId: "core/doctor/bootstrap-size",
        severity: "warning",
        message: `${file.name} exceeds bootstrap limits and will be truncated.`,
        path: file.path,
        fixHint: "Reduce the file size or tune agents.defaults.bootstrapMaxChars/TotalMaxChars.",
      });
    }
    for (const file of analysis.nearLimitFiles) {
      if (file.truncated) {
        continue;
      }
      findings.push({
        checkId: "core/doctor/bootstrap-size",
        severity: "info",
        message: `${file.name} is near the configured bootstrap file limit.`,
        path: file.path,
        fixHint: "Reduce the file size or tune agents.defaults.bootstrapMaxChars.",
      });
    }
    if (analysis.totalNearLimit) {
      findings.push({
        checkId: "core/doctor/bootstrap-size",
        severity: analysis.hasTruncation ? "warning" : "info",
        message: "Total bootstrap context is near the configured total limit.",
        path: workspaceDir,
        fixHint: "Reduce bootstrap file sizes or tune agents.defaults.bootstrapTotalMaxChars.",
      });
    }
    return findings;
  },
};

function normalizeDoctorNoteLine(line: string): string {
  return line.replace(/^- /, "").trim();
}

function noteTextToFinding(params: {
  checkId: string;
  severity: HealthFinding["severity"];
  text: string;
}): HealthFinding {
  const lines = params.text.split("\n");
  const first = normalizeDoctorNoteLine(lines[0] ?? params.text);
  const rest = lines.slice(1).join("\n");
  return {
    checkId: params.checkId,
    severity: params.severity,
    message: first,
    ...(rest ? { fixHint: rest } : {}),
  };
}

async function runPresentationNoteHealthCheck(params: {
  ctx: { doctor?: { note?: (message: unknown, title?: string) => void | Promise<void> } };
  checkId: string;
  severity: HealthFinding["severity"];
  includeLintFinding?: (text: string) => boolean;
  run: (noteFn: (message: unknown, title?: string) => void | Promise<void>) => void | Promise<void>;
}): Promise<readonly HealthFinding[]> {
  const findings: HealthFinding[] = [];
  const noteFn = params.ctx.doctor?.note;
  await params.run((message, title) => {
    if (noteFn) {
      void noteFn(message, title);
      return;
    }
    const text = String(message);
    if (params.includeLintFinding && !params.includeLintFinding(text)) {
      return;
    }
    findings.push(
      noteTextToFinding({
        checkId: params.checkId,
        severity: params.severity,
        text,
      }),
    );
  });
  return findings;
}

function noteHasActionableFix(text: string): boolean {
  return /(^|\n)- Fix:/.test(text);
}

function browserNoteIsLintFinding(text: string): boolean {
  const lower = text.toLowerCase();
  return (
    lower.includes("browser health check is unavailable") ||
    lower.includes("no chromium-based browser executable") ||
    lower.includes("google chrome was not found") ||
    lower.includes("too old") ||
    lower.includes("could not determine the installed chrome version") ||
    lower.includes("no display or wayland_display") ||
    lower.includes("running as root") ||
    lower.includes("legacy managed browser profile residue")
  );
}

const claudeCliCheck: HealthCheck = {
  id: "core/doctor/claude-cli",
  kind: "core",
  description: "Claude CLI readiness is reported through doctor presentation notes.",
  source: "doctor",
  async detect(ctx) {
    const { noteClaudeCliHealth } = await import("../commands/doctor-claude-cli.js");
    return runPresentationNoteHealthCheck({
      ctx,
      checkId: "core/doctor/claude-cli",
      severity: "warning",
      includeLintFinding: noteHasActionableFix,
      run(noteFn) {
        noteClaudeCliHealth(ctx.cfg, {
          noteFn,
          ...(ctx.cwd ? { workspaceDir: ctx.cwd } : {}),
        });
      },
    });
  },
};

function createSecurityCheck(deps: CoreHealthCheckDeps): HealthCheck {
  return {
    id: "core/doctor/security",
    kind: "core",
    description: "Security posture checks produce structured findings.",
    source: "doctor",
    async detect(ctx) {
      const warnings = await deps.collectSecurityWarnings(ctx.cfg);
      return warnings.map((warning) =>
        noteTextToFinding({
          checkId: "core/doctor/security",
          severity: warning.includes("CRITICAL") ? "error" : "warning",
          text: warning,
        }),
      );
    },
  };
}

const openAIOAuthTlsCheck: HealthCheck = {
  id: "core/doctor/oauth-tls",
  kind: "core",
  description: "OpenAI OAuth TLS prerequisites are satisfied before browser auth.",
  source: "doctor",
  async detect(ctx) {
    const {
      formatOpenAIOAuthTlsPreflightFix,
      runOpenAIOAuthTlsPreflight,
      shouldRunOpenAIOAuthTlsPrerequisites,
    } = await import("../commands/oauth-tls-preflight.js");
    if (!shouldRunOpenAIOAuthTlsPrerequisites({ cfg: ctx.cfg, deep: ctx.mode === "doctor" })) {
      return [];
    }
    const result = await runOpenAIOAuthTlsPreflight({ timeoutMs: 4000 });
    if (result.ok || result.kind !== "tls-cert") {
      return [];
    }
    const fix = formatOpenAIOAuthTlsPreflightFix(result);
    return [
      noteTextToFinding({
        checkId: "core/doctor/oauth-tls",
        severity: "warning",
        text: fix,
      }),
    ];
  },
};

const configAuditScrubCheck: HealthCheck = {
  id: "core/doctor/config-audit-scrub",
  kind: "core",
  description: "Historical config audit argv values are redacted at rest.",
  source: "doctor",
  async detect(ctx) {
    const { detectConfigAuditScrubIssues } =
      await import("../commands/doctor-config-audit-scrub.js");
    const issues = await detectConfigAuditScrubIssues({ env: ctx.env ?? process.env });
    return issues.map(
      (issue): HealthFinding => ({
        checkId: "core/doctor/config-audit-scrub",
        severity: "warning",
        message: issue.message,
        path: issue.auditPath,
        fixHint: issue.fixHint,
      }),
    );
  },
  async repair(ctx, findings) {
    const { detectConfigAuditScrubIssues, repairConfigAuditScrubIssues } =
      await import("../commands/doctor-config-audit-scrub.js");
    const findingPaths = new Set(
      findings.map((finding) => finding.path).filter((path): path is string => path !== undefined),
    );
    const issues = (await detectConfigAuditScrubIssues({ env: ctx.env ?? process.env })).filter(
      (issue) => findingPaths.has(issue.auditPath),
    );
    if (issues.length === 0) {
      return { changes: [], effects: [] };
    }
    if (ctx.dryRun === true) {
      return {
        changes: issues.map(
          (issue) =>
            `Would scrub ${issue.rewritten} config audit log entr${
              issue.rewritten === 1 ? "y" : "ies"
            } in ${issue.auditPath}.`,
        ),
        effects: issues.map((issue) => ({
          kind: "file" as const,
          action: "would-scrub-config-audit-log",
          target: issue.auditPath,
          dryRunSafe: true,
        })),
      };
    }
    const result = await repairConfigAuditScrubIssues({ env: ctx.env ?? process.env });
    return {
      status: result.aborted ? ("skipped" as const) : ("repaired" as const),
      reason: result.aborted ? "config audit log changed during rewrite" : undefined,
      changes: result.changes,
      warnings: result.warnings,
      effects:
        result.rewritten > 0 && !result.aborted
          ? [
              {
                kind: "file" as const,
                action: "scrub-config-audit-log",
                target: result.auditPath,
                dryRunSafe: true,
              },
            ]
          : [],
    };
  },
};

const legacyCronStoreCheck: HealthCheck = {
  id: "core/doctor/legacy-cron-store",
  kind: "core",
  description: "Legacy cron store jobs are detected and normalized.",
  source: "doctor",
  async detect(ctx) {
    const { detectLegacyCronStoreIssues } = await import("../commands/doctor-cron.js");
    const issues = await detectLegacyCronStoreIssues({ cfg: ctx.cfg });
    return issues.map(
      (issue): HealthFinding => ({
        checkId: "core/doctor/legacy-cron-store",
        severity: "warning",
        message: issue.message,
        path: issue.storePath,
        fixHint: issue.fixHint,
      }),
    );
  },
  async repair(ctx, findings) {
    const { detectLegacyCronStoreIssues, repairLegacyCronStoreIssues } =
      await import("../commands/doctor-cron.js");
    const findingPaths = new Set(
      findings.map((finding) => finding.path).filter((path): path is string => path !== undefined),
    );
    const issues = (await detectLegacyCronStoreIssues({ cfg: ctx.cfg })).filter((issue) =>
      findingPaths.has(issue.storePath),
    );
    if (issues.length === 0) {
      return { changes: [], effects: [] };
    }
    if (ctx.dryRun === true) {
      const previewed = await repairLegacyCronStoreIssues({
        cfg: ctx.cfg,
        storePaths: [...findingPaths],
        dryRun: true,
      });
      return {
        changes: previewed.flatMap((result) => result.changes),
        warnings: previewed.flatMap((result) => result.warnings),
        effects: previewed.map((result) => ({
          kind: "file" as const,
          action: "would-normalize-legacy-cron-store",
          target: result.storePath,
          dryRunSafe: true,
        })),
      };
    }
    const repaired = await repairLegacyCronStoreIssues({
      cfg: ctx.cfg,
      storePaths: [...findingPaths],
    });
    const changed = repaired.filter((result) => result.changed);
    return {
      status:
        repaired.length > 0 && changed.length === 0 ? ("skipped" as const) : ("repaired" as const),
      reason:
        repaired.length > 0 && changed.length === 0
          ? "legacy cron store issues require manual migration"
          : undefined,
      changes: repaired.flatMap((result) => result.changes),
      warnings: repaired.flatMap((result) => result.warnings),
      effects: changed.map((result) => ({
        kind: "file" as const,
        action: "normalize-legacy-cron-store",
        target: result.storePath,
        dryRunSafe: true,
      })),
    };
  },
};

const legacyWhatsAppCrontabCheck: HealthCheck = {
  id: "core/doctor/legacy-whatsapp-crontab",
  kind: "core",
  description: "Legacy WhatsApp crontab health entries are detected as structured findings.",
  source: "doctor",
  async detect() {
    const { collectLegacyWhatsAppCrontabHealthWarning } =
      await import("../commands/doctor-cron.js");
    const warning = await collectLegacyWhatsAppCrontabHealthWarning();
    if (!warning) {
      return [];
    }
    return [
      noteTextToFinding({
        checkId: "core/doctor/legacy-whatsapp-crontab",
        severity: "warning",
        text: warning,
      }),
    ];
  },
};

const gatewayPlatformNotesCheck: HealthCheck = {
  id: "core/doctor/gateway-services/platform-notes",
  kind: "core",
  description: "Gateway platform notes are captured as structured findings.",
  source: "doctor",
  async detect(ctx) {
    const { collectMacGatewayPlatformWarnings } =
      await import("../commands/doctor-platform-notes.js");
    const warnings = await collectMacGatewayPlatformWarnings(ctx.cfg);
    return warnings.map((warning) =>
      noteTextToFinding({
        checkId: "core/doctor/gateway-services/platform-notes",
        severity: "warning",
        text: warning,
      }),
    );
  },
};

type HealthRepairNoteSink = {
  note?: (message: string, title?: string) => void | Promise<void>;
};

function makeHealthRepairPrompter(ctx: {
  readonly doctor?: HealthRepairContext["doctor"];
}): DoctorPrompter & HealthRepairNoteSink {
  const repairMode = ctx.doctor?.repairMode ?? {
    shouldRepair: true,
    shouldForce: ctx.doctor?.shouldForce === true,
    nonInteractive: ctx.doctor?.options?.nonInteractive === true,
    canPrompt: ctx.doctor?.options?.nonInteractive !== true,
    updateInProgress: false,
  };
  const confirm = ctx.doctor?.confirm ?? (async () => false);
  const confirmAutoFix = ctx.doctor?.confirmAutoFix ?? confirm;
  const confirmAggressiveAutoFix = ctx.doctor?.confirmAggressiveAutoFix ?? confirm;
  const confirmRuntimeRepair = ctx.doctor?.confirmRuntimeRepair ?? (async () => false);
  return {
    confirm,
    confirmAutoFix,
    confirmAggressiveAutoFix,
    confirmRuntimeRepair,
    select: async (_params, fallback) => fallback,
    note: async (message: string, title?: string) => {
      await ctx.doctor?.note?.(message, title);
    },
    shouldRepair: repairMode.shouldRepair,
    shouldForce: repairMode.shouldForce,
    repairMode,
  };
}

const gatewayExtraServicesCheck: HealthCheck = {
  id: "core/doctor/gateway-services/extra",
  kind: "core",
  description: "Extra gateway-like services are detected as structured findings.",
  source: "doctor",
  async detect(ctx) {
    const { detectExtraGatewayServices, formatExtraGatewayServiceFinding } =
      await import("../commands/doctor-gateway-services.js");
    const detected = await detectExtraGatewayServices(ctx.doctor?.options ?? {});
    return detected.services.map((svc) => ({
      checkId: "core/doctor/gateway-services/extra",
      severity: svc.legacy === true ? "warning" : "info",
      message: formatExtraGatewayServiceFinding(svc),
      path: svc.label,
      fixHint:
        svc.legacy === true
          ? "Run `openclaw doctor --fix` to remove legacy gateway services when service repair policy permits it."
          : "Run one gateway per machine for most setups, or isolate ports and config/state for intentional multi-gateway setups.",
    }));
  },
  async repair(ctx) {
    const { classifyLegacyServices, detectExtraGatewayServices, repairExtraGatewayServices } =
      await import("../commands/doctor-gateway-services.js");
    const {
      EXTERNAL_SERVICE_REPAIR_NOTE,
      isServiceRepairExternallyManaged,
      resolveServiceRepairPolicy,
    } = await import("../commands/doctor-service-repair-policy.js");
    const detected = await detectExtraGatewayServices(ctx.doctor?.options ?? {});
    if (detected.legacyServices.length === 0) {
      return {
        status: "skipped",
        reason: "no legacy gateway services are repairable",
        changes: [],
        warnings: detected.services.map(
          (svc) => `Extra gateway-like service remains: ${svc.label}`,
        ),
      };
    }
    const serviceRepairPolicy = resolveServiceRepairPolicy();
    if (isServiceRepairExternallyManaged(serviceRepairPolicy)) {
      return {
        status: "skipped",
        reason: "gateway service repair is externally managed",
        changes: [],
        warnings: [EXTERNAL_SERVICE_REPAIR_NOTE],
      };
    }
    const { darwinUserServices, failed, linuxUserServices } = classifyLegacyServices(
      detected.legacyServices,
    );
    const repairableServices = [...darwinUserServices, ...linuxUserServices];
    if (ctx.dryRun === true) {
      if (repairableServices.length === 0) {
        return {
          status: "skipped",
          reason: "no legacy gateway services are repairable",
          changes: [],
          warnings: failed.map((line) => `Would skip legacy gateway service cleanup: ${line}.`),
        };
      }
      return {
        changes: repairableServices.map(
          (svc) => `Would remove legacy gateway service ${svc.label}.`,
        ),
        warnings: failed.map((line) => `Would skip legacy gateway service cleanup: ${line}.`),
        effects: repairableServices.map((svc) => ({
          kind: "service",
          action: "would-remove-legacy-gateway-service",
          target: svc.label,
          dryRunSafe: false,
        })),
      };
    }
    const repaired = await repairExtraGatewayServices({
      options: ctx.doctor?.options ?? {},
      runtime: ctx.runtime,
      prompter: makeHealthRepairPrompter(ctx),
    });
    if (repaired.removed.length === 0) {
      return {
        status: "skipped",
        reason: "no legacy gateway services were removed",
        changes: detected.legacyServices.map(
          (svc) => `Checked legacy gateway service ${svc.label} for removal.`,
        ),
        warnings: repaired.failed.map((line) => `Legacy gateway cleanup skipped: ${line}.`),
        effects: [],
      };
    }
    return {
      changes: repaired.removed.map((line) => `Removed legacy gateway service ${line}.`),
      warnings: repaired.failed.map((line) => `Legacy gateway cleanup skipped: ${line}.`),
      effects: repaired.removed.map((line) => ({
        kind: "service",
        action: "remove-legacy-gateway-service",
        target: line,
        dryRunSafe: false,
      })),
    };
  },
};

const gatewayServiceConfigCheck: HealthCheck = {
  id: "core/doctor/gateway-services/config",
  kind: "core",
  description: "Gateway service config drift is detected as structured findings.",
  source: "doctor",
  async detect(ctx) {
    const { detectGatewayServiceConfigIssues } =
      await import("../commands/doctor-gateway-services.js");
    const detection = await detectGatewayServiceConfigIssues(ctx.cfg, resolveDoctorMode(ctx.cfg));
    const findings: HealthFinding[] = [];
    if (detection.tokenWarning) {
      findings.push({
        checkId: "core/doctor/gateway-services/config",
        severity: "warning",
        message: detection.tokenWarning,
        path: "gateway.auth.token",
      });
    }
    if (detection.gatewayRuntimeWarning) {
      findings.push({
        checkId: "core/doctor/gateway-services/config",
        severity: "warning",
        message: detection.gatewayRuntimeWarning,
        path: "gateway.runtime",
      });
    }
    if (detection.sourceCheckoutWarning && detection.showSourceCheckoutWarning) {
      findings.push(
        noteTextToFinding({
          checkId: "core/doctor/gateway-services/config",
          severity: "warning",
          text: detection.sourceCheckoutWarning,
        }),
      );
    }
    if (detection.serviceRewriteBlocked) {
      findings.push({
        checkId: "core/doctor/gateway-services/config",
        severity: "warning",
        message:
          "Gateway service is running; command/entrypoint rewrites are blocked for this doctor pass.",
        path: "gateway.service",
        fixHint:
          "Stop the service first or use `openclaw gateway install --force` when you want to replace the active launcher.",
      });
    }
    findings.push(
      ...detection.issues.map((issue) => ({
        checkId: "core/doctor/gateway-services/config",
        severity: "warning" as const,
        message: issue.detail ? `${issue.message} (${issue.detail})` : issue.message,
        path: "gateway.service",
        fixHint:
          "Run `openclaw doctor --fix` to update gateway service config when policy permits it.",
      })),
    );
    return findings;
  },
  async repair(ctx) {
    const { detectGatewayServiceConfigIssues, repairGatewayServiceConfig } =
      await import("../commands/doctor-gateway-services.js");
    const detection = await detectGatewayServiceConfigIssues(ctx.cfg, resolveDoctorMode(ctx.cfg));
    if (detection.issues.length === 0) {
      const warnings = [
        detection.tokenWarning,
        detection.gatewayRuntimeWarning,
        detection.sourceCheckoutWarning,
        detection.serviceRewriteBlocked
          ? "Gateway service is running; leaving supervisor metadata unchanged."
          : undefined,
      ].filter((warning): warning is string => Boolean(warning));
      return {
        status: warnings.length > 0 ? "skipped" : "repaired",
        reason:
          warnings.length > 0 ? "gateway service config issue needs operator action" : undefined,
        changes: [],
        warnings,
      };
    }
    if (ctx.dryRun === true) {
      return {
        changes: detection.issues.map((issue) =>
          issue.detail
            ? `Would update gateway service config for ${issue.message} (${issue.detail}).`
            : `Would update gateway service config for ${issue.message}.`,
        ),
        warnings: [
          ...(detection.serviceRewriteBlocked
            ? [
                "Gateway service is running; real repair would leave supervisor metadata unchanged unless the service is stopped or reinstalled with --force.",
              ]
            : []),
          ...(detection.gatewayRuntimeWarning ? [detection.gatewayRuntimeWarning] : []),
        ],
        effects: [
          {
            kind: "service",
            action: "would-update-gateway-service-config",
            target: "openclaw-gateway",
            dryRunSafe: false,
          },
        ],
      };
    }
    if (detection.serviceRewriteBlocked) {
      return {
        status: "skipped",
        reason: "gateway service rewrite is blocked while the service is running",
        changes: [],
        warnings: [
          "Gateway service is running; leaving supervisor metadata unchanged. Stop the service first or use `openclaw gateway install --force` when you want to replace the active launcher.",
          ...(detection.gatewayRuntimeWarning ? [detection.gatewayRuntimeWarning] : []),
        ],
        effects: [],
      };
    }
    const repaired = await repairGatewayServiceConfig({
      cfg: ctx.cfg,
      mode: resolveDoctorMode(ctx.cfg),
      runtime: ctx.runtime,
      prompter: makeHealthRepairPrompter(ctx),
    });
    if (repaired.status !== "repaired") {
      return {
        status: repaired.status,
        reason: repaired.reason,
        changes: [],
        warnings: detection.gatewayRuntimeWarning ? [detection.gatewayRuntimeWarning] : [],
        effects: [],
      };
    }
    return {
      changes: ["Checked gateway service config repair path."],
      warnings: detection.serviceRewriteBlocked
        ? ["Gateway service was running; supervisor metadata may remain unchanged."]
        : [],
      effects: [
        {
          kind: "service",
          action: "update-gateway-service-config",
          target: "openclaw-gateway",
          dryRunSafe: false,
        },
      ],
    };
  },
};

const browserCheck: HealthCheck = {
  id: "core/doctor/browser",
  kind: "core",
  description: "Browser readiness is reported through doctor presentation notes.",
  source: "doctor",
  async detect(ctx) {
    const { noteChromeMcpBrowserReadiness } = await import("../commands/doctor-browser.js");
    return runPresentationNoteHealthCheck({
      ctx,
      checkId: "core/doctor/browser",
      severity: "warning",
      includeLintFinding: browserNoteIsLintFinding,
      async run(noteFn) {
        await noteChromeMcpBrowserReadiness(ctx.cfg, {
          noteFn,
        });
      },
    });
  },
};

const workspaceStatusCheck: HealthCheck = {
  id: "core/doctor/workspace-status",
  kind: "core",
  description: "Workspace directory exists and has no legacy duplicates.",
  source: "doctor",
  async detect(ctx) {
    const { detectLegacyWorkspaceDirs } = await import("../commands/doctor-workspace.js");
    const workspaceDir = resolveAgentWorkspaceDir(ctx.cfg, resolveDefaultAgentId(ctx.cfg));
    const legacy = detectLegacyWorkspaceDirs({ workspaceDir });
    if (legacy.legacyDirs.length === 0) {
      return [];
    }
    return [
      {
        checkId: "core/doctor/workspace-status",
        severity: "info",
        message: `Detected ${legacy.legacyDirs.length} legacy workspace director${
          legacy.legacyDirs.length === 1 ? "y" : "ies"
        } alongside the active workspace.`,
        path: workspaceDir,
        fixHint:
          "Inspect the legacy directories and migrate or remove them; see `openclaw doctor` for the detailed migration prompt.",
      },
    ];
  },
};

function createSkillsReadinessCheck(deps: CoreHealthCheckDeps): HealthCheck {
  return {
    id: "core/doctor/skills-readiness",
    kind: "core",
    description: "Allowed skills are usable in the current runtime environment.",
    source: "doctor",
    async detect(ctx, scope) {
      const unavailable = filterUnavailableSkillsForScope(
        await deps.detectUnavailableSkills(ctx.cfg),
        scope?.paths,
      );
      return unavailable.map(unavailableSkillToFinding);
    },
    async repair(ctx, findings) {
      const unavailable = filterUnavailableSkillsForScope(
        await deps.detectUnavailableSkills(ctx.cfg),
        findings.map((finding) => finding.path),
      );
      if (unavailable.length === 0) {
        return { changes: [] };
      }
      const nextConfig = disableUnavailableSkillsInConfig(ctx.cfg, unavailable);
      return {
        config: nextConfig,
        changes: unavailable.map((skill) => `Disabled unavailable skill ${skill.name}.`),
        effects: unavailable.map((skill) => ({
          kind: "config" as const,
          action: ctx.dryRun === true ? "would-disable-skill" : "disable-skill",
          target: skillReadinessPath(skill),
          dryRunSafe: true,
        })),
      };
    },
  };
}

function unavailableSkillToFinding(skill: SkillStatusEntry): HealthFinding {
  return {
    checkId: "core/doctor/skills-readiness",
    severity: "warning",
    message: `${skill.name} is allowed but unavailable: ${formatMissingSkillSummary(skill)}.`,
    path: skillReadinessPath(skill),
    fixHint:
      "Install/configure the missing requirement, or run `openclaw doctor --fix` to disable unused unavailable skills.",
  };
}

function filterUnavailableSkillsForScope(
  unavailable: readonly SkillStatusEntry[],
  paths: readonly (string | undefined)[] | undefined,
): SkillStatusEntry[] {
  const scopedPaths = new Set(paths?.filter((path): path is string => path !== undefined) ?? []);
  if (scopedPaths.size === 0) {
    return [...unavailable];
  }
  return unavailable.filter((skill) => scopedPaths.has(skillReadinessPath(skill)));
}

function skillReadinessPath(skill: SkillStatusEntry): string {
  return `skills.entries.${skill.skillKey}.enabled`;
}

function browserResidueDeps(ctx: { configPath?: string }) {
  return ctx.configPath ? { configDir: path.dirname(ctx.configPath) } : {};
}

function browserResidueFinding(residue: LegacyClawdBrowserProfileResidue): HealthFinding {
  return {
    checkId: BROWSER_CLAWD_PROFILE_RESIDUE_CHECK_ID,
    severity: "warning",
    message: `Legacy managed browser profile residue was found at ${residue.legacyProfileDir}.`,
    path: residue.legacyProfileDir,
    ocPath: "oc://state/browser/clawd",
    fixHint:
      "Run `openclaw doctor --fix` to archive the stale clawd profile safely instead of deleting it in place.",
  };
}

function formatWouldArchiveBrowserResidue(residue: LegacyClawdBrowserProfileResidue): string {
  return [
    "Would archive legacy clawd managed browser profile residue.",
    `- legacy profile: ${residue.legacyProfileDir}`,
    `- canonical profile: ${residue.canonicalUserDataDir}`,
  ].join("\n");
}

const browserClawdProfileResidueCheck: HealthCheck = {
  id: BROWSER_CLAWD_PROFILE_RESIDUE_CHECK_ID,
  kind: "core",
  description:
    "Legacy clawd managed browser profile residue has been archived after the OpenClaw rename.",
  source: "doctor",
  async detect(ctx, scope) {
    const residue = await detectLegacyClawdBrowserProfileResidue(ctx.cfg, browserResidueDeps(ctx));
    if (!residue) {
      return [];
    }
    const scopedPaths = new Set(scope?.paths ?? []);
    if (scopedPaths.size > 0 && !scopedPaths.has(residue.legacyProfileDir)) {
      return [];
    }
    return [browserResidueFinding(residue)];
  },
  async repair(ctx) {
    const residue = await detectLegacyClawdBrowserProfileResidue(ctx.cfg, browserResidueDeps(ctx));
    if (!residue) {
      return {
        status: "skipped",
        reason: "legacy clawd browser profile residue no longer exists",
        changes: [],
      };
    }
    const effect = {
      kind: "state" as const,
      action:
        ctx.dryRun === true
          ? "would-archive-legacy-browser-profile-residue"
          : "archive-legacy-browser-profile-residue",
      target: residue.legacyProfileDir,
      dryRunSafe: false,
    };
    if (ctx.dryRun === true) {
      return {
        changes: [formatWouldArchiveBrowserResidue(residue)],
        effects: [effect],
      };
    }
    const result = await maybeArchiveLegacyClawdBrowserProfileResidue(
      ctx.cfg,
      browserResidueDeps(ctx),
    );
    if (result.changes.length === 0 && result.warnings.length > 0) {
      return {
        status: "failed",
        reason: result.warnings.join("; "),
        changes: [],
        warnings: result.warnings,
        effects: [],
      };
    }
    return {
      changes: result.changes,
      warnings: result.warnings,
      effects: result.changes.length > 0 ? [effect] : [],
    };
  },
};

const finalConfigValidationCheck: HealthCheck = {
  id: FINAL_CONFIG_VALIDATION_CHECK_ID,
  kind: "core",
  description: "Active openclaw.jsonc parses and conforms to the config schema.",
  source: "doctor",
  async detect() {
    const { readConfigFileSnapshot } = await import("../config/config.js");
    const snap = await readConfigFileSnapshot({ observe: false });
    if (!snap.exists || snap.valid) {
      return [];
    }
    return configValidationIssuesToHealthFindings(snap.issues);
  },
};

function createWorkspaceSuggestionsCheck(deps: CoreHealthCheckDeps): HealthCheck {
  return {
    id: "core/doctor/workspace-suggestions",
    kind: "core",
    description: "Workspace backup and memory-system suggestions are reported as doctor notes.",
    source: "doctor",
    async detect(ctx) {
      const workspaceDir = resolveAgentWorkspaceDir(ctx.cfg, resolveDefaultAgentId(ctx.cfg));
      const notes = await deps.collectWorkspaceSuggestionNotes(workspaceDir);
      const noteFn = ctx.doctor?.note;
      if (!noteFn) {
        return notes.map((note) =>
          noteTextToFinding({
            checkId: "core/doctor/workspace-suggestions",
            severity: "info",
            text: note,
          }),
        );
      }
      for (const note of notes) {
        await noteFn(note, "Workspace");
      }
      return [];
    },
  };
}

const shellCompletionCheck: HealthCheck = {
  id: "core/doctor/shell-completion",
  kind: "core",
  description: "Shell completion status is detected and repairable through cached completion.",
  source: "doctor",
  async detect(ctx) {
    const { detectShellCompletionHealth } = await import("../commands/doctor-completion.js");
    const options =
      ctx.mode === "lint" ? { ...ctx.doctor?.options, nonInteractive: true } : ctx.doctor?.options;
    return detectShellCompletionHealth(options);
  },
  async repair(ctx) {
    if (ctx.dryRun === true) {
      return {
        changes: ["Would repair shell completion setup."],
        effects: [
          {
            kind: "file",
            action: "would-repair-shell-completion",
            target: "shell completion profile/cache",
            dryRunSafe: false,
          },
        ],
      };
    }
    const { repairShellCompletionHealth } = await import("../commands/doctor-completion.js");
    const result = await repairShellCompletionHealth({
      options: ctx.doctor?.options,
      deps: {
        confirm: ctx.doctor?.confirm,
      },
    });
    return {
      status: result.status,
      changes: result.changes,
      warnings: result.warnings,
    };
  },
};

const startupChannelMaintenanceCheck: HealthCheck = {
  id: "core/doctor/startup-channel-maintenance",
  kind: "core",
  description: "Channel plugin startup maintenance runs through structured doctor repair.",
  source: "doctor",
  async detect(ctx, scope) {
    if (ctx.mode !== "fix" || scope?.findings !== undefined) {
      return [];
    }
    return [
      {
        checkId: "core/doctor/startup-channel-maintenance",
        severity: "info",
        message: "Channel plugin startup maintenance should run during doctor repair.",
      },
    ];
  },
  async repair(ctx) {
    if (ctx.dryRun === true) {
      return {
        changes: ["Would run channel plugin startup maintenance."],
        effects: [
          {
            kind: "other",
            action: "would-run-channel-startup-maintenance",
            target: "channel plugin startup maintenance",
            dryRunSafe: false,
          },
        ],
      };
    }
    const { maybeRunDoctorStartupChannelMaintenance } =
      await import("./doctor-startup-channel-maintenance.js");
    await maybeRunDoctorStartupChannelMaintenance({
      cfg: ctx.cfg,
      env: ctx.env,
      runtime: ctx.runtime,
      shouldRepair: true,
    });
    return { changes: [] };
  },
};

const systemdLingerCheck: HealthCheck = {
  id: "core/doctor/systemd-linger",
  kind: "core",
  description: "systemd user linger status is detected and repairable for local Gateway.",
  source: "doctor",
  async detect(ctx) {
    if (
      ctx.doctor?.options?.nonInteractive === true ||
      process.platform !== "linux" ||
      resolveDoctorMode(ctx.cfg) !== "local"
    ) {
      return [];
    }
    const { resolveGatewayService } = await import("../daemon/service.js");
    const service = resolveGatewayService();
    let loaded = false;
    try {
      loaded = await service.isLoaded({ env: ctx.env ?? process.env });
    } catch {
      loaded = false;
    }
    if (!loaded) {
      return [];
    }
    const { SYSTEMD_GATEWAY_LINGER_REASON, detectSystemdUserLingerFindings } =
      await import("../commands/systemd-linger.js");
    const findings = await detectSystemdUserLingerFindings({
      env: ctx.env,
      reason: SYSTEMD_GATEWAY_LINGER_REASON,
    });
    return findings.map(
      (finding): HealthFinding => ({
        checkId: "core/doctor/systemd-linger",
        severity: "warning",
        message: finding.message,
        source: "systemd",
        fixHint: finding.fixHint,
      }),
    );
  },
  async repair(ctx) {
    if (ctx.dryRun === true) {
      return {
        changes: ["Would enable systemd lingering if it is disabled for the Gateway user."],
        effects: [
          {
            kind: "service",
            action: "would-enable-systemd-linger",
            target: "systemd user linger",
            dryRunSafe: false,
          },
        ],
      };
    }
    const { SYSTEMD_GATEWAY_LINGER_REASON, repairSystemdUserLingerFinding } =
      await import("../commands/systemd-linger.js");
    const result = await repairSystemdUserLingerFinding({
      runtime: ctx.runtime,
      env: ctx.env,
      confirm: ctx.doctor?.confirm,
      reason: SYSTEMD_GATEWAY_LINGER_REASON,
      requireConfirm: true,
    });
    return {
      status: result.status,
      changes: result.changes,
      warnings: result.warnings,
    };
  },
};

function createConvertedWorkflowChecks(deps: CoreHealthCheckDeps): readonly HealthCheck[] {
  return [
    claudeCliCheck,
    gatewayAuthCheck,
    legacyStateCheck,
    legacyPluginManifestsCheck,
    configuredPluginInstallsCheck,
    pluginRegistryCheck,
    sessionLocksCheck,
    sessionTranscriptsCheck,
    configAuditScrubCheck,
    legacyCronStoreCheck,
    sandboxRegistryFilesCheck,
    sandboxImagesCheck,
    sandboxScopeCheck,
    legacyWhatsAppCrontabCheck,
    gatewayExtraServicesCheck,
    gatewayServiceConfigCheck,
    gatewayPlatformNotesCheck,
    startupChannelMaintenanceCheck,
    createSecurityCheck(deps),
    browserCheck,
    openAIOAuthTlsCheck,
    hooksModelCheck,
    systemdLingerCheck,
    bootstrapSizeCheck,
    shellCompletionCheck,
    createWorkspaceSuggestionsCheck(deps),
  ];
}

let registered = false;

export function registerCoreHealthChecks(): void {
  if (registered) {
    return;
  }
  for (const check of CORE_HEALTH_CHECKS) {
    registerHealthCheck(check);
  }
  registered = true;
}

export function resetCoreHealthChecksForTest(): void {
  registered = false;
}

export function createCoreHealthChecks(
  deps: CoreHealthCheckDeps = defaultCoreHealthCheckDeps,
): readonly HealthCheck[] {
  return [
    gatewayConfigCheck,
    ...createConvertedWorkflowChecks(deps),
    commandOwnerCheck,
    workspaceStatusCheck,
    createSkillsReadinessCheck(deps),
    browserClawdProfileResidueCheck,
    finalConfigValidationCheck,
  ];
}

export const CORE_HEALTH_CHECKS: readonly HealthCheck[] = createCoreHealthChecks();

function formatMissingSkillSummary(skill: SkillStatusEntry): string {
  const missing: string[] = [];
  if (skill.missing.bins.length > 0) {
    missing.push(`bins: ${skill.missing.bins.join(", ")}`);
  }
  if (skill.missing.anyBins.length > 0) {
    missing.push(`any bins: ${skill.missing.anyBins.join(", ")}`);
  }
  if (skill.missing.env.length > 0) {
    missing.push(`env: ${skill.missing.env.join(", ")}`);
  }
  if (skill.missing.config.length > 0) {
    missing.push(`config: ${skill.missing.config.join(", ")}`);
  }
  if (skill.missing.os.length > 0) {
    missing.push(`os: ${skill.missing.os.join(", ")}`);
  }
  return missing.join("; ") || "unknown requirement";
}
