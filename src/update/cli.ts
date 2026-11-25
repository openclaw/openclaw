// `openclaw update`, after the update command's refusals: a client of the
// running Gateway's `update.run`, or the same steps in-process when no Gateway answers.
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { UpdateRunParams } from "../../packages/gateway-protocol/src/index.js";
import { GATEWAY_SERVER_CAPS } from "../../packages/gateway-protocol/src/server-capabilities.js";
import { formatCliCommand } from "../cli/command-format.js";
import {
  assertGlobalUpdateOwner,
  requestUpdateDowngradeConfirmation,
} from "../cli/update-cli/shared.js";
import { mutateConfigFileWithRetry } from "../config/mutate.js";
import {
  callGateway,
  isGatewayCredentialsRequiredError,
  isGatewayTransportError,
  isImplicitLocalGatewayTarget,
} from "../gateway/call.js";
import { GatewayClientRequestError } from "../gateway/client.js";
import { formatErrorMessage } from "../infra/errors.js";
import { compareSemverStrings } from "../infra/npm-registry-spec.js";
import { resolveOpenClawPackageRoot } from "../infra/openclaw-root.js";
import { resolveEffectiveUpdateChannel, type UpdateChannel } from "../infra/update-channels.js";
import { resolveStartupInstallStatus } from "../infra/update-install-status.js";
import { getUpdateRunAsync } from "../infra/update-run-reader.js";
import type { UpdateRunRecord } from "../infra/update-run-record.js";
import { createUpdateRunAsync } from "../infra/update-run-write.async.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { defaultRuntime } from "../runtime.js";
import { releaseOpenClawStateDatabaseCustody } from "../state/openclaw-state-db-cache.js";
import { VERSION } from "../version.js";
import {
  checkUpdateInstallationSlot,
  resolveInstalledPackageFrontend,
  resolveUpdateInstallationIdentity,
  UnverifiedForegroundUpdateOwnerError,
} from "./installation-identity.js";
import { TRIAL_BUDGET_MS } from "./launcher.js";
import { PREPARE_DEADLINE_MS, markForwarding, prepareUpdate } from "./run.js";
import { readTrial, resolvePrefix } from "./store.js";
import { resolveTarget } from "./target.js";

const POLL_MS = 2_000;
/** Earlier updaters' runtime cleanup is advisory: no new deletion starts after this. */
const RETAINED_RUNTIME_BUDGET_MS = 2 * 60_000;
/** Below this `--timeout`, cleanup could take more than a tenth of the update's budget. */
const RETAINED_RUNTIME_MIN_TIMEOUT_MS = 10 * RETAINED_RUNTIME_BUDGET_MS;
/** Prepare, plus a trial that includes the boot migration. */
const RUN_DEADLINE_MS = PREPARE_DEADLINE_MS + 30 * 60_000;

export type ReleaseUpdateOptions = {
  json: boolean;
  restart: boolean;
  /** The installation the update command admitted. */
  runningRoot: string;
  /** Requested with --channel; persisted before the update. */
  channel?: UpdateChannel;
  /** The saved `update.channel`, used when nothing was requested. */
  storedChannel?: UpdateChannel;
  sha?: string;
  /** Explicit package target; the current RPC has no package-target field. */
  tag?: string;
  /** `--timeout`: one overall budget for preparing and following the run. */
  timeoutMs?: number;
  /** `--accept-capabilities`, including plugin maintenance through the running Gateway. */
  acceptCapabilities?: boolean;
  yes?: boolean;
};

/** Prepare for an admitted managed action; its native owner still activates the release. */
export async function tryAdoptInstalledPackageForGateway(opts: {
  json: boolean;
  action: "start" | "restart";
}): Promise<string | false | undefined> {
  const pending = await readTrial();
  if (pending?.phase === "pending") {
    return pending.runId;
  }
  const runningRoot = await resolveOpenClawPackageRoot({ moduleUrl: import.meta.url });
  if (!runningRoot) {
    return undefined;
  }
  const delegated = await delegateInstalledPackageUpdate(
    { json: opts.json, runningRoot, restart: false },
    opts.action,
  );
  if (!delegated) {
    return undefined;
  }
  if (process.exitCode !== 0) {
    return false;
  }
  const prepared = await readTrial();
  return prepared?.phase === "pending" ? prepared.runId : undefined;
}

/** Preparation serializes one trial; its launcher-owned outcome is observed without opening state. */
export async function waitForReleaseUpdateFailure(): Promise<string | undefined> {
  let deadline = Date.now() + TRIAL_BUDGET_MS;
  for (;;) {
    const trial = await readTrial();
    if (!trial) {
      return "The update trial is no longer available. Run `openclaw update status` to see the result.";
    }
    if (trial.phase === "committed") {
      return undefined;
    }
    if (trial.phase === "rolled-back") {
      return `Update failed: ${trial.outcome?.reason ?? "new build failed to start"}`;
    }
    if (trial.phase !== "pending" && trial.createdAt > 0) {
      deadline = Math.min(deadline, trial.createdAt + TRIAL_BUDGET_MS);
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return "The update did not finish in time. Run `openclaw update status` to see it.";
    }
    await sleep(Math.min(POLL_MS, remaining));
  }
}

async function delegateInstalledPackageUpdate(
  opts: ReleaseUpdateOptions,
  action?: "start" | "restart",
): Promise<boolean> {
  const frontend = await resolveInstalledPackageFrontend(opts.runningRoot);
  if (!frontend) {
    return false;
  }
  const prefix = resolvePrefix();
  const launcher = path.join(prefix, "openclaw-launcher.mjs");
  await assertGlobalUpdateOwner({
    root: opts.runningRoot,
    installKind: "package",
    timeoutMs: opts.timeoutMs ?? 10_000,
  });
  const order = compareSemverStrings(frontend.version, frontend.selectedVersion);
  const sameBuild =
    order === 0 && Boolean(frontend.buildId) && frontend.buildId === frontend.selectedBuildId;
  const installedTarget =
    !opts.tag &&
    !opts.channel &&
    !opts.sha &&
    (order === 1 || (order === 0 && !sameBuild && !action));
  const notice = (message: string) =>
    opts.json ? defaultRuntime.error(message) : defaultRuntime.log(message);
  if (order === -1) {
    notice(
      `The managed Gateway is newer than this npm package. It was not downgraded. To use ${frontend.version}, run: ${formatCliCommand(`openclaw update --tag ${frontend.version}`)}`,
    );
  }
  if (sameBuild || order === -1) {
    await markForwarding(opts.runningRoot, launcher, prefix).catch((error: unknown) =>
      notice(
        `The npm entry could not be attached to the resident launcher: ${formatErrorMessage(error)}. It remains a separate CLI.`,
      ),
    );
  }
  if (action && !installedTarget) {
    if (!sameBuild && order !== -1) {
      notice(
        `CLI and active release have different or unknown builds. Run: ${formatCliCommand("openclaw update")}`,
      );
    }
    return false;
  }
  if (installedTarget) {
    notice(
      action
        ? `Applying the npm-installed OpenClaw ${frontend.version} before starting the Gateway.`
        : `Applying the npm-installed OpenClaw ${frontend.version}. The selected Gateway release is ${frontend.selectedVersion} while checks run.`,
    );
  }
  // Profile/state selection already ran. The resident owns VERSION, before and trial.previous.
  const argv = [
    process.execPath,
    launcher,
    "update",
    ...(installedTarget
      ? ["--tag", `file:${path.resolve(opts.runningRoot)}`]
      : opts.tag
        ? ["--tag", opts.tag]
        : []),
    ...(opts.channel ? ["--channel", opts.channel] : []),
    ...(opts.sha ? ["--sha", opts.sha] : []),
    ...(opts.json ? ["--json"] : []),
    ...(!opts.restart ? ["--no-restart"] : []),
    ...(opts.yes ? ["--yes"] : []),
    ...(opts.acceptCapabilities ? ["--accept-capabilities"] : []),
    ...(opts.timeoutMs ? ["--timeout", String(Math.ceil(opts.timeoutMs / 1000))] : []),
  ];
  const preparationJson = Boolean(action && opts.json);
  await releaseOpenClawStateDatabaseCustody();
  const result = await runCommandWithTimeout(argv, {
    timeoutMs: opts.timeoutMs ?? RUN_DEADLINE_MS,
    stdinFileDescriptor: process.stdin.fd,
    outputCapture: preparationJson ? { stdout: "head", stderr: "discard" } : "discard",
    onOutputChunk: (chunk, stream) => {
      process[preparationJson ? "stderr" : stream].write(chunk);
    },
    killProcessTree: true,
  });
  process.exitCode = result.code ?? 1;
  if (preparationJson && process.exitCode !== 0) {
    process.stdout.write(result.stdout);
  }
  return true;
}

export async function runReleaseUpdateCli(opts: ReleaseUpdateOptions): Promise<void> {
  const startedAt = Date.now();
  if (await delegateInstalledPackageUpdate(opts)) {
    return;
  }
  try {
    await checkUpdateInstallationSlot(opts.runningRoot);
  } catch (error) {
    if (!(error instanceof UnverifiedForegroundUpdateOwnerError) || !opts.restart || opts.tag) {
      throw error;
    }
    // A local update.run can identify its own argv; preparation rechecks under its lock.
  }
  const { channel } = opts;
  let timeoutMs = opts.timeoutMs;
  if (!opts.yes) {
    const { status } = await resolveStartupInstallStatus(false, new AbortController().signal);
    if (status.installKind === "package") {
      const selected = await resolveTarget({
        kind: "package",
        channel: resolveEffectiveUpdateChannel({
          configChannel: channel ?? opts.storedChannel,
          currentVersion: VERSION,
          installKind: "package",
        }).channel,
        tag: opts.tag,
        timeoutMs: opts.timeoutMs,
      });
      if ((compareSemverStrings(VERSION, selected.version) ?? 0) > 0) {
        const decision = await requestUpdateDowngradeConfirmation({
          json: opts.json,
          currentVersion: VERSION,
          targetVersion: selected.version,
          tag: opts.tag ?? selected.version,
        });
        if (decision !== "confirmed") {
          const reason = decision === "cancelled" ? "cancelled" : "downgrade-confirmation-required";
          if (opts.json) {
            defaultRuntime.writeJson({ status: "skipped", reason });
          } else if (decision === "cancelled") {
            defaultRuntime.log("Update cancelled.");
          } else {
            defaultRuntime.error(
              "Downgrade confirmation required.\nDowngrading can break configuration. Re-run in a TTY to confirm.",
            );
          }
          process.exitCode = decision === "cancelled" ? 0 : 1;
          return;
        }
      }
      if (timeoutMs !== undefined) {
        timeoutMs = Math.max(1, timeoutMs - (Date.now() - startedAt));
      }
    }
  }
  if (channel) {
    await mutateConfigFileWithRetry({
      base: "source",
      afterWrite: { mode: "auto" },
      mutate: (next) => {
        next.update = { ...next.update, channel };
      },
    });
  }
  // The protocol names the tracked upstream with the commit; the install status already reads it.
  const upstreamRef = opts.sha
    ? (await resolveStartupInstallStatus(false, new AbortController().signal)).status.git?.upstream
    : undefined;
  if (opts.sha && !upstreamRef) {
    throw new Error(
      "--sha needs a checkout that tracks an upstream branch (git branch --set-upstream-to).",
    );
  }
  const target =
    opts.sha && upstreamRef
      ? { kind: "git" as const, upstreamRef, upstreamSha: opts.sha }
      : undefined;
  // Like the releases prepareUpdate collects, an earlier updater's leftover is removed before
  // this update starts; afterwards the release launcher would count as a possible holder.
  // A census cannot be interrupted (Windows allows it 15 s), so a short --timeout skips cleanup.
  if (timeoutMs === undefined || timeoutMs >= RETAINED_RUNTIME_MIN_TIMEOUT_MS) {
    for (const line of await reclaimRetainedUpdateRuntimes(opts.runningRoot)) {
      // The cleanup owner already logs each runtime it keeps.
      if (line.startsWith("Runtime retained at ")) {
        continue;
      }
      if (opts.json) {
        defaultRuntime.error(line);
      } else {
        defaultRuntime.log(line);
      }
    }
  }
  if (opts.timeoutMs !== undefined) {
    timeoutMs = Math.max(1, opts.timeoutMs - (Date.now() - startedAt));
  }
  // Explicit package targets stay local: update.run cannot carry them without a protocol change.
  // --no-restart prepares in this process; the release starts at the Gateway's next start.
  const request =
    opts.restart && !opts.tag ? await requestGatewayUpdate(target, { ...opts, timeoutMs }) : null;
  let record = request
    ? await followRun(
        request.runId,
        opts.json,
        Math.max(0, (opts.timeoutMs ?? RUN_DEADLINE_MS) - (Date.now() - startedAt)),
      )
    : await updateWithoutGateway({ ...opts, timeoutMs });
  if (
    request &&
    !request.supportsConsent &&
    opts.acceptCapabilities &&
    (record?.status === "succeeded" || record?.status === "skipped")
  ) {
    // Shipped Gateways reject unknown fields. Update once with the old request, then
    // apply consent through the now-new Gateway's existing already-current/plugin path.
    const retry = await requestGatewayUpdate(target, { ...opts, timeoutMs }, record);
    record = retry
      ? await followRun(
          retry.runId,
          opts.json,
          Math.max(0, (opts.timeoutMs ?? RUN_DEADLINE_MS) - (Date.now() - startedAt)),
        )
      : record;
  }
  if (
    opts.tag &&
    opts.restart &&
    isPendingActivation(record) &&
    (await requestLocalGatewayRestart(
      Math.max(1, (opts.timeoutMs ?? RUN_DEADLINE_MS) - (Date.now() - startedAt)),
    )) &&
    record
  ) {
    const releaseAdmission = opts.json ? record.origin.releaseAdmission : undefined;
    record = await followRun(
      record.runId,
      opts.json,
      Math.max(0, (opts.timeoutMs ?? RUN_DEADLINE_MS) - (Date.now() - startedAt)),
    );
    // The local preparer recorded admission; the Gateway follow-up carries only wire fields.
    if (record && releaseAdmission) {
      record = { ...record, origin: { ...record.origin, releaseAdmission } };
    }
  }
  report(record, opts.json);
  process.exitCode =
    record?.status === "succeeded" || record?.status === "skipped" || isPendingActivation(record)
      ? 0
      : 1;
}

/**
 * Removes the runtime an earlier in-place updater retained (shipped updaters promise that the
 * next update does). Doctor's owner decides custody from the runtime's owner record and the
 * process census. It runs in this command, not the Gateway: the census is synchronous, and
 * without an owner record it cannot tell the requesting `openclaw update` from an old updater.
 */
async function reclaimRetainedUpdateRuntimes(runningRoot: string): Promise<string[]> {
  const deadline = Date.now() + RETAINED_RUNTIME_BUDGET_MS;
  try {
    const { prepareRetainedUpdateRuntimeMaintenance } =
      await import("../commands/doctor-retained-runtime.js");
    // This command's temp directories and the system one; Doctor also reads the service's.
    const maintain = await prepareRetainedUpdateRuntimeMaintenance(process.env, {
      inspectService: false,
      packageRoots: [runningRoot],
    });
    // Doctor also fences its own process's workers; this command never loads code from
    // another updater's runtime.
    return await maintain(true, {
      assertCurrent: () => {
        if (Date.now() >= deadline) {
          throw new Error("cleanup ran out of time; the next update retries");
        }
      },
    });
  } catch (error) {
    return [`Could not inspect retained updater runtimes: ${formatErrorMessage(error)}`];
  }
}

async function requestLocalGatewayRestart(timeoutMs = 30_000): Promise<boolean> {
  if (!(await isImplicitLocalGatewayTarget({}))) {
    return false;
  }
  try {
    const response = await callGateway<{ ok: boolean }>({
      method: "gateway.restart.request",
      params: { reason: "update.run" },
      timeoutMs: Math.min(30_000, timeoutMs),
      prepareDispatchCurrent: releaseOpenClawStateDatabaseCustody,
    });
    if (!response.ok) {
      throw new Error("The Gateway refused to restart into the prepared release.");
    }
    return true;
  } catch (error) {
    if (isGatewayTransportError(error) || isGatewayCredentialsRequiredError(error)) {
      return false;
    }
    throw error;
  }
}

async function requestGatewayUpdate(
  target: { kind: "git"; upstreamRef: string; upstreamSha: string } | undefined,
  opts: ReleaseUpdateOptions,
  consentRetry?: UpdateRunRecord,
): Promise<{ runId: string; supportsConsent: boolean } | null> {
  // Only the local Gateway serves this checkout; a remote or overridden target would update
  // another installation, so this checkout prepares its release here instead.
  if (!(await isImplicitLocalGatewayTarget({}))) {
    if (consentRetry) {
      throw new Error(
        `Capability consent was not applied because the updated Gateway is no longer local. ${consentRetry.origin.nextAction ?? "Run `openclaw update --accept-capabilities` against that installation to retry."}`,
      );
    }
    return null;
  }
  const checkout = await resolveUpdateInstallationIdentity(opts.runningRoot);
  const params: UpdateRunParams = {
    ...(target ? { target } : {}),
    ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
  };
  let supportsConsent = false;
  try {
    const response = await callGateway<{
      runId: string | null;
      ok: boolean;
      code?: string;
      message?: string;
    }>({
      method: "update.run",
      params,
      onHelloOk: (hello) => {
        supportsConsent =
          hello.features.capabilities?.includes(GATEWAY_SERVER_CAPS.UPDATE_RUN_CONSENT_IDENTITY) ??
          false;
        if (supportsConsent) {
          params.checkout = checkout;
          params.acceptCapabilities = opts.acceptCapabilities;
        }
      },
      prepareDispatchCurrent: releaseOpenClawStateDatabaseCustody,
      assertDispatchCurrent: () => {
        if (consentRetry && !supportsConsent) {
          throw new Error(
            `Capability consent was not applied because the updated Gateway does not support it. ${consentRetry.origin.nextAction ?? "Run `openclaw update --accept-capabilities` to retry."}`,
          );
        }
      },
      timeoutMs: 30_000,
    });
    if (!response.runId) {
      // update.run reads the saved channel, so --channel was written before the Gateway refused.
      const savedChannel =
        response.code === "installation-mismatch" && opts.channel
          ? ` Only the requested update channel was saved: update.channel is now "${opts.channel}" for this state directory. Run \`openclaw config set update.channel <previous channel>\` to restore it.`
          : "";
      throw new Error(`${response.message ?? "The Gateway refused the update."}${savedChannel}`);
    }
    return { runId: response.runId, supportsConsent };
  } catch (error) {
    if (
      !consentRetry &&
      (isGatewayTransportError(error) || isGatewayCredentialsRequiredError(error))
    ) {
      return null;
    }
    throw error;
  }
}

/** The Gateway restarts during a run; until the deadline, its unavailability is expected. */
async function followRun(
  runId: string,
  json: boolean,
  budgetMs: number,
): Promise<UpdateRunRecord | undefined> {
  const deadline = Date.now() + budgetMs;
  let lastLine = "";
  let record: UpdateRunRecord | undefined;
  while (Date.now() < deadline) {
    try {
      record =
        (
          await callGateway<{ run: UpdateRunRecord | null }>({
            method: "update.runs.get",
            params: { runId },
            timeoutMs: 10_000,
          })
        ).run ?? undefined;
    } catch (error) {
      // A draining or starting Gateway refuses with a retryable UNAVAILABLE error, not a closed socket.
      const restarting =
        isGatewayTransportError(error) ||
        (error instanceof GatewayClientRequestError &&
          error.retryable &&
          error.gatewayCode === "UNAVAILABLE");
      if (!restarting) {
        throw error;
      }
    }
    if (record) {
      const step = record.steps.at(-1)?.step ?? record.phase;
      const line = `${record.phase}: ${step}`;
      if (!json && line !== lastLine) {
        defaultRuntime.log(line);
        lastLine = line;
      }
      if (record.status !== "running") {
        return record;
      }
    }
    await sleep(POLL_MS);
  }
  return record;
}

async function updateWithoutGateway(
  opts: ReleaseUpdateOptions,
): Promise<UpdateRunRecord | undefined> {
  const run = await createUpdateRunAsync({ trigger: "cli", before: { version: VERSION } });
  // The checkout's tag and branch facts, as the Gateway route passes: a stable tag stays stable.
  const { status } = await resolveStartupInstallStatus(false, new AbortController().signal);
  const channel = resolveEffectiveUpdateChannel({
    configChannel: opts.channel ?? opts.storedChannel,
    currentVersion: VERSION,
    installKind: status.installKind,
    git: status.git,
  }).channel;
  const outcome = await prepareUpdate({
    runId: run.runId,
    runningRoot: opts.runningRoot,
    runningVersion: VERSION,
    channel,
    sha: opts.sha,
    tag: opts.tag,
    timeoutMs: opts.timeoutMs,
    acceptCapabilities: opts.acceptCapabilities,
  });
  if (opts.tag && opts.restart && outcome.status === "current" && outcome.pluginsChanged) {
    await requestLocalGatewayRestart();
  }
  if (outcome.status === "pending" && !opts.json) {
    defaultRuntime.log(
      `OpenClaw ${outcome.target.version} is ready and starts the next time the Gateway starts.`,
    );
  }
  return await getUpdateRunAsync(run.runId);
}

/** Prepared and published; the Gateway's next start activates it. */
function isPendingActivation(record: UpdateRunRecord | undefined) {
  return record?.status === "running" && record.phase === "activating";
}

function updateFailure(record: UpdateRunRecord | undefined): string | undefined {
  if (!record || record.status === "running") {
    return "The update did not finish in time. Run `openclaw update status` to see it.";
  }
  if (record.status === "succeeded" || record.status === "skipped") {
    return undefined;
  }
  const detail = record.steps.find(({ step }) => step === "outcome")?.detail;
  const message = record.origin.nextAction ?? record.reason ?? "unknown reason";
  return `Update failed: ${detail ? `${detail}\n${message}` : message}`;
}

function report(record: UpdateRunRecord | undefined, json: boolean) {
  if (json) {
    defaultRuntime.writeJson(record ?? { status: "unknown" });
    return;
  }
  // The CLI stopped following before the run finished (its --timeout budget); the run goes on.
  if (!record || (record.status === "running" && !isPendingActivation(record))) {
    defaultRuntime.error(updateFailure(record));
    return;
  }
  const plugins = record.steps.find(({ step }) => step === "plugins");
  if (plugins?.status === "failed") {
    defaultRuntime.error(`Plugins were not all updated: ${plugins.detail ?? "unknown reason"}`);
  } else if (plugins?.detail) {
    defaultRuntime.log(`Plugin notes: ${plugins.detail}`);
  }
  const forwarding = record.steps.find(({ step }) => step === "forwarding");
  if (forwarding?.status === "failed") {
    defaultRuntime.error(forwarding.detail);
  }
  if (isPendingActivation(record)) {
    return;
  }
  if (record.status === "succeeded") {
    defaultRuntime.log(`Updated to ${record.after.version ?? "the new version"}.`);
  } else if (record.status === "skipped") {
    defaultRuntime.log(
      record.reason === "already-current" ? "Already up to date." : `Skipped: ${record.reason}`,
    );
  } else {
    defaultRuntime.error(updateFailure(record));
  }
}
