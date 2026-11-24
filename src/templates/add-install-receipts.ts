import { coerceErrorMessage } from "@openclaw/normalization-core";
import { resolveAgentMainSessionKey } from "../config/sessions/main-session.js";
import type {
  TemplateInstallEvent,
  TemplateInstallOutcome,
} from "../shared/template-install-notice.js";
import type {
  StatelessTemplateAddOptions,
  StatelessTemplateAddResult,
} from "./add-stateless-contract.js";

export function createTemplateInstallReceipts(
  agentId: string,
  options: StatelessTemplateAddOptions,
  isRetained: () => boolean,
) {
  let sessionKey: string | undefined;
  const provisional: Extract<TemplateInstallEvent, { kind: "automation-created" }>[] = [];
  return {
    async publish(outcome: TemplateInstallOutcome) {
      if (!options.onSetupEvent) {
        return;
      }
      sessionKey ??= resolveAgentMainSessionKey({
        cfg: options.getCurrentConfig?.() ?? options.config,
        agentId,
      });
      const event = { ...outcome, agentId, sessionKey };
      // Gateway Add has transferred rollback custody. A transactional caller
      // can still remove its jobs: don't hand out their IDs until settlement.
      if (event.kind === "automation-created" && !isRetained()) {
        provisional.push(event);
      } else {
        await options.onSetupEvent(event);
      }
    },
    async settle(outcome: StatelessTemplateAddResult): Promise<StatelessTemplateAddResult> {
      let publicationError: string | undefined;
      for (const event of provisional) {
        try {
          options.assertCurrent?.();
          const kept =
            outcome.status === "complete" ||
            outcome.error?.code === "cron_scratch_import_incomplete" ||
            (outcome.configCommitted &&
              (await options.cronGateway?.get?.(event.schedulerJobId).catch(() => undefined))
                ?.id === event.schedulerJobId);
          options.assertCurrent?.();
          await options.onSetupEvent?.(
            kept
              ? event
              : {
                  kind: "automation-failed",
                  declarationId: event.declarationId,
                  name: event.name,
                  agentId,
                  sessionKey: event.sessionKey,
                },
          );
        } catch (error) {
          // Publication cannot undo a committed installation or interrupt cleanup.
          publicationError ??= coerceErrorMessage(error);
        }
      }
      return publicationError && !outcome.error
        ? {
            ...outcome,
            status: "partial",
            error: { code: "automation_receipt_failed", message: publicationError },
          }
        : outcome;
    },
  };
}
