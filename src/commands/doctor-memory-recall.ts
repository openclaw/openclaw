import { note } from "../../packages/terminal-core/src/note.js";
import { formatCliCommand } from "../cli/command-format.js";
import { DEFAULT_CRON_ENABLED } from "../config/cron-limits.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { CronJob } from "../cron/types.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  DEFAULT_MEMORY_DREAMING_PLUGIN_ID,
  resolveMemoryDreamingConfig,
  resolveMemoryDreamingPluginConfig,
  resolveMemoryDreamingPluginId,
} from "../memory-host-sdk/dreaming.js";
import { readMemorySearchManagerStatus } from "../memory-host-sdk/host/types.js";
import {
  auditDreamingArtifacts,
  auditShortTermPromotionArtifacts,
  repairDreamingArtifacts,
  repairShortTermPromotionArtifacts,
  type ShortTermAuditSummary,
} from "../plugin-sdk/memory-core-bundled-runtime.js";
import { loadPluginRegistryHandle } from "../plugins/loader.js";
import { loadPluginManifestRegistryCore } from "../plugins/manifest-registry.js";
import {
  getActiveMemorySearchManagerCore,
  resolveActiveMemoryBackendConfig,
} from "../plugins/memory-runtime.js";
import { loadBundledPluginPublicArtifactModuleSync } from "../plugins/public-surface-loader.js";
import {
  formatMemoryDoctorAgentMessage,
  resolveMemoryDoctorAgentScopes,
} from "./doctor-memory-scope.js";
import type { DoctorPrompter } from "./doctor-prompter.js";
import { maybeRepairWorkspaceMemoryHealth } from "./doctor-workspace.js";

type DreamingStatusApi = {
  readMemoryCoreDreamingRuns: (params: {
    workspaceDir: string;
    dreamingEnabled: boolean;
    cronEnabled: boolean;
    readCronJobs: () => Promise<CronJob[]>;
  }) => Promise<string[]>;
};

async function resolveRuntimeMemoryWorkspaceDir(
  cfg: OpenClawConfig,
  agentId: string,
): Promise<string | undefined> {
  const result = await getActiveMemorySearchManagerCore({
    cfg,
    agentId,
    purpose: "status",
  });
  const manager = result.manager;
  if (!manager) {
    return undefined;
  }
  try {
    return (await readMemorySearchManagerStatus(manager)).workspaceDir?.trim();
  } finally {
    await manager.close?.().catch(() => undefined);
  }
}

function buildMemoryArtifactIssueNote(
  issues: ReadonlyArray<Pick<ShortTermAuditSummary["issues"][number], "message" | "fixable">>,
  heading: string,
  location: string,
): string | null {
  if (issues.length === 0) {
    return null;
  }
  return [
    heading,
    ...issues.map((issue) => `- ${issue.message}`),
    location,
    issues.some((issue) => issue.fixable)
      ? `Fix: ${formatCliCommand("openclaw doctor --fix")} or ${formatCliCommand("openclaw memory status --fix")}`
      : `Verify: ${formatCliCommand("openclaw memory status --deep")}`,
  ].join("\n");
}

async function runMemoryRecallHealth(
  cfg: OpenClawConfig,
  prompter?: DoctorPrompter,
  deep = true,
): Promise<void> {
  const scopes = resolveMemoryDoctorAgentScopes(cfg);
  const labelAgents = scopes.length > 1;
  const dreaming = prompter
    ? undefined
    : resolveMemoryDreamingConfig({ cfg, pluginConfig: resolveMemoryDreamingPluginConfig(cfg) });
  let cronJobs: Promise<CronJob[]> | undefined;
  const readCronJobs = () =>
    (cronJobs ??= (async () => {
      const { resolveCronJobsStorePathFromConfigAsync } = await import("../cron/store/paths.js");
      const { loadCronJobsStoreWithConfigJobsReadOnly } =
        await import("../cron/store/read-only.js");
      const storePath = await resolveCronJobsStorePathFromConfigAsync(cfg);
      return (await loadCronJobsStoreWithConfigJobsReadOnly(storePath)).store.jobs;
    })());
  for (const scope of scopes) {
    const agentMessage = (message: string) =>
      formatMemoryDoctorAgentMessage(scope.agentId, labelAgents, message);
    const report = (message: string) => note(agentMessage(message), "Memory search");
    try {
      if (!deep) {
        continue;
      }
      const backend = resolveActiveMemoryBackendConfig({ cfg, agentId: scope.agentId });
      if (backend?.backend === "provider-runtime") {
        continue;
      }
      if (prompter) {
        await maybeRepairWorkspaceMemoryHealth({
          prompter,
          scope: {
            agentId: scope.agentId,
            workspaceDir: scope.workspaceDir,
            labelAgent: labelAgents,
          },
        });
      }
      const workspaceDir = await resolveRuntimeMemoryWorkspaceDir(cfg, scope.agentId);
      if (!workspaceDir) {
        continue;
      }
      if (!prompter) {
        const audit = await auditShortTermPromotionArtifacts({ workspaceDir });
        const message = buildMemoryArtifactIssueNote(
          audit.issues,
          "Memory recall artifacts need attention:",
          `Recall store: ${audit.storePath}`,
        );
        if (message) {
          report(message);
        }
        const dreamingAudit = await auditDreamingArtifacts({ workspaceDir });
        const dreamingMessage = buildMemoryArtifactIssueNote(
          dreamingAudit.issues,
          "Dreaming artifacts need attention:",
          `Dream corpus: ${dreamingAudit.sessionCorpusDir}`,
        );
        if (dreamingMessage) {
          report(dreamingMessage);
        }
        continue;
      }
      for (const kind of ["recall", "dreaming"] as const) {
        const audit = await (
          kind === "recall" ? auditShortTermPromotionArtifacts : auditDreamingArtifacts
        )({ workspaceDir });
        if (!audit.issues.some((issue) => issue.fixable)) {
          continue;
        }
        const approved = await prompter.confirmRuntimeRepair({
          message: agentMessage(
            kind === "recall"
              ? "Remove dangling memory recalls, normalize recall artifacts, and remove stale promotion locks?"
              : "Archive contaminated dreaming artifacts and reset derived dream corpus state?",
          ),
          initialValue: true,
        });
        if (!approved) {
          continue;
        }
        let lines: Array<string | null>;
        if (kind === "recall") {
          const repair = await repairShortTermPromotionArtifacts({ workspaceDir });
          if (!repair.changed) {
            continue;
          }
          const details = [
            [repair.removedInvalidEntries, "invalid"],
            [repair.removedDanglingEntries ?? 0, "dangling"],
            [repair.removedOverflowEntries ?? 0, "overflow"],
          ] as const;
          const removed = details
            .filter(([count]) => count > 0)
            .map(([count, label]) => `-${count} ${label} entries`)
            .join(", ");
          lines = [
            "Memory recall artifacts repaired:",
            repair.rewroteStore ? `- rewrote recall store${removed ? ` (${removed})` : ""}` : null,
            repair.removedStaleLock ? "- removed stale promotion lock" : null,
          ];
        } else {
          const repair = await repairDreamingArtifacts({ workspaceDir });
          if (!repair.changed) {
            continue;
          }
          lines = [
            "Dreaming artifacts repaired:",
            repair.archivedSessionCorpus ? "- archived session corpus" : null,
            repair.archivedSessionIngestion ? "- archived session-ingestion state" : null,
            repair.archivedDreamsDiary ? "- archived dream diary" : null,
            repair.archiveDir ? `- archive dir: ${repair.archiveDir}` : null,
            ...repair.warnings.map((warning) => `- warning: ${warning}`),
          ];
        }
        lines.push(`Verify: ${formatCliCommand("openclaw memory status --deep")}`);
        note(agentMessage(lines.filter(Boolean).join("\n")), "Doctor changes");
      }
    } catch (err) {
      report(
        `${prompter ? "Memory artifact repair" : "Memory recall audit"} could not be completed: ${formatErrorMessage(err)}`,
      );
    } finally {
      if (dreaming) {
        const enabled =
          dreaming.enabled &&
          loadPluginRegistryHandle({
            config: cfg,
            registrationConfigOrigin: cfg,
            manifestRegistry: loadPluginManifestRegistryCore({
              config: cfg,
              workspaceDir: scope.workspaceDir,
            }),
            workspaceDir: scope.workspaceDir,
            loadModules: false,
            onlyPluginIds: [resolveMemoryDreamingPluginId(cfg)],
          }).plugins.some(
            (plugin) =>
              plugin.id === DEFAULT_MEMORY_DREAMING_PLUGIN_ID && plugin.status === "loaded",
          );
        const lines = [
          `Dreaming: ${enabled ? "enabled" : "disabled"} (cadence ${dreaming.frequency}).`,
        ];
        try {
          const status = loadBundledPluginPublicArtifactModuleSync<DreamingStatusApi>({
            dirName: "memory-core",
            artifactBasename: "dreaming-status-api.js",
          });
          lines.push(
            ...(await status.readMemoryCoreDreamingRuns({
              workspaceDir: scope.workspaceDir,
              dreamingEnabled: enabled,
              cronEnabled:
                process.env.OPENCLAW_SKIP_CRON !== "1" &&
                (cfg.cron?.enabled ?? DEFAULT_CRON_ENABLED),
              readCronJobs,
            })),
          );
        } catch (error) {
          lines.push(`Dreaming run telemetry unavailable: ${formatErrorMessage(error)}`);
        }
        report(lines.join("\n"));
      }
    }
  }
}

export async function noteMemoryRecallHealth(cfg: OpenClawConfig, deep = true): Promise<void> {
  return runMemoryRecallHealth(cfg, undefined, deep);
}

export async function maybeRepairMemoryRecallHealth(params: {
  cfg: OpenClawConfig;
  prompter: DoctorPrompter;
}): Promise<void> {
  return runMemoryRecallHealth(params.cfg, params.prompter);
}
