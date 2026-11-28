// `openclaw update`, after the update command's refusals: a client of the
// running Gateway's `update.run`, or the same steps in-process when no Gateway answers.
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { UpdateRunParams } from "../../packages/gateway-protocol/src/index.js";
import { GATEWAY_SERVER_CAPS } from "../../packages/gateway-protocol/src/server-capabilities.js";
import { formatCliCommand } from "../cli/command-format.js";
import { recordCliGatewayRunFailure } from "../cli/failure-output.js";
import {
  assertGlobalUpdateOwner,
  requestUpdateDowngradeConfirmation,
} from "../cli/update-cli/shared.js";
import { mutateConfigFileWithRetry } from "../config/mutate.js";
import type { CallGatewayOptions } from "../gateway/call-options.js";
import {
  callGateway,
  isGatewayCredentialsRequiredError,
  isGatewayTransportError,
  prepareLocalGatewayRestartConnection,
} from "../gateway/call.js";
import { GatewayClientRequestError } from "../gateway/client.js";
import { isAbortError } from "../infra/abort-signal.js";
import { formatErrorMessage } from "../infra/errors.js";
import { compareSemverStrings } from "../infra/npm-registry-spec.js";
import { resolveOpenClawPackageRoot } from "../infra/openclaw-root.js";
import { resolveEffectiveUpdateChannel, type UpdateChannel } from "../infra/update-channels.js";
import { resolveStartupInstallStatus } from "../infra/update-install-status.js";
import { renderUpdateRunSummary } from "../infra/update-run-notice.js";
import { getUpdateRunAsync } from "../infra/update-run-reader.js";
import type { UpdateRunRecord } from "../infra/update-run-record.js";
import { createUpdateRunAsync } from "../infra/update-run-write.async.js";
import { runCommandWithTimeout } from "../process/exec.js";
import { defaultRuntime } from "../runtime.js";
import { releaseOpenClawStateDatabaseCustody } from "../state/openclaw-state-db-cache.js";
import { scheduleAbsoluteDeadline } from "../utils/absolute-deadline.js";
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
/** Prepare, plus a trial that includes the boot migration. */
const RUN_DEADLINE_MS = PREPARE_DEADLINE_MS + 30 * 60_000;
const UPDATE_TIMEOUT_MESSAGE =
  "The update did not finish in time. Run `openclaw update status` to see it.";

type ReleaseUpdateDeadline = { at: number; expired: Error };

function remainingUpdateBudget(deadline: ReleaseUpdateDeadline): number {
  return Math.max(0, deadline.at - Date.now());
}

function requireUpdateBudget(deadline: ReleaseUpdateDeadline): number {
  const remaining = remainingUpdateBudget(deadline);
  if (remaining === 0) {
    throw deadline.expired;
  }
  return remaining;
}

/** Expiry ends client work; the RPC owner still joins socket and durable-auth cleanup. */
async function callGatewayBeforeDeadline<T>(
  deadline: ReleaseUpdateDeadline,
  request: Omit<CallGatewayOptions, "signal">,
): Promise<T> {
  const remaining = requireUpdateBudget(deadline);
  const controller = new AbortController();
  const cancelDeadline = scheduleAbsoluteDeadline(deadline.at, () =>
    controller.abort(deadline.expired),
  );
  try {
    return await callGateway<T>({
      ...request,
      timeoutMs: Math.min(request.timeoutMs ?? remaining, remaining),
      signal: controller.signal,
      assertDispatchCurrent: () => {
        requireUpdateBudget(deadline);
        request.assertDispatchCurrent?.();
      },
    });
  } catch (error) {
    // A different RPC/auth failure can finish settling after our timer fires.
    if (controller.signal.aborted && isAbortError(error)) {
      throw deadline.expired;
    }
    throw error;
  } finally {
    cancelDeadline();
  }
}

type RestartConnection = NonNullable<
  Awaited<ReturnType<typeof prepareLocalGatewayRestartConnection>>
>;

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
      return UPDATE_TIMEOUT_MESSAGE;
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
  const deadline: ReleaseUpdateDeadline = {
    at: startedAt + (opts.timeoutMs ?? RUN_DEADLINE_MS),
    expired: new Error(UPDATE_TIMEOUT_MESSAGE),
  };
  try {
    await checkUpdateInstallationSlot(opts.runningRoot);
  } catch (error) {
    if (!(error instanceof UnverifiedForegroundUpdateOwnerError) || !opts.restart || opts.tag) {
      throw error;
    }
    // A local update.run can identify its own argv; preparation rechecks under its lock.
  }
  const { channel } = opts;
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
        timeoutMs: opts.timeoutMs === undefined ? undefined : requireUpdateBudget(deadline),
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
    }
  }
  requireUpdateBudget(deadline);
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
  // Explicit package targets stay local: update.run cannot carry them without a protocol change.
  // --no-restart prepares in this process; the release starts at the Gateway's next start.
  let request =
    opts.restart && !opts.tag ? await requestGatewayUpdate(target, opts, deadline) : null;
  let record: UpdateRunRecord | undefined;
  try {
    record = request
      ? await followRun(request.runId, request.connection, opts.json, deadline)
      : await updateWithoutGateway(opts, deadline);
    if (
      request &&
      !request.supportsConsent &&
      opts.acceptCapabilities &&
      (record?.status === "succeeded" || record?.status === "skipped")
    ) {
      // Shipped Gateways reject unknown fields. Update once with the old request, then
      // apply consent through the now-new Gateway's existing already-current/plugin path.
      const retry = await requestGatewayUpdate(target, opts, deadline, record);
      if (retry) {
        // Consent starts another run; failed observation must not report the old ID.
        request = retry;
        record = await followRun(retry.runId, retry.connection, opts.json, deadline);
      }
    }
    if (opts.tag && opts.restart && record && isPendingActivation(record)) {
      const connection = await requestLocalGatewayRestart(deadline).catch((error: unknown) => {
        // Publication already succeeded; its pending trial remains valid for the
        // launcher's next start even when this client's restart budget expires.
        if (error === deadline.expired) {
          return null;
        }
        throw error;
      });
      if (connection) {
        const releaseAdmission = opts.json ? record.origin.releaseAdmission : undefined;
        record = (await followRun(record.runId, connection, opts.json, deadline)) ?? record;
        // The local preparer recorded admission; the Gateway follow-up carries only wire fields.
        if (record && releaseAdmission) {
          record = { ...record, origin: { ...record.origin, releaseAdmission } };
        }
      }
    }
  } catch (error) {
    recordCliGatewayRunFailure(error, request?.runId);
    throw error;
  }
  report(record, opts.json, request?.runId);
  process.exitCode =
    record?.status === "succeeded" || record?.status === "skipped" || isPendingActivation(record)
      ? 0
      : 1;
}

async function requestLocalGatewayRestart(
  deadline: ReleaseUpdateDeadline,
): Promise<RestartConnection | null> {
  requireUpdateBudget(deadline);
  const connection = await prepareLocalGatewayRestartConnection();
  if (!connection) {
    return null;
  }
  try {
    const response = await callGatewayBeforeDeadline<{ ok: boolean }>(deadline, {
      ...connection,
      method: "gateway.restart.request",
      params: { reason: "update.run" },
      timeoutMs: 30_000,
      prepareDispatchCurrent: releaseOpenClawStateDatabaseCustody,
    });
    if (!response.ok) {
      throw new Error("The Gateway refused to restart into the prepared release.");
    }
    return connection;
  } catch (error) {
    if (isGatewayTransportError(error) || isGatewayCredentialsRequiredError(error)) {
      return null;
    }
    throw error;
  }
}

async function requestGatewayUpdate(
  target: { kind: "git"; upstreamRef: string; upstreamSha: string } | undefined,
  opts: ReleaseUpdateOptions,
  deadline: ReleaseUpdateDeadline,
  consentRetry?: UpdateRunRecord,
): Promise<{ runId: string; supportsConsent: boolean; connection: RestartConnection } | null> {
  // The first update may have succeeded; expiry here must still surface unconfirmed consent.
  const requestDeadline = consentRetry
    ? {
        ...deadline,
        expired: new Error(
          `Capability consent could not be confirmed before the update timeout. Run \`openclaw update status\` before retrying. ${consentRetry.origin.nextAction ?? "Run `openclaw update --accept-capabilities` to retry."}`,
        ),
      }
    : deadline;
  requireUpdateBudget(requestDeadline);
  // Only the local Gateway serves this checkout; a remote or overridden target would update
  // another installation, so this checkout prepares its release here instead.
  const connection = await prepareLocalGatewayRestartConnection();
  if (!connection) {
    if (consentRetry) {
      throw new Error(
        `Capability consent was not applied because the updated Gateway is no longer local. ${consentRetry.origin.nextAction ?? "Run `openclaw update --accept-capabilities` against that installation to retry."}`,
      );
    }
    return null;
  }
  const checkout = await resolveUpdateInstallationIdentity(opts.runningRoot);
  const params: UpdateRunParams = target ? { target } : {};
  let supportsConsent = false;
  try {
    const response = await callGatewayBeforeDeadline<{
      runId: string | null;
      ok: boolean;
      code?: string;
      message?: string;
    }>(requestDeadline, {
      ...connection,
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
        if (opts.timeoutMs !== undefined) {
          params.timeoutMs = requireUpdateBudget(requestDeadline);
        }
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
    if (!opts.json) {
      defaultRuntime.log(`Update run: ${response.runId}`);
    }
    return { runId: response.runId, supportsConsent, connection };
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
  connection: RestartConnection,
  json: boolean,
  deadline: ReleaseUpdateDeadline,
): Promise<UpdateRunRecord | undefined> {
  let lastLine = "";
  let record: UpdateRunRecord | undefined;
  while (remainingUpdateBudget(deadline) > 0) {
    try {
      record =
        (
          await callGatewayBeforeDeadline<{ run: UpdateRunRecord | null }>(deadline, {
            ...connection,
            method: "update.runs.get",
            params: { runId },
            timeoutMs: 10_000,
          })
        ).run ?? undefined;
    } catch (error) {
      if (error === deadline.expired) {
        break;
      }
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
    const remaining = remainingUpdateBudget(deadline);
    if (remaining > 0) {
      await sleep(Math.min(POLL_MS, remaining));
    }
  }
  return record;
}

async function updateWithoutGateway(
  opts: ReleaseUpdateOptions,
  deadline: ReleaseUpdateDeadline,
): Promise<UpdateRunRecord | undefined> {
  const remaining = requireUpdateBudget(deadline);
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
    timeoutMs: opts.timeoutMs === undefined ? undefined : remaining,
    acceptCapabilities: opts.acceptCapabilities,
  });
  if (opts.tag && opts.restart && outcome.status === "current" && outcome.pluginsChanged) {
    await requestLocalGatewayRestart(deadline).catch((error: unknown) => {
      if (error === deadline.expired) {
        throw new Error(
          "Plugin maintenance completed, but the Gateway restart could not be confirmed before the update timeout. Run `openclaw update status` before retrying the restart.",
        );
      }
      throw error;
    });
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

function report(record: UpdateRunRecord | undefined, json: boolean, runId?: string) {
  if (json) {
    defaultRuntime.writeJson(record ?? { status: "unknown", ...(runId ? { runId } : {}) });
    return;
  }
  // The CLI stopped following before the run finished (its --timeout budget); the run goes on.
  if (!record || (record.status === "running" && !isPendingActivation(record))) {
    defaultRuntime.error(UPDATE_TIMEOUT_MESSAGE);
    return;
  }
  if (isPendingActivation(record)) {
    return;
  }
  const summary = renderUpdateRunSummary(record);
  if (record.status === "failed" || record.status === "rolled-back") {
    defaultRuntime.error(summary);
  } else {
    defaultRuntime.log(summary);
  }
}
