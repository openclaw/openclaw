import os from "node:os";
import path from "node:path";
import { resolveStateDir } from "../../config/paths.js";
import {
  findSystemdServiceAccountMismatch,
  type SystemdServiceAccountMismatch,
} from "../../daemon/service-inspection-error.js";
import { gatewayServiceCommandMatchesRoot } from "../../daemon/service-layout.js";
import { findInstalledSystemdGatewayScope } from "../../daemon/systemd-scope.js";
import { readSystemdServiceExecStart } from "../../daemon/systemd-service-files.js";
import { readSystemdAccountHome } from "../../daemon/systemd-state-identity.js";
import type { UpdateAdmissionContext } from "../../infra/update-admission-contract.js";
import { hasCommandProcessCleanupError } from "../../process/exec-result.js";
import { quoteCliArg } from "../quote-cli-arg.js";

const SYSTEM_SERVICE_UPDATE_DOCS =
  "https://docs.openclaw.ai/install/updating#linux-system-service-run-by-another-account";

const INSPECTION_TIMEOUT_MS = 10_000;

/**
 * Shipped drivers back up and validate the state selected by their own environment.
 * When the selected system unit runs this package as another account, that is not the
 * unit's state (plain sudo) or it would be written by the wrong account (explicit state
 * selectors), so admission refuses before the package is replaced. Only a positive
 * observation of the unit's account refuses; an unreadable unit leaves the other checks
 * in charge.
 */
export async function inspectSystemServiceAccountForAdmission(params: {
  env: NodeJS.ProcessEnv;
  root: string;
  packageManager: UpdateAdmissionContext["installation"]["packageManager"];
  candidateVersion: string;
}): Promise<{ message: string; nextAction: string } | undefined> {
  if (process.platform !== "linux") {
    return undefined;
  }
  let mismatch: SystemdServiceAccountMismatch | undefined;
  try {
    const target = await findInstalledSystemdGatewayScope(params.env, {
      timeoutMs: INSPECTION_TIMEOUT_MS,
    });
    if (target?.scope !== "system") {
      return undefined;
    }
    await readSystemdServiceExecStart(params.env, {
      systemdReadTarget: target,
      requireEffective: true,
      timeoutMs: INSPECTION_TIMEOUT_MS,
    });
    return undefined;
  } catch (error) {
    if (hasCommandProcessCleanupError(error)) {
      throw error;
    }
    mismatch = findSystemdServiceAccountMismatch(error);
  }
  if (
    !mismatch ||
    (await gatewayServiceCommandMatchesRoot(params.root, {
      programArguments: mismatch.programArguments,
      workingDirectory: mismatch.workingDirectory,
    })) !== true
  ) {
    return undefined;
  }
  return await formatRefusal(mismatch, params);
}

async function formatRefusal(
  mismatch: SystemdServiceAccountMismatch,
  params: { env: NodeJS.ProcessEnv; packageManager: string; candidateVersion: string },
) {
  const caller = os.userInfo().username;
  const { serviceUser: user, unitName: unit } = mismatch;
  const home = mismatch.selectors.HOME ?? (await readSystemdAccountHome(user));
  const unitEnv = { ...mismatch.selectors, ...(home ? { HOME: home } : {}) };
  const unitState =
    !mismatch.selectorsIncomplete && home ? resolveStateDir(unitEnv, () => home) : undefined;
  const callerState = resolveStateDir(params.env);
  const effect =
    unitState && path.resolve(unitState) === path.resolve(callerState)
      ? `would write that service's state as ${caller}`
      : `would back up and check ${callerState} instead of the service's state`;
  const message = `Gateway service ${unit} runs as ${user}, but this update runs as ${caller} and ${effect}. The package, the service state and the Gateway were not changed.`;
  const selectors = Object.entries(unitEnv).map(([key, value]) => `${key}=${quoteCliArg(value)}`);
  const backup =
    mismatch.selectorsIncomplete || !home
      ? `sudo -u ${quoteCliArg(user)} env <the unit's HOME, OPENCLAW_HOME, OPENCLAW_STATE_DIR, OPENCLAW_CONFIG_PATH and OPENCLAW_PROFILE> openclaw backup create --verify --output <directory>`
      : `sudo -u ${quoteCliArg(user)} env ${selectors.join(" ")} openclaw backup create --verify --output ${quoteCliArg(home)}`;
  const spec = quoteCliArg(`openclaw@${params.candidateVersion}`);
  const install =
    params.packageManager === "pnpm"
      ? `sudo pnpm add -g --allow-build=openclaw ${spec}`
      : params.packageManager === "bun"
        ? `sudo bun add -g --trust ${spec}`
        : `sudo npm install -g ${spec} --allow-scripts=openclaw`;
  const nextAction = `Update this system service by hand (${SYSTEM_SERVICE_UPDATE_DOCS}). First make a verified backup of its state as ${user}: ${backup}. Then run ${install} and sudo systemctl restart ${quoteCliArg(unit)}.`;
  return { message, nextAction };
}
