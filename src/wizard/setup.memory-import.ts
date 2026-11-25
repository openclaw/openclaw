import { terminalText } from "../../packages/terminal-core/src/safe-text.js";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import {
  withMemoryMigrationOffers,
  type MemoryMigrationOffer,
} from "../commands/migrate/memory-import.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { RuntimeEnv } from "../runtime.js";
import { t } from "./i18n/index.js";
import type { WizardPrompter } from "./prompts.js";

type MemoryImportProviderOutcomeBase = {
  providerId: string;
  label: string;
};

export type MemoryImportProviderOutcome =
  | (MemoryImportProviderOutcomeBase & {
      migrated: number;
      skipped: number;
      failure?: string;
      copiesIndeterminate?: false;
    })
  | (MemoryImportProviderOutcomeBase & {
      failure: string;
      copiesIndeterminate: true;
    });

export type SetupMemoryImportOutcome = {
  status: "completed" | "nothing-to-import" | "skipped";
  providers: MemoryImportProviderOutcome[];
};

// No CLI hint here: `openclaw migrate <id>` runs the FULL provider migration
// (config/credentials/skills), not a memory-only retry. The Control UI Memory
// import page is the only equivalent memory-scoped surface.
async function showSkipHint(prompter: WizardPrompter): Promise<void> {
  await prompter.note(t("wizard.memoryImport.skipHint"), t("wizard.memoryImport.title"));
}

export async function runSetupMemoryImportStep(params: {
  config: OpenClawConfig;
  agentId?: string;
  prompter: WizardPrompter;
  runtime: RuntimeEnv;
  /** Recheck host authority at the copy boundary; onboarding intentionally omits this hook. */
  beforeApply?: () => Promise<void>;
  /** Observe completed provider attempts without changing onboarding behavior. */
  onProviderOutcome?: (outcome: MemoryImportProviderOutcome) => void;
}): Promise<SetupMemoryImportOutcome> {
  const agentId = params.agentId ?? resolveDefaultAgentId(params.config);
  return await withMemoryMigrationOffers(
    { config: params.config, agentId, runtime: params.runtime },
    async (offers, discoveryFailed) => {
      if (offers.length === 0) {
        if (discoveryFailed) {
          // The owner's error is transport detail; the actionable step is the import page.
          await params.prompter.note(
            t("wizard.memoryImport.skipHint"),
            t("wizard.memoryImport.errorTitle"),
          );
        }
        return { status: "nothing-to-import", providers: [] };
      }

      const offerLines = offers.map((offer) => {
        const conflictSuffix = offer.conflicts
          ? t("wizard.memoryImport.conflictSuffix", { count: offer.conflicts })
          : "";
        return t("wizard.memoryImport.offerLine", {
          label: terminalText`${offer.label}`,
          source: terminalText`${offer.source}`,
          count: offer.plannedIds.length,
          conflictSuffix,
        });
      });
      await params.prompter.note(offerLines.join("\n"), t("wizard.memoryImport.title"));

      const confirmed = await params.prompter.confirm({
        message: t("wizard.memoryImport.confirm"),
        initialValue: true,
      });
      if (!confirmed) {
        await showSkipHint(params.prompter);
        return { status: "skipped", providers: [] };
      }

      const selectedIds =
        offers.length === 1
          ? [offers[0]!.providerId]
          : await params.prompter.multiselect({
              message: t("wizard.memoryImport.selectSources"),
              options: offers.map((offer) => ({
                value: offer.providerId,
                label: terminalText`${offer.label}`,
                hint: terminalText`${offer.source}`,
              })),
              initialValues: offers.map((offer) => offer.providerId),
            });
      const selected = new Set(selectedIds);
      const selectedOffers = offers.filter((offer) => selected.has(offer.providerId));
      if (selectedOffers.length === 0) {
        await showSkipHint(params.prompter);
        return { status: "skipped", providers: [] };
      }

      params.prompter.disableBackNavigation?.();
      const workspace = resolveAgentWorkspaceDir(params.config, agentId);
      const summaryLines: string[] = [];
      const failureLines: string[] = [];
      const providerOutcomes: MemoryImportProviderOutcome[] = [];
      const recordProviderOutcome = (outcome: MemoryImportProviderOutcome) => {
        providerOutcomes.push(outcome);
        params.onProviderOutcome?.(outcome);
      };
      for (const offer of selectedOffers) {
        const progress = params.prompter.progress(
          t("wizard.memoryImport.importing", { label: terminalText`${offer.label}` }),
        );
        const reportFailure = async (reason: string) => {
          failureLines.push(
            t("wizard.memoryImport.failureLine", {
              label: terminalText`${offer.label}`,
              reason,
            }),
          );
          progress.stop(
            t("wizard.memoryImport.importFailed", { label: terminalText`${offer.label}` }),
          );
          await params.prompter.note(
            t("wizard.memoryImport.applyFailed", {
              label: terminalText`${offer.label}`,
              reason,
            }),
            t("wizard.memoryImport.errorTitle"),
          );
        };
        // Host authority and config-drift guards run before the apply attempt and
        // must stop the hosted wizard rather than masquerade as copy failures.
        try {
          await params.beforeApply?.();
        } catch (error) {
          progress.stop(
            t("wizard.memoryImport.importFailed", { label: terminalText`${offer.label}` }),
          );
          throw error;
        }
        let result: Awaited<ReturnType<MemoryMigrationOffer["apply"]>>;
        try {
          result = await offer.apply();
        } catch (error) {
          const reason = formatErrorMessage(error);
          recordProviderOutcome({
            providerId: offer.providerId,
            label: offer.label,
            failure: reason,
            copiesIndeterminate: true,
          });
          // Preserve the onboarding notes: only the structured outcome distinguishes
          // an apply throw whose partial copy count cannot be recovered.
          summaryLines.push(
            t("wizard.memoryImport.summaryLine", {
              label: terminalText`${offer.label}`,
              migrated: 0,
              skipped: 0,
              target: terminalText`${offer.target ?? workspace}`,
            }),
          );
          await reportFailure(reason);
          continue;
        }
        summaryLines.push(
          t("wizard.memoryImport.summaryLine", {
            label: terminalText`${offer.label}`,
            migrated: result.summary.migrated,
            skipped: result.summary.skipped,
            target: terminalText`${result.target ?? offer.target ?? workspace}`,
          }),
        );
        // Conflicts count as incomplete: a selected item was skipped because its
        // target appeared between planning and copying.
        const incomplete = result.summary.errors + result.summary.conflicts;
        const failure =
          incomplete > 0
            ? t("wizard.memoryImport.partialFailure", { count: incomplete })
            : undefined;
        recordProviderOutcome({
          providerId: offer.providerId,
          label: offer.label,
          migrated: result.summary.migrated,
          skipped: result.summary.skipped,
          ...(failure !== undefined ? { failure } : {}),
        });
        if (failure !== undefined) {
          await reportFailure(failure);
        } else {
          progress.stop(t("wizard.memoryImport.imported", { label: terminalText`${offer.label}` }));
        }
      }

      await params.prompter.note(
        [...summaryLines, ...failureLines].join("\n"),
        t("wizard.memoryImport.summaryTitle"),
      );
      return { status: "completed", providers: providerOutcomes };
    },
    (error) => {
      params.runtime.error(
        `Memory import result retained, but plugin cleanup failed: ${formatErrorMessage(error)}`,
      );
    },
  );
}
