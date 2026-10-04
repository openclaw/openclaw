import { note } from "../../packages/terminal-core/src/note.js";
import { formatCliCommand } from "../cli/command-format.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  resolveMemoryDreamingConfig,
  resolveMemoryDreamingPluginConfig,
} from "../memory-host-sdk/dreaming.js";
import {
  auditDreamingArtifacts,
  auditShortTermPromotionArtifacts,
  repairDreamingArtifacts,
  repairShortTermPromotionArtifacts,
  type ShortTermAuditSummary,
} from "../plugin-sdk/memory-core-bundled-runtime.js";
import {
  getActiveMemorySearchManagerCore,
  resolveActiveMemoryBackendConfig,
} from "../plugins/memory-runtime.js";
import {
  formatMemoryDoctorAgentMessage,
  resolveMemoryDoctorAgentScopes,
} from "./doctor-memory-scope.js";
import type { DoctorPrompter } from "./doctor-prompter.js";
import { maybeRepairWorkspaceMemoryHealth } from "./doctor-workspace.js";

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
    return manager.status().workspaceDir?.trim();
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

export async function noteMemoryRecallHealth(cfg: OpenClawConfig): Promise<void> {
  const scopes = resolveMemoryDoctorAgentScopes(cfg);
  const labelAgents = scopes.length > 1;
  const dreaming = resolveMemoryDreamingConfig({
    cfg,
    pluginConfig: resolveMemoryDreamingPluginConfig(cfg),
  });
  for (const scope of scopes) {
    const report = (message: string) =>
      note(formatMemoryDoctorAgentMessage(scope.agentId, labelAgents, message), "Memory search");
    const backend = resolveActiveMemoryBackendConfig({ cfg, agentId: scope.agentId });
    if (backend?.backend === "provider-runtime") {
      report(`Not applicable: ${backend.providerId} uses the provider runtime; see its health.`);
      continue;
    }
    try {
      const workspaceDir = await resolveRuntimeMemoryWorkspaceDir(cfg, scope.agentId);
      if (!workspaceDir) {
        continue;
      }
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
    } catch (err) {
      report(`Memory recall audit could not be completed: ${formatErrorMessage(err)}`);
    } finally {
      report(
        `Dreaming: ${dreaming.enabled ? "enabled" : "disabled"} (cadence ${dreaming.frequency}).`,
      );
    }
  }
}

export async function maybeRepairMemoryRecallHealth(params: {
  cfg: OpenClawConfig;
  prompter: DoctorPrompter;
}): Promise<void> {
  const scopes = resolveMemoryDoctorAgentScopes(params.cfg);
  const labelAgents = scopes.length > 1;
  for (const scope of scopes) {
    const agentMessage = (message: string) =>
      formatMemoryDoctorAgentMessage(scope.agentId, labelAgents, message);
    const backend = resolveActiveMemoryBackendConfig({ cfg: params.cfg, agentId: scope.agentId });
    if (backend?.backend === "provider-runtime") {
      note(
        agentMessage(
          `Not applicable: ${backend.providerId} uses the provider runtime; see its health.`,
        ),
        "Memory search",
      );
      continue;
    }
    await maybeRepairWorkspaceMemoryHealth({
      ...params,
      scope: {
        agentId: scope.agentId,
        workspaceDir: scope.workspaceDir,
        labelAgent: labelAgents,
      },
    });
    try {
      const workspaceDir = await resolveRuntimeMemoryWorkspaceDir(params.cfg, scope.agentId);
      if (!workspaceDir) {
        continue;
      }
      const audit = await auditShortTermPromotionArtifacts({ workspaceDir });
      const hasFixableRecallIssue = audit.issues.some((issue) => issue.fixable);
      if (hasFixableRecallIssue) {
        const approved = await params.prompter.confirmRuntimeRepair({
          message: agentMessage(
            "Remove dangling memory recalls, normalize recall artifacts, and remove stale promotion locks?",
          ),
          initialValue: true,
        });
        if (approved) {
          const repair = await repairShortTermPromotionArtifacts({ workspaceDir });
          if (repair.changed) {
            const removedOverflowEntries = repair.removedOverflowEntries ?? 0;
            const details = [
              repair.removedInvalidEntries > 0
                ? `-${repair.removedInvalidEntries} invalid entries`
                : null,
              (repair.removedDanglingEntries ?? 0) > 0
                ? `-${repair.removedDanglingEntries} dangling entries`
                : null,
              removedOverflowEntries > 0 ? `-${removedOverflowEntries} overflow entries` : null,
            ]
              .filter(Boolean)
              .join(", ");
            const lines = [
              "Memory recall artifacts repaired:",
              repair.rewroteStore
                ? `- rewrote recall store${details ? ` (${details})` : ""}`
                : null,
              repair.removedStaleLock ? "- removed stale promotion lock" : null,
              `Verify: ${formatCliCommand("openclaw memory status --deep")}`,
            ].filter(Boolean);
            note(agentMessage(lines.join("\n")), "Doctor changes");
          }
        }
      }

      const dreamingAudit = await auditDreamingArtifacts({ workspaceDir });
      const hasFixableDreamingIssue = dreamingAudit.issues.some((issue) => issue.fixable);
      if (!hasFixableDreamingIssue) {
        continue;
      }
      const approvedDreamingRepair = await params.prompter.confirmRuntimeRepair({
        message: agentMessage(
          "Archive contaminated dreaming artifacts and reset derived dream corpus state?",
        ),
        initialValue: true,
      });
      if (!approvedDreamingRepair) {
        continue;
      }
      const dreamingRepair = await repairDreamingArtifacts({ workspaceDir });
      if (!dreamingRepair.changed) {
        continue;
      }
      const lines = [
        "Dreaming artifacts repaired:",
        dreamingRepair.archivedSessionCorpus ? "- archived session corpus" : null,
        dreamingRepair.archivedSessionIngestion ? "- archived session-ingestion state" : null,
        dreamingRepair.archivedDreamsDiary ? "- archived dream diary" : null,
        dreamingRepair.archiveDir ? `- archive dir: ${dreamingRepair.archiveDir}` : null,
        ...dreamingRepair.warnings.map((warning) => `- warning: ${warning}`),
        `Verify: ${formatCliCommand("openclaw memory status --deep")}`,
      ].filter(Boolean);
      note(agentMessage(lines.join("\n")), "Doctor changes");
    } catch (err) {
      note(
        agentMessage(`Memory artifact repair could not be completed: ${formatErrorMessage(err)}`),
        "Memory search",
      );
    }
  }
}
