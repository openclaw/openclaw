import { isDeepStrictEqual } from "node:util";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { listAgentEntries } from "../../agents/agent-scope.js";
import { readClawStatus } from "../../claws/lifecycle-status.js";
import { resolveClawMonitorCleanupBinding } from "../../claws/monitor-cleanup-binding.js";
import { clawPackageRemovalRequestSchema } from "../../claws/package-remove-contract.js";
import {
  digestClawPackageRemovalPlan,
  digestClawRemovalInstall,
  orderClawPackageRemovals,
  projectClawPackageRemovePlan,
} from "../../claws/package-remove-plan.js";
import { applyClawPackageRemovals, planClawPackageRemovals } from "../../claws/package-remove.js";
import { readClawInstallRecord } from "../../claws/provenance.js";
import {
  capturePluginRuntimeApplications,
  projectPluginRuntimeFailure,
} from "../../plugins/lifecycle.js";
import { withPluginLifecycleLease } from "../../plugins/plugin-lifecycle-lease.js";
import { readAgentDeletionJournal } from "../../state/agent-deletion-journal.js";
import { pluginLifecycleError } from "./plugins-lifecycle-error.js";
import type {
  GatewayRequestContext,
  GatewayRequestHandlerOptions,
  GatewayRequestHandlers,
} from "./types.js";

type PackageRemovalRequestOptions = Pick<
  GatewayRequestHandlerOptions,
  "params" | "respond" | "signal" | "sessionMutationCommitGuard"
> & {
  context: Pick<
    GatewayRequestContext,
    "cronStorePath" | "applyPluginLifecycleChange" | "getRuntimeConfig"
  >;
};

export const clawsPackageHandlers = {
  "claws.packages.remove": async ({
    params,
    respond,
    context,
    signal,
    sessionMutationCommitGuard,
  }: PackageRemovalRequestOptions) => {
    const parsed = clawPackageRemovalRequestSchema.safeParse(params);
    if (!parsed.success) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "Invalid Claw package cleanup parameters."),
      );
      return;
    }
    const input = parsed.data;
    let captured: ReturnType<typeof capturePluginRuntimeApplications> | undefined;
    try {
      const applyRuntime = context.applyPluginLifecycleChange;
      if (!applyRuntime) {
        throw new Error("Claw plugin cleanup requires a running plugin lifecycle owner.");
      }
      const assertCurrent = () => {
        signal?.throwIfAborted();
        sessionMutationCommitGuard?.();
        const journal = readAgentDeletionJournal(input.agentId);
        if (
          !isDeepStrictEqual(
            input.binding,
            resolveClawMonitorCleanupBinding(context.cronStorePath),
          ) ||
          journal?.operationId !== input.operationId ||
          journal.cleanupCompleted ||
          listAgentEntries(context.getRuntimeConfig()).some(
            (agent) => agent.id === input.agentId,
          ) ||
          digestClawRemovalInstall(readClawInstallRecord(input.agentId)) !==
            input.expectedInstallDigest
        ) {
          throw new Error("Claw package cleanup no longer owns the current removal state.");
        }
      };
      assertCurrent();
      captured = capturePluginRuntimeApplications((change) => {
        assertCurrent();
        return applyRuntime({
          ...change,
          assertInvokerOwned: () => {
            assertCurrent();
            change.assertInvokerOwned?.();
          },
        });
      });
      const applyOwnedRuntime = captured.applyRuntime;
      const { runtimeFailure, ...removed } = await withPluginLifecycleLease(
        { signal },
        async (lease) => {
          const beforePersistentApply = () => {
            assertCurrent();
            lease.assertOwned();
          };
          beforePersistentApply();
          const status = await readClawStatus(input.agentId);
          beforePersistentApply();
          const record = status.records[0];
          if (!record || status.records.length !== 1) {
            throw new Error("Claw package cleanup has no unique current owner.");
          }
          const decisions = await planClawPackageRemovals(record.install, record.packages, {
            referencedCleanup: input.cleanup,
          });
          beforePersistentApply();
          if (
            digestClawPackageRemovalPlan(decisions, input.cleanup) !==
            input.expectedPackagePlanDigest
          ) {
            throw new Error(
              "Claw package ownership changed after removal planning; preview removal again.",
            );
          }
          const projection = projectClawPackageRemovePlan({
            decisions,
            inspections: record.packages,
            cleanup: input.cleanup,
          });
          if (projection.blockers.length > 0) {
            throw new Error(projection.blockers.map((blocker) => blocker.message).join("; "));
          }
          return await applyClawPackageRemovals(orderClawPackageRemovals(decisions), {
            applyRuntime: applyOwnedRuntime,
            assertCurrent: beforePersistentApply,
          });
        },
      );
      assertCurrent();
      const { warnings: runtimeWarnings, ...currentApplication } = captured.application ?? {};
      let application = captured.application ? currentApplication : undefined;
      if (runtimeFailure) {
        const runtime = projectPluginRuntimeFailure(runtimeFailure, captured.application).runtime;
        application = runtime?.committed
          ? {
              operationId: runtime.operationId,
              generation: runtime.generation,
              pluginIds: runtime.pluginIds,
            }
          : undefined;
      }
      const warnings = [...new Set([...(removed.warnings ?? []), ...(runtimeWarnings ?? [])])];
      respond(
        true,
        {
          ...removed,
          ...(application ? { application } : {}),
          ...(warnings.length ? { warnings } : {}),
        },
        undefined,
      );
    } catch (error) {
      respond(false, undefined, pluginLifecycleError(error, captured?.application));
    }
  },
} satisfies GatewayRequestHandlers;
