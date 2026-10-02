import { isDeepStrictEqual } from "node:util";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { listAgentEntries } from "../../agents/agent-scope.js";
import { createGatewayClawPackageRemovalState } from "../../claws/gateway-package-removal-state.js";
import { readClawStatusRecordsForGateway } from "../../claws/gateway-status-worker.js";
import type { ClawRemovePlanAction } from "../../claws/lifecycle-remove-contract.js";
import { resolveClawMonitorCleanupBinding } from "../../claws/monitor-cleanup-binding.js";
import { clawPackageRemovalRequestSchema } from "../../claws/package-remove-contract.js";
import {
  digestClawPackageRemovalPlan,
  orderClawPackageRemovals,
  projectClawPackageRemovePlan,
} from "../../claws/package-remove-plan.js";
import { applyClawPackageRemovals, planClawPackageRemovals } from "../../claws/package-remove.js";
import { projectPluginRuntimeFailure } from "../../plugins/lifecycle.js";
import { uninstallPluginWithPolicy } from "../../plugins/management-uninstall.js";
import { withPluginLifecycleLease } from "../../plugins/plugin-lifecycle-lease.js";
import {
  captureGatewayPluginRuntimeApplications,
  pluginLifecycleError,
} from "./plugins-lifecycle-error.js";
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
  reviewedPackageActions?: readonly ClawRemovePlanAction[];
};

export const clawsPackageHandlers = {
  "claws.packages.remove": async ({
    params,
    respond,
    context,
    signal,
    sessionMutationCommitGuard,
    reviewedPackageActions,
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
    let captured: ReturnType<typeof captureGatewayPluginRuntimeApplications> | undefined;
    let entered = false;
    try {
      const applyRuntime = context.applyPluginLifecycleChange;
      if (!applyRuntime) {
        throw new Error("Claw plugin cleanup requires a running plugin lifecycle owner.");
      }
      const assertCurrent = () => {
        signal?.throwIfAborted();
        sessionMutationCommitGuard?.();
        if (
          !isDeepStrictEqual(
            input.binding,
            resolveClawMonitorCleanupBinding(context.cronStorePath),
          ) ||
          listAgentEntries(context.getRuntimeConfig()).some((agent) => agent.id === input.agentId)
        ) {
          throw new Error("Claw package cleanup no longer owns the current removal state.");
        }
      };
      const state = createGatewayClawPackageRemovalState({
        agentId: input.agentId,
        operationId: input.operationId,
        expectedInstallDigest: input.expectedInstallDigest,
        assertCurrent,
      });
      const deps = {
        ...state.deps,
        uninstallPlugin: async (
          uninstallParams: Parameters<typeof uninstallPluginWithPolicy>[0],
        ) => {
          await state.assertOwner();
          return await uninstallPluginWithPolicy(uninstallParams);
        },
      };
      captured = captureGatewayPluginRuntimeApplications(applyRuntime, state.assertCurrent);
      const applyOwnedRuntime = captured.applyRuntime;
      // A request must not wait on a config reload that is draining that request.
      const { runtimeFailure, ...removed } = await withPluginLifecycleLease(
        { signal, waitMs: 0 },
        async (lease) => {
          entered = true;
          const beforePersistentApply = () => {
            state.assertCurrent();
            lease.assertOwned();
          };
          beforePersistentApply();
          await state.assertOwner();
          const { records, assertCurrent: assertStatusCurrent } =
            await readClawStatusRecordsForGateway({
              config: context.getRuntimeConfig(),
              target: input.agentId,
              exactAgentId: true,
            });
          beforePersistentApply();
          assertStatusCurrent();
          const record = records[0];
          if (!record || records.length !== 1) {
            throw new Error("Claw package cleanup has no unique current owner.");
          }
          const decisions = await planClawPackageRemovals(record.install, record.packages, {
            referencedCleanup: input.cleanup,
            deps,
          });
          beforePersistentApply();
          await state.assertOwner();
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
          // Match the CLI plan's JSON wire form, which omits undefined action fields.
          // oxlint-disable-next-line unicorn/prefer-structured-clone
          const currentPackageActions = JSON.parse(
            JSON.stringify(projection.actions),
          ) as ClawRemovePlanAction[]; // SAFETY: JSON round-trip preserves typed action fields.
          if (
            reviewedPackageActions &&
            !isDeepStrictEqual(currentPackageActions, reviewedPackageActions)
          ) {
            throw new Error("Claw package actions changed after review; preview removal again.");
          }
          return await applyClawPackageRemovals(orderClawPackageRemovals(decisions), {
            applyRuntime: applyOwnedRuntime,
            assertCurrent: beforePersistentApply,
            deps,
          });
        },
      );
      assertCurrent();
      await state.assertOwner();
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
      respond(
        false,
        undefined,
        pluginLifecycleError(error, { application: captured?.application, entered, signal }),
      );
    }
  },
} satisfies GatewayRequestHandlers;
