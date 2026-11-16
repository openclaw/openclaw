import { randomUUID } from "node:crypto";
import type {
  MigrationsMemoryApplyResult,
  MigrationsMemoryPlanResult,
} from "../../packages/gateway-protocol/src/index.js";
import { terminalText } from "../../packages/terminal-core/src/safe-text.js";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { runWithLocalStateOwner } from "../cli/local-state-owner.js";
import { createMigrationLogger } from "../commands/migrate/context.js";
import {
  applyProviderMemoryImport,
  withMemoryMigrationProviders,
  planProviderMemoryImport,
} from "../commands/migrate/memory-import.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { MigrationApplyResult, MigrationProviderPlugin } from "../plugins/types.js";
import type { RuntimeEnv } from "../runtime.js";
import { t } from "./i18n/index.js";
import { WizardCancelledError, WizardNavigationError, type WizardPrompter } from "./prompts.js";

type MemoryImportOffer = {
  provider: Pick<MigrationProviderPlugin, "id" | "label">;
  target?: string;
  apply: () => Promise<Pick<MigrationApplyResult, "summary" | "target">>;
  retryable?: boolean;
  source: string;
  plannedIds: string[];
  conflicts: number;
};

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
  const retry = async () =>
    (await params.prompter.select({
      message: t("wizard.memoryImport.recovery"),
      options: [
        { value: "retry", label: t("wizard.memoryImport.retry") },
        { value: "skip", label: t("common.skip") },
      ],
      initialValue: "retry",
    })) === "retry";
  const present = async (
    offers: MemoryImportOffer[],
    signal?: AbortSignal,
  ): Promise<SetupMemoryImportOutcome> => {
    if (offers.length === 0) {
      return { status: "nothing-to-import", providers: [] };
    }

    const offerLines = offers.map((offer) => {
      const conflictSuffix = offer.conflicts
        ? t("wizard.memoryImport.conflictSuffix", { count: offer.conflicts })
        : "";
      return t("wizard.memoryImport.offerLine", {
        label: terminalText`${offer.provider.label}`,
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
        ? [offers[0]!.provider.id]
        : await params.prompter.multiselect({
            message: t("wizard.memoryImport.selectSources"),
            options: offers.map((offer) => ({
              value: offer.provider.id,
              label: terminalText`${offer.provider.label}`,
              hint: terminalText`${offer.source}`,
            })),
            initialValues: offers.map((offer) => offer.provider.id),
          });
    const selected = new Set(selectedIds);
    const selectedOffers = offers.filter((offer) => selected.has(offer.provider.id));
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
      let result: Pick<MigrationApplyResult, "summary" | "target"> | undefined;
      let pendingOutcome: MemoryImportProviderOutcome | undefined;
      let progress = params.prompter.progress(
        t("wizard.memoryImport.importing", { label: terminalText`${offer.provider.label}` }),
      );
      try {
        while (!result) {
          try {
            signal?.throwIfAborted();
            await params.beforeApply?.();
          } catch (error) {
            progress.stop(
              t("wizard.memoryImport.importFailed", {
                label: terminalText`${offer.provider.label}`,
              }),
            );
            throw error;
          }
          try {
            result = await offer.apply();
          } catch (error) {
            // A dispatched copy can outlive the connection or recovery prompt.
            pendingOutcome = {
              providerId: offer.provider.id,
              label: offer.provider.label,
              failure: formatErrorMessage(error),
              copiesIndeterminate: true,
            };
            signal?.throwIfAborted();
            if (error instanceof WizardCancelledError || error instanceof WizardNavigationError) {
              throw error;
            }
            progress.stop(
              t("wizard.memoryImport.importFailed", {
                label: terminalText`${offer.provider.label}`,
              }),
            );
            await params.prompter.note(
              t("wizard.memoryImport.applyFailed", {
                label: terminalText`${offer.provider.label}`,
                reason: pendingOutcome.failure!,
              }),
              t("wizard.memoryImport.errorTitle"),
            );
            // Only the Gateway can reconcile a replay with its accepted result.
            // Every retry retains the reviewed plan and idempotency key.
            if (!offer.retryable || !(await retry())) {
              break;
            }
            progress = params.prompter.progress(
              t("wizard.memoryImport.importing", { label: terminalText`${offer.provider.label}` }),
            );
          }
        }
      } catch (error) {
        if (pendingOutcome) {
          recordProviderOutcome(pendingOutcome);
        }
        throw error;
      }
      if (!result) {
        recordProviderOutcome(pendingOutcome!);
        failureLines.push(
          t("wizard.memoryImport.failureLine", {
            label: terminalText`${offer.provider.label}`,
            reason: pendingOutcome!.failure!,
          }),
        );
        continue;
      }
      summaryLines.push(
        t("wizard.memoryImport.summaryLine", {
          label: terminalText`${offer.provider.label}`,
          migrated: result.summary.migrated,
          skipped: result.summary.skipped,
          target: terminalText`${result.target ?? offer.target ?? workspace}`,
        }),
      );
      // Conflicts count as incomplete: a selected item was skipped because its
      // target appeared between planning and copying.
      const incomplete = result.summary.errors + result.summary.conflicts;
      const failure =
        incomplete > 0 ? t("wizard.memoryImport.partialFailure", { count: incomplete }) : undefined;
      recordProviderOutcome({
        providerId: offer.provider.id,
        label: offer.provider.label,
        migrated: result.summary.migrated,
        skipped: result.summary.skipped,
        ...(failure !== undefined ? { failure } : {}),
      });
      if (failure !== undefined) {
        failureLines.push(
          t("wizard.memoryImport.failureLine", {
            label: terminalText`${offer.provider.label}`,
            reason: failure,
          }),
        );
        progress.stop(
          t("wizard.memoryImport.importFailed", { label: terminalText`${offer.provider.label}` }),
        );
        await params.prompter.note(failure, t("wizard.memoryImport.errorTitle"));
      } else {
        progress.stop(
          t("wizard.memoryImport.imported", { label: terminalText`${offer.provider.label}` }),
        );
      }
    }

    await params.prompter.note(
      [...summaryLines, ...failureLines].join("\n"),
      t("wizard.memoryImport.summaryTitle"),
    );
    return { status: "completed", providers: providerOutcomes };
  };
  return await runWithLocalStateOwner({
    method: "migrations.memory.plan",
    params: { agentId, overwrite: false },
    target: "onboarding memory import",
    timeoutMs: 30_000,
    onForeignOwner: async ({ requestOwner, signal }) => {
      while (true) {
        let planned: MigrationsMemoryPlanResult;
        try {
          planned = await requestOwner<MigrationsMemoryPlanResult>("migrations.memory.plan", {
            agentId,
            overwrite: false,
          });
        } catch (error) {
          signal.throwIfAborted();
          if (error instanceof WizardCancelledError || error instanceof WizardNavigationError) {
            throw error;
          }
          await params.prompter.note(
            formatErrorMessage(error),
            t("wizard.memoryImport.errorTitle"),
          );
          if (await retry()) {
            continue;
          }
          await showSkipHint(params.prompter);
          return { status: "skipped", providers: [] };
        }
        const errors = planned.providers
          .filter((provider) => provider.error)
          .map((provider) => `${provider.label}: ${provider.error}`);
        if (errors.length > 0) {
          await params.prompter.note(errors.join("\n"), t("wizard.memoryImport.errorTitle"));
        }
        const offers: MemoryImportOffer[] = [];
        for (const provider of planned.providers) {
          const plannedIds = provider.items
            .filter((item) => item.status === "planned")
            .map((item) => item.id);
          if (!provider.found || plannedIds.length === 0 || !provider.planFingerprint) {
            continue;
          }
          const applyParams = {
            agentId,
            providerId: provider.providerId,
            itemIds: plannedIds,
            planFingerprint: provider.planFingerprint,
            overwrite: false,
            idempotencyKey: randomUUID(),
          };
          offers.push({
            provider: { id: provider.providerId, label: provider.label },
            source: provider.source ?? "",
            target: provider.target ?? planned.workspace,
            plannedIds,
            conflicts: provider.summary.conflicts,
            retryable: true,
            apply: () =>
              requestOwner<MigrationsMemoryApplyResult>("migrations.memory.apply", applyParams),
          });
        }
        if (offers.length === 0 && errors.length > 0) {
          if (await retry()) {
            continue;
          }
          await showSkipHint(params.prompter);
          return { status: "skipped", providers: [] };
        }
        return await present(offers, signal);
      }
    },
    runLocal: async () =>
      await withMemoryMigrationProviders(
        params.config,
        async (providers) => {
          if (providers.length === 0) {
            return { status: "nothing-to-import", providers: [] };
          }

          const logger = createMigrationLogger(params.runtime);
          const offers: MemoryImportOffer[] = [];
          for (const provider of providers) {
            try {
              // Omit the runtime: provider plan/apply writers would print raw JSON
              // between the wizard prompts; this page renders its own notes.
              const { detection, plan } = await planProviderMemoryImport({
                provider,
                config: params.config,
                agentId,
                overwrite: false,
              });
              const plannedIds = plan.items
                .filter((item) => item.status === "planned")
                .map((item) => item.id);
              if (detection?.found === false || plannedIds.length === 0) {
                continue;
              }
              offers.push({
                provider,
                target: plan.target,
                apply: () =>
                  applyProviderMemoryImport({
                    provider,
                    config: params.config,
                    agentId,
                    itemIds: plannedIds,
                    overwrite: false,
                    preflightPlan: plan,
                  }),
                source: detection?.source ?? plan.source,
                plannedIds,
                conflicts: plan.items.filter((item) => item.status === "conflict").length,
              });
            } catch (error) {
              // Discovery is advisory; one broken source must not block onboarding.
              logger.debug?.(
                `Memory migration provider ${provider.id} planning failed: ${formatErrorMessage(error)}`,
              );
            }
          }
          return await present(offers);
        },
        (error) => {
          params.runtime.error(
            `Memory import result retained, but plugin cleanup failed: ${formatErrorMessage(error)}`,
          );
        },
      ),
  });
}
