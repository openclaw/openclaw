// `openclaw update`, after the update command's refusals: a client of the
// running Gateway's `update.run`, or the same steps in-process when no Gateway answers.
import { setTimeout as sleep } from "node:timers/promises";
import { requestUpdateDowngradeConfirmation } from "../cli/update-cli/shared.js";
import { mutateConfigFileWithRetry } from "../config/mutate.js";
import {
  callGateway,
  isGatewayCredentialsRequiredError,
  isGatewayTransportError,
  isImplicitLocalGatewayTarget,
} from "../gateway/call.js";
import { GatewayClientRequestError } from "../gateway/client.js";
import { compareSemverStrings } from "../infra/npm-registry-spec.js";
import { resolveEffectiveUpdateChannel, type UpdateChannel } from "../infra/update-channels.js";
import { resolveStartupInstallStatus } from "../infra/update-install-status.js";
import { getUpdateRunAsync } from "../infra/update-run-reader.js";
import type { UpdateRunRecord } from "../infra/update-run-record.js";
import { createUpdateRunAsync } from "../infra/update-run-write.async.js";
import { defaultRuntime } from "../runtime.js";
import { VERSION } from "../version.js";
import { PREPARE_DEADLINE_MS, prepareUpdate } from "./run.js";
import { resolveTarget } from "./target.js";

const POLL_MS = 2_000;
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
  /** `--accept-capabilities`, for plugin maintenance in this process. */
  acceptCapabilities?: boolean;
  yes?: boolean;
};

export async function runReleaseUpdateCli(opts: ReleaseUpdateOptions): Promise<void> {
  const startedAt = Date.now();
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
  // Explicit package targets stay local: update.run cannot carry them without a protocol change.
  // --no-restart prepares in this process; the release starts at the Gateway's next start.
  const runId = opts.restart && !opts.tag ? await requestGatewayUpdate(target, timeoutMs) : null;
  let record = runId
    ? await followRun(
        runId,
        opts.json,
        Math.max(0, (opts.timeoutMs ?? RUN_DEADLINE_MS) - (Date.now() - startedAt)),
      )
    : await updateWithoutGateway({ ...opts, timeoutMs });
  if (
    opts.tag &&
    opts.restart &&
    isPendingActivation(record) &&
    (await requestLocalGatewayRestart(
      Math.max(1, (opts.timeoutMs ?? RUN_DEADLINE_MS) - (Date.now() - startedAt)),
    )) &&
    record
  ) {
    record = await followRun(
      record.runId,
      opts.json,
      Math.max(0, (opts.timeoutMs ?? RUN_DEADLINE_MS) - (Date.now() - startedAt)),
    );
  }
  report(record, opts.json);
  process.exitCode =
    record?.status === "succeeded" || record?.status === "skipped" || isPendingActivation(record)
      ? 0
      : 1;
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
    if (isGatewayTransportError(error) || isGatewayCredentialsRequiredError(error)) {
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
    const detail = record.steps.find(({ step }) => step === "outcome")?.detail;
    const message = record.origin.nextAction ?? record.reason ?? "unknown reason";
    defaultRuntime.error(`Update failed: ${detail ? `${detail}\n${message}` : message}`);
  }
}
