import os from "node:os";
import {
  findSystemdServiceAccountMismatch,
  type SystemdServiceAccountMismatch,
} from "../../daemon/service-inspection-error.js";
import { gatewayServiceCommandMatchesRoot } from "../../daemon/service-layout.js";
import { findInstalledSystemdGatewayScope } from "../../daemon/systemd-scope.js";
import { readSystemdServiceExecStart } from "../../daemon/systemd-service-files.js";
import { hasCommandProcessCleanupError } from "../../process/exec-result.js";

const SYSTEM_SERVICE_UPDATE_DOCS =
  "https://docs.openclaw.ai/install/updating#linux-system-service-run-by-another-account";

const INSPECTION_TIMEOUT_MS = 10_000;

/** Shipped drivers must not check another account's state from their candidate process. */
export async function inspectSystemServiceAccountForAdmission(params: {
  env: NodeJS.ProcessEnv;
  root: string;
}): Promise<{ message: string; nextAction: string } | undefined> {
  const mismatch = await findSystemServiceAccountMismatch(params);
  if (!mismatch) {
    return undefined;
  }
  return {
    message: `Gateway service ${mismatch.unitName} runs as ${mismatch.serviceUser || "root"}, but this update runs as ${os.userInfo().username}; the candidate cannot check that account's state.`,
    nextAction: `This installed updater cannot safely update another account's state. Follow the manual package replacement and ownership-repair instructions at ${SYSTEM_SERVICE_UPDATE_DOCS}.`,
  };
}

/** Match the selected system unit to this installation without opening either account's state. */
export async function findSystemServiceAccountMismatch(params: {
  env: NodeJS.ProcessEnv;
  root: string;
}): Promise<SystemdServiceAccountMismatch | undefined> {
  if (process.platform !== "linux") {
    return undefined;
  }
  // A custom-named unit is skipped by discovery when it runs as another account;
  // discovery reports it so the same observation can refuse here.
  const skipped: SystemdServiceAccountMismatch[] = [];
  const candidates: SystemdServiceAccountMismatch[] = [];
  try {
    const target = await findInstalledSystemdGatewayScope(params.env, {
      timeoutMs: INSPECTION_TIMEOUT_MS,
      onAccountMismatch: (mismatch) => skipped.push(mismatch),
    });
    if (target?.scope === "system") {
      await readSystemdServiceExecStart(params.env, {
        systemdReadTarget: target,
        requireEffective: true,
        timeoutMs: INSPECTION_TIMEOUT_MS,
      });
    } else if (!target) {
      candidates.push(...skipped);
    }
  } catch (error) {
    if (hasCommandProcessCleanupError(error)) {
      throw error;
    }
    const mismatch = findSystemdServiceAccountMismatch(error);
    if (mismatch) {
      candidates.push(mismatch);
    }
  }
  for (const mismatch of candidates) {
    const runsThisInstallation = await gatewayServiceCommandMatchesRoot(params.root, {
      programArguments: mismatch.programArguments,
      workingDirectory: mismatch.workingDirectory,
    });
    if (runsThisInstallation === true) {
      return mismatch;
    }
  }
  return undefined;
}
