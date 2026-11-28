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
import { findRootOwnedRunuser } from "../../daemon/systemd-service-account-command.js";
import {
  readSystemdServiceExecStart,
  readSystemdServiceExecStartAsRoot,
} from "../../daemon/systemd-service-files.js";
import { readSystemdAccount, readSystemdAccountHome } from "../../daemon/systemd-state-identity.js";
import type { UpdateAdmissionContext } from "../../infra/update-admission-contract.js";
import { hasCommandProcessCleanupError } from "../../process/exec-result.js";
import { buildParseArgv } from "../argv.js";
import { applyCliProfileEnv, parseCliProfileArgs } from "../profile.js";
import { quoteCliArg } from "../quote-cli-arg.js";

const SYSTEM_SERVICE_UPDATE_DOCS =
  "https://docs.openclaw.ai/install/updating#linux-system-service-run-by-another-account";

const INSPECTION_TIMEOUT_MS = 10_000;

/** How a root update reaches a system unit that runs this installation as another account. */
export type SystemServiceAccountPlan =
  | {
      kind: "switch";
      unitName: string;
      unitPath: string;
      account: string;
      /** The unit's HOME, where the account keeps its update backup. */
      home: string;
      uid: number;
      gid: number;
      runuser: string;
      /** The unit's effective environment and profile, the only environment its account child gets. */
      env: Record<string, string>;
    }
  | { kind: "refuse"; message: string; nextAction: string };

/**
 * Shipped drivers back up and validate the state selected by their own environment.
 * When the selected system unit runs this package as another account, every state step has
 * to run as that account with the unit's environment. When that is possible the plan says
 * how; otherwise admission refuses before the package is replaced. Only a positive
 * observation of the unit's account changes anything; an unreadable unit leaves the other
 * checks in charge.
 */
export async function inspectSystemServiceAccountForAdmission(params: {
  env: NodeJS.ProcessEnv;
  root: string;
  packageManager: UpdateAdmissionContext["installation"]["packageManager"];
  candidateVersion: string;
}): Promise<SystemServiceAccountPlan | undefined> {
  const mismatch = await findSystemServiceAccountMismatch(params);
  if (!mismatch) {
    return undefined;
  }
  const execution = await resolveServiceAccountExecution(mismatch, params.env);
  if ("blocker" in execution) {
    const refusal = await formatRefusal(mismatch, params);
    return {
      kind: "refuse",
      message: refusal.message,
      nextAction: `Automatic update as the service account is not possible: ${execution.blocker}. ${refusal.nextAction}`,
    };
  }
  return execution;
}

/** The selected system unit runs this installation as another account. */
async function findSystemServiceAccountMismatch(params: {
  env: NodeJS.ProcessEnv;
  root: string;
}): Promise<SystemdServiceAccountMismatch | undefined> {
  if (process.platform !== "linux") {
    return undefined;
  }
  // A custom-named unit is skipped by discovery when it runs as another account;
  // discovery reports it so the same observation can decide here.
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

// systemd's default PATH for system services, used when the unit sets none.
const SYSTEMD_DEFAULT_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/**
 * Root re-derives everything from systemd and NSS; nothing the service account wrote decides
 * which account, unit or environment is used.
 */
async function resolveServiceAccountExecution(
  mismatch: SystemdServiceAccountMismatch,
  env: NodeJS.ProcessEnv,
): Promise<Extract<SystemServiceAccountPlan, { kind: "switch" }> | { blocker: string }> {
  const account = mismatch.serviceUser;
  if (process.geteuid?.() !== 0) {
    return { blocker: "only root can run the service account's steps" };
  }
  if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/u.test(account) || account === "root") {
    return { blocker: `the unit's User= (${account || "empty"}) is not a named service account` };
  }
  const ids = await readSystemdAccount(account);
  if (!ids) {
    return { blocker: `the account ${account} could not be resolved` };
  }
  if (ids.uid === 0) {
    return { blocker: `the account ${account} is root` };
  }
  const runuser = await findRootOwnedRunuser();
  if (!runuser) {
    return { blocker: "no root-owned runuser was found" };
  }
  let command: Awaited<ReturnType<typeof readSystemdServiceExecStartAsRoot>>;
  try {
    command = await readSystemdServiceExecStartAsRoot(
      env,
      { scope: "system", unitName: mismatch.unitName, unitPath: mismatch.unitPath },
      account,
      undefined,
      true,
    );
  } catch (error) {
    if (hasCommandProcessCleanupError(error)) {
      throw error;
    }
    return { blocker: `the unit's effective environment could not be read` };
  }
  const home = command?.environment?.HOME;
  if (!command || !home || command.reloadPending) {
    return { blocker: "the unit's effective environment could not be read" };
  }
  if (command.stateIdentityUnverified) {
    return { blocker: "the unit's sandboxing or environment hides where its state is" };
  }
  const unitEnv: Record<string, string> = {
    PATH: SYSTEMD_DEFAULT_PATH,
    ...command.environment,
    USER: account,
    LOGNAME: account,
  };
  const executable = command.programArguments[0] ?? "";
  const runtime = isNodeRuntime(executable) || isBunRuntime(executable);
  const profile = parseCliProfileArgs(
    buildParseArgv(command.programArguments, runtime ? "openclaw" : executable),
  );
  if (!profile.ok) {
    return { blocker: "the unit's --profile could not be read" };
  }
  if (profile.profile) {
    applyCliProfileEnv({ profile: profile.profile, env: unitEnv, homedir: () => home });
  }
  // An installed updater that selects the unit's state itself writes its snapshot, log and
  // report there as root before any candidate step runs; only plain sudo keeps them out.
  const unitState = path.resolve(resolveStateDir(unitEnv, () => home));
  if (unitState === path.resolve(resolveStateDir(env))) {
    return {
      blocker:
        "this update selects the service's state itself, so the installed updater would write it as root; run the update again without OPENCLAW_STATE_DIR or other state selectors",
    };
  }
  return {
    kind: "switch",
    unitName: mismatch.unitName,
    unitPath: command.sourcePath ?? mismatch.unitPath,
    account,
    home,
    uid: ids.uid,
    gid: ids.gid,
    runuser,
    env: Object.fromEntries(
      Object.entries(unitEnv).flatMap(([key, value]) =>
        typeof value === "string" ? [[key, value]] : [],
      ),
    ),
  };
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
