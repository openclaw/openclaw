// `openclaw update` for Git installs, after the update command's refusals: a client of the
// running Gateway's `update.run`, or the same steps in-process when no Gateway answers.
import { setTimeout as sleep } from "node:timers/promises";
import { mutateConfigFileWithRetry } from "../config/mutate.js";
import {
  callGateway,
  isGatewayTransportError,
  isImplicitLocalGatewayTarget,
} from "../gateway/call.js";
import { GatewayClientRequestError } from "../gateway/client.js";
import { resolveEffectiveUpdateChannel, type UpdateChannel } from "../infra/update-channels.js";
import { resolveStartupInstallStatus } from "../infra/update-install-status.js";
import { getUpdateRunAsync } from "../infra/update-run-reader.js";
import type { UpdateRunRecord } from "../infra/update-run-record.js";
import { createUpdateRunAsync } from "../infra/update-run-write.async.js";
import { defaultRuntime } from "../runtime.js";
import { VERSION } from "../version.js";
import { PREPARE_DEADLINE_MS, prepareUpdate } from "./run.js";

const POLL_MS = 2_000;
/** Prepare, plus a trial that includes the boot migration. */
const RUN_DEADLINE_MS = PREPARE_DEADLINE_MS + 30 * 60_000;

export type ReleaseUpdateOptions = {
  json: boolean;
  restart: boolean;
  /** The Git checkout the update command admitted. */
  runningRoot: string;
  /** Requested with --channel; persisted before the update. */
  channel?: UpdateChannel;
  /** The saved `update.channel`, used when nothing was requested. */
  storedChannel?: UpdateChannel;
  sha?: string;
  /** `--timeout`: one overall budget for preparing and following the run. */
  timeoutMs?: number;
  /** `--accept-capabilities`, for plugin maintenance in this process. */
  acceptCapabilities?: boolean;
};

export async function runReleaseUpdateCli(opts: ReleaseUpdateOptions): Promise<void> {
  const { channel } = opts;
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
  // --no-restart prepares in this process; the release starts at the Gateway's next start.
  const runId = opts.restart ? await requestGatewayUpdate(target, opts.timeoutMs) : null;
  const record = runId
    ? await followRun(runId, opts.json, opts.timeoutMs ?? RUN_DEADLINE_MS)
    : await updateWithoutGateway(opts);
  report(record, opts.json);
  process.exitCode =
    record?.status === "succeeded" || record?.status === "skipped" || isPendingActivation(record)
      ? 0
      : 1;
}

async function requestGatewayUpdate(
  target: { kind: "git"; upstreamRef: string; upstreamSha: string } | undefined,
  timeoutMs: number | undefined,
): Promise<string | null> {
  // Only the local Gateway serves this checkout; a remote or overridden target would update
  // another installation, so this checkout prepares its release here instead.
  if (!(await isImplicitLocalGatewayTarget({}))) {
    return null;
  }
  try {
    const response = await callGateway<{ runId: string | null; ok: boolean; message?: string }>({
      method: "update.run",
      params: { ...(target ? { target } : {}), ...(timeoutMs ? { timeoutMs } : {}) },
      timeoutMs: 30_000,
    });
    if (!response.runId) {
      throw new Error(response.message ?? "The Gateway refused the update.");
    }
    return response.runId;
  } catch (error) {
    if (isGatewayTransportError(error)) {
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
    installKind: "git",
    git: status.git,
  }).channel;
  const outcome = await prepareUpdate({
    runId: run.runId,
    runningRoot: opts.runningRoot,
    runningVersion: VERSION,
    channel,
    sha: opts.sha,
    timeoutMs: opts.timeoutMs,
    acceptCapabilities: opts.acceptCapabilities,
  });
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

function report(record: UpdateRunRecord | undefined, json: boolean) {
  if (json) {
    defaultRuntime.writeJson(record ?? { status: "unknown" });
    return;
  }
  // The CLI stopped following before the run finished (its --timeout budget); the run goes on.
  if (!record || (record.status === "running" && !isPendingActivation(record))) {
    defaultRuntime.error(
      "The update did not finish in time. Run `openclaw update status` to see it.",
    );
    return;
  }
  const plugins = record.steps.find(({ step }) => step === "plugins");
  if (plugins?.status === "failed") {
    defaultRuntime.error(`Plugins were not all updated: ${plugins.detail ?? "unknown reason"}`);
  } else if (plugins?.detail) {
    defaultRuntime.log(`Plugin notes: ${plugins.detail}`);
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
    defaultRuntime.error(
      `Update failed: ${record.origin.nextAction ?? record.reason ?? "unknown reason"}`,
    );
  }
}
