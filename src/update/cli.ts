// `openclaw update` for Git installs, after the update command's refusals: a client of the
// running Gateway's `update.run`, or the same steps in-process when no Gateway answers.
import { setTimeout as sleep } from "node:timers/promises";
import { mutateConfigFileWithRetry } from "../config/mutate.js";
import { callGateway, isGatewayTransportError } from "../gateway/call.js";
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
};

export async function runReleaseUpdateCli(opts: ReleaseUpdateOptions): Promise<void> {
  const { runningRoot, channel } = opts;
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
  const runId = opts.restart ? await requestGatewayUpdate(target) : null;
  const record = runId
    ? await followRun(runId, opts.json)
    : await updateWithoutGateway(runningRoot, channel ?? opts.storedChannel, opts.sha);
  report(record, opts.json);
  process.exitCode =
    record?.status === "succeeded" || record?.status === "skipped" || isPendingActivation(record)
      ? 0
      : 1;
}

async function requestGatewayUpdate(target?: {
  kind: "git";
  upstreamRef: string;
  upstreamSha: string;
}): Promise<string | null> {
  try {
    const response = await callGateway<{ runId: string | null; ok: boolean; message?: string }>({
      method: "update.run",
      params: target ? { target } : {},
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

/** The Gateway restarts during a run; transport errors until the deadline are expected. */
async function followRun(runId: string, json: boolean): Promise<UpdateRunRecord | undefined> {
  const deadline = Date.now() + RUN_DEADLINE_MS;
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
      if (!isGatewayTransportError(error)) {
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
  runningRoot: string,
  configChannel: UpdateChannel | undefined,
  sha?: string,
): Promise<UpdateRunRecord | undefined> {
  const run = await createUpdateRunAsync({ trigger: "cli", before: { version: VERSION } });
  const channel = resolveEffectiveUpdateChannel({
    configChannel,
    currentVersion: VERSION,
    installKind: "git",
  }).channel;
  const outcome = await prepareUpdate({
    runId: run.runId,
    runningRoot,
    runningVersion: VERSION,
    channel,
    sha,
  });
  if (outcome.status === "pending") {
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
  if (isPendingActivation(record)) {
    return;
  }
  if (!record) {
    defaultRuntime.error(
      "The update did not finish in time. Run `openclaw update status` to see it.",
    );
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
