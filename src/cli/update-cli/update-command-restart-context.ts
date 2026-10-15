import type { ConfigFileSnapshot } from "../../config/types.openclaw.js";
import { ServiceStartRefusalError } from "../../daemon/service-inspection-error.js";
import { resolveManagedGatewayServiceProcessEnv } from "../../daemon/service-types.js";
import { resolveGatewayService } from "../../daemon/service.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { formatCliCommand } from "../command-format.js";
import { isPackageManagerUpdateMode } from "./update-command-service-command.js";
import type { UpdateRestartParams } from "./update-command-service-context-types.js";
import {
  resolveServiceRefreshEnv,
  stripGatewayServiceMarkerEnv,
} from "./update-command-service-env.js";
import {
  GatewayServiceUpdateOwnershipError,
  isGatewayServiceManagementAllowedForUpdate,
  readGatewayServiceStateForUpdate,
  resolveGatewayServiceManagementBlockMessageForUpdate,
  resolveUpdatedGatewayRestartPort,
} from "./update-command-service-plan.js";
import { revalidateManagedGatewayServiceAfterUpdate } from "./update-command-service-revalidation.js";

export async function prepareUpdateRestart(
  params: UpdateRestartParams & { assertCurrent: () => void },
  restartConfigSnapshot: ConfigFileSnapshot,
) {
  let refreshGatewayServiceEnv = false;
  let gatewayServiceEnv: NodeJS.ProcessEnv | undefined;
  let gatewayServiceInstallEnv: NodeJS.ProcessEnv | null | undefined;
  let serviceManagerUid = params.preManagedServiceStop?.serviceManagerUid;
  let serviceUpdateVerdict = params.preManagedServiceStop?.serviceUpdateVerdict;
  let skipLegacyServiceRestart = serviceUpdateVerdict?.kind === "absent";
  const packageUpdate = isPackageManagerUpdateMode(params.result.mode);
  const serviceStateReadEnv = resolveServiceRefreshEnv(
    params.result.mode === "git" || packageUpdate
      ? (params.preManagedServiceStop?.serviceEnv ?? process.env)
      : process.env,
    params.invocationCwd,
  );
  let serviceMutationAllowed =
    params.preManagedServiceStop?.serviceMutationAllowed !== false &&
    isGatewayServiceManagementAllowedForUpdate(process.env) &&
    isGatewayServiceManagementAllowedForUpdate(serviceStateReadEnv);
  let serviceMutationSkipMessage = !serviceMutationAllowed
    ? (params.preManagedServiceStop?.serviceMutationSkipMessage ??
      resolveGatewayServiceManagementBlockMessageForUpdate(process.env) ??
      resolveGatewayServiceManagementBlockMessageForUpdate(serviceStateReadEnv))
    : undefined;
  let serviceStartRefused = false;
  let gatewayPort = await resolveUpdatedGatewayRestartPort({
    config: restartConfigSnapshot.valid ? restartConfigSnapshot.config : undefined,
    processEnv: process.env,
    serviceEnv: params.ownedManagedUpdateEnv,
  });
  if (params.shouldRestart && serviceMutationAllowed && !skipLegacyServiceRestart) {
    try {
      const serviceState = await readGatewayServiceStateForUpdate(
        resolveGatewayService(),
        serviceStateReadEnv,
        params.updateStepTimeoutMs,
        { managerUid: serviceManagerUid, assertCurrent: params.assertCurrent },
      );
      serviceUpdateVerdict = await revalidateManagedGatewayServiceAfterUpdate({
        state: serviceState,
        root: params.result.root ?? params.root,
        preManagedServiceStop: params.preManagedServiceStop,
        allowInstallRootChange: true,
      });
      gatewayServiceEnv = serviceState.env;
      serviceManagerUid ??= serviceState.runtime?.systemd?.managerUid;
      const useInstalledState =
        (serviceUpdateVerdict.kind === "owned" &&
          serviceUpdateVerdict.requiresInstallRootRefresh) ||
        packageUpdate ||
        (params.result.mode === "git" && params.preManagedServiceStop?.stopped);
      skipLegacyServiceRestart =
        serviceUpdateVerdict.kind === "foreign" || serviceUpdateVerdict.kind === "absent";
      if (serviceUpdateVerdict.kind === "unavailable") {
        serviceMutationAllowed = false;
        serviceMutationSkipMessage = serviceUpdateVerdict.message;
      } else if (serviceUpdateVerdict.kind === "foreign") {
        serviceMutationAllowed = false;
        serviceMutationSkipMessage =
          "Gateway service management skipped: the service belongs to a different OpenClaw installation and was left untouched.";
      } else if (
        !skipLegacyServiceRestart &&
        (useInstalledState
          ? serviceState.installed
          : serviceState.loadState.status === "loaded" &&
            (params.result.mode !== "git" || serviceUpdateVerdict.kind === "owned"))
      ) {
        gatewayServiceInstallEnv = resolveManagedGatewayServiceProcessEnv(
          serviceState.command,
          params.ownedManagedUpdateEnv ?? process.env,
        );
        if (gatewayServiceInstallEnv) {
          gatewayServiceInstallEnv = stripGatewayServiceMarkerEnv(gatewayServiceInstallEnv);
        }
        refreshGatewayServiceEnv =
          serviceUpdateVerdict.kind === "owned" && serviceUpdateVerdict.refreshDefinition;
        if (serviceUpdateVerdict.kind === "owned" && gatewayServiceInstallEnv === null) {
          refreshGatewayServiceEnv = false;
          serviceUpdateVerdict = { ...serviceUpdateVerdict, refreshDefinition: false };
        }
      }
      gatewayPort = await resolveUpdatedGatewayRestartPort({
        config: restartConfigSnapshot.valid ? restartConfigSnapshot.config : undefined,
        serviceEnv: gatewayServiceEnv,
        serviceCommand:
          serviceUpdateVerdict.kind === "unresolved" ||
          (serviceUpdateVerdict.kind === "owned" &&
            (!serviceUpdateVerdict.refreshDefinition ||
              (serviceUpdateVerdict.requiresInstallRootRefresh &&
                restartConfigSnapshot.config.gateway?.port === undefined)))
            ? serviceState.command
            : undefined,
      });
    } catch (err) {
      const refusal =
        err instanceof ServiceStartRefusalError
          ? err.refusal
          : err instanceof GatewayServiceUpdateOwnershipError &&
              err.cause instanceof ServiceStartRefusalError
            ? err.cause.refusal
            : undefined;
      if (refusal) {
        params.assertCurrent();
        serviceStartRefused = true;
        gatewayServiceEnv = serviceStateReadEnv;
        serviceMutationAllowed = false;
        serviceMutationSkipMessage = `SERVICE-DEFINITION: ${refusal.message} The updated installation is kept; after resolving the service hold, run \`${formatCliCommand("openclaw gateway start", serviceStateReadEnv)}\`. Gateway readiness remains unverified.`;
      } else if (params.preManagedServiceStop?.stopped) {
        const message =
          err instanceof GatewayServiceUpdateOwnershipError
            ? formatErrorMessage(err)
            : "Stopped gateway service could not be revalidated; inspect it before restarting manually.";
        throw new GatewayServiceUpdateOwnershipError(message, err);
      } else {
        serviceMutationAllowed = false;
        serviceMutationSkipMessage =
          "Code update completed; gateway service management skipped because its current ownership could not be inspected. " +
          "Run `openclaw gateway status --deep` before restarting it manually.";
      }
    }
  }
  if (
    params.serviceRuntimeRefreshRequired &&
    !serviceStartRefused &&
    (!serviceMutationAllowed || !refreshGatewayServiceEnv || gatewayServiceInstallEnv === null)
  ) {
    throw new GatewayServiceUpdateOwnershipError(
      "Replacing the unsupported Gateway Node requires a writable service definition and a reproducible service environment. Ask its deployment owner to refresh the service before retrying.",
      undefined,
    );
  }
  return {
    refreshGatewayServiceEnv,
    gatewayServiceEnv,
    gatewayServiceInstallEnv,
    serviceUpdateVerdict,
    serviceManagerUid,
    skipLegacyServiceRestart,
    serviceMutationAllowed,
    serviceMutationSkipMessage,
    gatewayPort,
  };
}
