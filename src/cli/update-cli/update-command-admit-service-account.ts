import os from "node:os";
import path from "node:path";
import { resolveStateDir } from "../../config/paths.js";
import { isBunRuntime, isNodeRuntime } from "../../daemon/runtime-binary.js";
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
import { buildParseArgv } from "../argv.js";
import { applyCliProfileEnv, parseCliProfileArgs } from "../profile.js";
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
      return await formatRefusal(mismatch, params);
    }
  }
  return undefined;
}

async function formatRefusal(
  mismatch: SystemdServiceAccountMismatch,
  params: { env: NodeJS.ProcessEnv; packageManager: string; candidateVersion: string },
) {
  const { username: caller, uid } = os.userInfo();
  const { serviceUser, unitName: unit } = mismatch;
  // systemd's User= may be empty (root) or a numeric UID; sudo needs "#<uid>" for the latter.
  const numeric = /^\d+$/u.test(serviceUser);
  const user = serviceUser === "" ? "root" : numeric ? `UID ${serviceUser}` : serviceUser;
  const sudoUser =
    serviceUser === "" ? "root" : numeric ? `'#${serviceUser}'` : quoteCliArg(serviceUser);
  const home = mismatch.selectors.HOME ?? (await readSystemdAccountHome(serviceUser));
  const unitEnv: NodeJS.ProcessEnv = { ...mismatch.selectors, ...(home ? { HOME: home } : {}) };
  // A --profile in ExecStart selects the state as discovery does for readable units.
  const executable = mismatch.programArguments[0] ?? "";
  const runtime = isNodeRuntime(executable) || isBunRuntime(executable);
  const profile = parseCliProfileArgs(
    buildParseArgv(mismatch.programArguments, runtime ? "openclaw" : executable),
  );
  if (profile.ok && profile.profile && home) {
    applyCliProfileEnv({ profile: profile.profile, env: unitEnv, homedir: () => home });
  }
  const selectorsIncomplete = mismatch.selectorsIncomplete || !profile.ok;
  const unitState = !selectorsIncomplete && home ? resolveStateDir(unitEnv, () => home) : undefined;
  const callerState = resolveStateDir(params.env);
  const sameState =
    unitState !== undefined && path.resolve(unitState) === path.resolve(callerState);
  const effect = sameState
    ? `would write that service's state as ${caller}`
    : `would back up and check ${caller}'s own state instead of the service's`;
  const message = `Gateway service ${unit} runs as ${user}, but this update runs as ${caller} and ${effect}.`;
  // Shipped drivers print this text with their own state path rewritten to
  // "$OPENCLAW_STATE_DIR", which a shell would expand to nothing. Quoting the last
  // component keeps the same path out of that rewrite.
  const shellPath = (value: string) => {
    const at = value.indexOf(callerState);
    if (at < 0) {
      return quoteCliArg(value);
    }
    const cut = value.lastIndexOf("/", at + callerState.length - 1) + 1;
    return `${quoteCliArg(value.slice(0, cut))}'${value.slice(cut).replaceAll("'", "'\\''")}'`;
  };
  const selectors = Object.entries(unitEnv).flatMap(([key, value]) =>
    value === undefined ? [] : [`${key}=${shellPath(value)}`],
  );
  const backup =
    selectorsIncomplete || !home
      ? `sudo -u ${sudoUser} env <the unit's HOME, OPENCLAW_HOME, OPENCLAW_STATE_DIR, OPENCLAW_CONFIG_PATH and OPENCLAW_PROFILE> openclaw backup create --verify --output <directory>`
      : `sudo -u ${sudoUser} env ${selectors.join(" ")} openclaw backup create --verify --output ${shellPath(home)}`;
  const spec = quoteCliArg(`openclaw@${params.candidateVersion}`);
  // The package stays with the account that ran this update, and its global directory.
  const owner = uid === 0 ? "sudo " : "";
  const install =
    params.packageManager === "pnpm"
      ? `${owner}pnpm add -g --allow-build=openclaw ${spec}`
      : params.packageManager === "bun"
        ? `${owner}bun add -g --trust ${spec}`
        : `${owner}npm install -g ${spec} --allow-scripts=openclaw`;
  // Shipped drivers still write their log, report and diagnostics into the selected state as
  // this account; the service account's backup refuses directories it cannot read.
  const chownTo = serviceUser === "" ? "root" : quoteCliArg(serviceUser);
  const unchanged = sameState
    ? `The package and the running Gateway were not changed, but this run writes its log and report into that state as ${caller}; give them back to ${user} first: sudo find ${shellPath(callerState)} -xdev -user ${uid} -exec chown ${chownTo} {} +.`
    : "Nothing was changed: the package, the service state and the running Gateway are as they were.";
  // Shipped drivers keep at most 200 characters of the reason; the next action is shown whole.
  const nextAction = `${unchanged} Update this system service by hand (${SYSTEM_SERVICE_UPDATE_DOCS}). First make a verified backup of its state as ${user}: ${backup}. Then run ${install} and sudo systemctl restart ${quoteCliArg(unit)}.`;
  return { message, nextAction };
}
