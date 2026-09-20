import { isDeepStrictEqual } from "node:util";
import { UPDATE_RUN_ID_ENV } from "../infra/update-control-plane-sentinel.js";
import { recordUpdateRunStep } from "../infra/update-run-ledger.js";
import { auditGatewayServiceConfig, type GatewayServiceExpectedCommand } from "./service-audit.js";
import { captureGatewayServiceDefinitionBackup } from "./service-definition-backup.js";
import { gatewayServiceCommandMatchesRoot } from "./service-layout.js";
import { withGatewayServiceOperationLock } from "./service-operation-lock.js";
import { settleGatewayServiceRebind } from "./service-rebind.js";
import type {
  GatewayServiceDefinitionBackupReceipt,
  GatewayServiceDefinitionTransactionHooks,
} from "./service-stage.js";
import type { GatewayServiceCommandConfig, GatewayServiceEnv } from "./service-types.js";
import {
  isUpdateOwnedGatewayServiceCommand,
  readGatewayServiceUpdateOriginalRoot,
} from "./service-update-authority.js";
import { resolveGatewayService } from "./service.js";

/** Update repair shares the ordinary installer, retaining only facts needed for recovery. */
export async function reconcileGatewayServiceDefinition(params: {
  env: GatewayServiceEnv;
  root: string | undefined;
  command: GatewayServiceCommandConfig | null;
  expectedCommand: GatewayServiceExpectedCommand;
  install: (hooks: GatewayServiceDefinitionTransactionHooks) => Promise<void>;
  warn: (message: string) => void;
}): Promise<GatewayServiceDefinitionBackupReceipt> {
  return await withGatewayServiceOperationLock(params.env, async (assertCurrent) => {
    let warningIndex = 0;
    const warn = (message: string) => {
      params.warn(message);
      // Published updaters discard installer stdout; their existing ledger owns warnings too.
      const runId = process.env[UPDATE_RUN_ID_ENV];
      if (runId && !isUpdateOwnedGatewayServiceCommand()) {
        try {
          assertCurrent();
          recordUpdateRunStep(runId, {
            step: `warning:managed-service-reconciliation:${warningIndex++}`,
            status: "completed",
            endedAtMs: Date.now(),
            detail: message,
          });
        } catch {
          params.warn("Could not record the service definition warning in update history.");
        }
      }
    };
    const deny = (message: string): never => {
      warn(message);
      throw new Error(`SERVICE_DEFINITION_UNKNOWN: ${message}`);
    };
    const command = params.command;
    if (!command) {
      return deny("Gateway service definition could not be inspected; it was left unchanged.");
    }
    let keys: string[] = [];
    const transaction = await captureGatewayServiceDefinitionBackup({
      env: params.env,
      command,
      assertCurrent,
      inspect: async () => {
        const current = await resolveGatewayService().readCommand(params.env, {
          requireEffective: true,
        });
        assertCurrent();
        if (!isDeepStrictEqual(current, command)) {
          throw new Error("Gateway service definition changed during inspection.");
        }
        const roots = [params.root, readGatewayServiceUpdateOriginalRoot()].filter(
          (root): root is string => Boolean(root),
        );
        const ownership = await Promise.all(
          roots.map((root) => gatewayServiceCommandMatchesRoot(root, command)),
        );
        assertCurrent();
        if (!ownership.includes(true)) {
          throw new Error("Gateway service belongs to an unknown or foreign installation.");
        }
        const audit = await auditGatewayServiceConfig({
          env: params.env,
          command,
          expectedCommand: params.expectedCommand,
        });
        assertCurrent();
        const edits = audit.definitionDrift?.filter((fact) => fact.kind === "unknown-edit") ?? [];
        if (audit.definitionDriftError || edits.length) {
          throw new Error(
            [audit.definitionDriftError, ...edits.map((fact) => `${fact.key}: ${fact.message}`)]
              .filter(Boolean)
              .join(" "),
          );
        }
        keys = audit.definitionDrift?.map((fact) => fact.key) ?? [];
      },
    }).catch((error: unknown) =>
      deny(
        `Service definition inspection or backup failed; the definition was preserved: ${String(error)}`,
      ),
    );
    return await settleGatewayServiceRebind(assertCurrent, async () => {
      try {
        await params.install(transaction.hooks);
        assertCurrent();
        const receipt = await transaction.finish();
        warn(
          `${keys.length ? `Reconciled Gateway service definition: ${keys.join(", ")}.` : "Refreshed Gateway service definition."} Backup: ${transaction.backupPaths.join(", ")}`,
        );
        return receipt;
      } catch (error) {
        assertCurrent();
        try {
          await transaction.compensate();
        } catch (recoveryError) {
          warn(
            `Service definition refresh failed: ${String(error)}. Recovery could not be verified: ${String(recoveryError)}; backups retained: ${transaction.backupPaths.join(", ")}`,
          );
          throw new Error(
            `UPDATE_NATIVE_AUTHORITY: Service definition recovery is unverified: ${String(recoveryError)}`,
            { cause: recoveryError },
          );
        }
        return deny(
          `Service definition refresh failed; the previous definition was restored: ${String(error)}`,
        );
      }
    });
  });
}
