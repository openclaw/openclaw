import { GATEWAY_SERVICE_STOP_TIMEOUT_MS } from "../infra/gateway-shutdown-budget.js";
import { hasCommandProcessCleanupError } from "../process/exec-result.js";
import { auditGatewayServiceConfig } from "./service-audit.js";
import { withGatewayServiceOperationLock } from "./service-operation-lock.js";
import { reconcileGatewayServiceDefinition } from "./service-reconciliation.js";
import { resolveManagedGatewayServiceCommand, type GatewayServiceState } from "./service-types.js";
import {
  GatewayServiceAuthorityError,
  getGatewayServiceUpdateNativeCommand,
  withGatewayServiceUpdateAuthority,
} from "./service-update-authority.js";
import { withSystemdDefinitionMutation } from "./systemd-definition-mutation.js";
import { reloadSystemdUserManager } from "./systemd-exec.js";
import { assertNoSystemGatewayOwnership } from "./systemd-scope.js";
import { resolveSystemdUnitPath } from "./systemd-service-files.js";
import { readSystemdGatewayStopTimeout } from "./systemd-stop-policy.js";
import { preserveSystemdUnitPolicy, refreshSystemdUnitPolicy } from "./systemd-unit.js";

type SystemdGatewayMaintenanceResult =
  | { kind: "unchanged" }
  | { kind: "refreshed" }
  | { kind: "failed" };

/** Refresh policy without activation: an ordinary install would stop under the old budget. */
export async function prepareSystemdGatewayMaintenance(params: {
  state: GatewayServiceState;
  root: string;
  stopping: boolean;
  assertCurrent: () => void;
  warn: (message: string) => void;
}): Promise<SystemdGatewayMaintenanceResult> {
  const { state, assertCurrent } = params;
  let inspectEffective = true;
  try {
    assertCurrent();
    const timeout = params.stopping ? await readSystemdGatewayStopTimeout(state) : Infinity;
    assertCurrent();
    const audit = await auditGatewayServiceConfig({ env: state.env, command: state.command });
    assertCurrent();
    const outdated = audit.definitionDrift?.some((fact) => fact.kind === "outdated");
    if (!outdated && (timeout ?? 0) >= GATEWAY_SERVICE_STOP_TIMEOUT_MS) {
      return { kind: "unchanged" };
    }
    const command = resolveManagedGatewayServiceCommand(state.command);
    if (!command) {
      params.warn("The installed definition is unavailable for a managed refresh.");
      return { kind: "failed" };
    }
    // The mutation owner checks live system ownership and artifacts. A capability
    // captured before an operator removed a system unit must not veto that check.
    await withGatewayServiceOperationLock(state.env, async (assertNative) =>
      withGatewayServiceUpdateAuthority(
        assertCurrent,
        async () => {
          // Refuse a live system owner before backup/recovery acquires user-unit custody.
          await assertNoSystemGatewayOwnership(state.env);
          assertCurrent();
          await reconcileGatewayServiceDefinition({
            env: state.env,
            root: params.root,
            command: state.command,
            expectedCommand: command,
            warn: params.warn,
            install: async (definitionTransaction) => {
              await withSystemdDefinitionMutation(
                state.env,
                command.environment ?? state.env,
                async (mutation) => {
                  const unitPath = resolveSystemdUnitPath(state.env);
                  const previous = mutation.snapshots.get(unitPath);
                  if (!previous) {
                    throw new Error("The managed unit disappeared before its policy refresh.");
                  }
                  await assertNoSystemGatewayOwnership(state.env);
                  await mutation.publish(
                    unitPath,
                    preserveSystemdUnitPolicy(
                      refreshSystemdUnitPolicy(previous.contents.toString("utf8")),
                      previous.contents.toString("utf8"),
                      definitionTransaction.preservePolicy,
                    ),
                    previous.requiresRegeneration ? 0o600 : previous.mode,
                  );
                  await definitionTransaction.beforeWrite();
                  await assertNoSystemGatewayOwnership(state.env);
                  await reloadSystemdUserManager(
                    state.env,
                    undefined,
                    definitionTransaction.assertCurrent,
                  );
                  await definitionTransaction.beforeWrite();
                },
                { definitionTransaction },
              );
            },
          });
        },
        {
          updateOwned: false,
          assertRecoveryCurrent: assertNative,
          nativeCommand: getGatewayServiceUpdateNativeCommand(),
        },
      ),
    );
    return { kind: "refreshed" };
  } catch (error) {
    if (hasCommandProcessCleanupError(error) || error instanceof GatewayServiceAuthorityError) {
      inspectEffective = false;
      throw error;
    }
    assertCurrent();
    params.warn(`Gateway service policy refresh skipped: ${String(error)}`);
    return { kind: "failed" };
  } finally {
    // No-stop updates still need manager facts: a drop-in can override the repaired base.
    if (!params.stopping && inspectEffective) {
      assertCurrent();
      try {
        const effective = await readSystemdGatewayStopTimeout(state);
        assertCurrent();
        if ((effective ?? 0) < GATEWAY_SERVICE_STOP_TIMEOUT_MS) {
          params.warn(
            `Gateway effective service stop timeout is ${effective === undefined ? "unverified" : `${effective}ms`}; ${GATEWAY_SERVICE_STOP_TIMEOUT_MS / 1_000}s or longer is required. Preserving operator overrides; the Gateway was not stopped.`,
          );
        }
      } catch (error) {
        assertCurrent();
        params.warn(
          `Gateway effective service stop timeout could not be verified: ${String(error)}`,
        );
      }
    }
  }
}
