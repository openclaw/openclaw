import { GATEWAY_SERVICE_STOP_TIMEOUT_MS } from "../infra/gateway-shutdown-budget.js";
import { hasCommandProcessCleanupError } from "../process/exec-result.js";
import { parseKeyValueOutput } from "./runtime-parse.js";
import { auditGatewayServiceConfig } from "./service-audit.js";
import { withGatewayServiceOperationLock } from "./service-operation-lock.js";
import { reconcileGatewayServiceDefinition } from "./service-reconciliation.js";
import {
  assertServiceDefinitionWritable,
  resolveManagedGatewayServiceCommand,
  type GatewayServiceState,
} from "./service-types.js";
import {
  GatewayServiceAuthorityError,
  getGatewayServiceUpdateNativeCommand,
  withGatewayServiceUpdateAuthority,
} from "./service-update-authority.js";
import { withSystemdDefinitionMutation } from "./systemd-definition-mutation.js";
import { execSystemctlUser, reloadSystemdUserManager } from "./systemd-exec.js";
import { assertNoSystemGatewayOwnership } from "./systemd-scope.js";
import { resolveSystemdServiceName, resolveSystemdUnitPath } from "./systemd-service-files.js";
import { parseSystemdTimeSpanMs } from "./systemd-time-span.js";
import { refreshSystemdUnitPolicy } from "./systemd-unit.js";

/** Read the effective native policy; absence is a diagnostic, not a stop refusal. */
export async function readSystemdGatewayStopTimeout(state: GatewayServiceState) {
  const unit = `${resolveSystemdServiceName(state.env)}.service`;
  const result = await execSystemctlUser(
    state.env,
    ["show", unit, "--no-page", "--property", "LoadState,TimeoutStopUSec"],
    10_000,
  );
  const properties = parseKeyValueOutput(result.stdout, "=");
  const timeout = parseSystemdTimeSpanMs(properties.timeoutstopusec ?? "");
  return result.code === 0 && properties.loadstate === "loaded" && timeout !== undefined
    ? timeout === 0
      ? Infinity
      : timeout
    : undefined;
}

/** Refresh policy without activation: an ordinary install would stop under the old budget. */
export async function prepareSystemdGatewayMaintenance(params: {
  state: GatewayServiceState;
  root: string;
  stopping: boolean;
  assertCurrent: () => void;
  warn: (message: string) => void;
}): Promise<boolean> {
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
      return false;
    }
    const command = resolveManagedGatewayServiceCommand(state.command);
    if (!command) {
      params.warn("The installed definition is unavailable for a managed refresh.");
      return false;
    }
    assertServiceDefinitionWritable(
      state.definitionMutationCapability ?? { kind: "unknown", reason: "inspection-failed" },
    );
    await withGatewayServiceOperationLock(state.env, async (assertNative) =>
      withGatewayServiceUpdateAuthority(
        assertCurrent,
        async () => {
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
                    refreshSystemdUnitPolicy(previous.contents.toString("utf8")),
                    previous.mode,
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
    return true;
  } catch (error) {
    if (hasCommandProcessCleanupError(error) || error instanceof GatewayServiceAuthorityError) {
      inspectEffective = false;
      throw error;
    }
    assertCurrent();
    params.warn(`Gateway service policy refresh skipped: ${String(error)}`);
    return false;
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
