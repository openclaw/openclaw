// `openclaw update` for installs on the release launcher: a client of the running Gateway's
// `update.run`, or the same steps in-process when no Gateway answers.
import { setTimeout as sleep } from "node:timers/promises";
import { mutateConfigFileWithRetry } from "../config/mutate.js";
import { callGateway, isGatewayTransportError } from "../gateway/call.js";
import {
  normalizeUpdateChannel,
  resolveEffectiveUpdateChannel,
  type UpdateChannel,
} from "../infra/update-channels.js";
import { resolveStartupInstallStatus } from "../infra/update-install-status.js";
import type { UpdateRunRecord } from "../infra/update-run-record.js";
import { defaultRuntime } from "../runtime.js";
import { VERSION } from "../version.js";
import { PREPARE_DEADLINE_MS, prepareUpdate } from "./run.js";
import { createRun } from "./runs.js";

const POLL_MS = 2_000;
/** Prepare, plus a trial that includes the boot migration. */
const RUN_DEADLINE_MS = PREPARE_DEADLINE_MS + 30 * 60_000;

export type UpdateCliOptions = { json: boolean; channel?: string; sha?: string };

/** Returns false when this install is not on the release path (the caller runs the package updater). */
export async function runReleaseUpdateCli(opts: UpdateCliOptions): Promise<boolean> {
  const { root: runningRoot, status } = await resolveStartupInstallStatus(
    false,
    new AbortController().signal,
  );
  if (!runningRoot || status.installKind !== "git") {
    return false;
  }
  const channel = (opts.channel ? normalizeUpdateChannel(opts.channel) : undefined) ?? undefined;
  if (opts.channel && !channel) {
    throw new Error(
      `--channel must be stable, extended-stable, beta or dev (got "${opts.channel}").`,
    );
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
  const runId = await requestGatewayUpdate(opts.sha);
  const record = runId
    ? await followRun(runId, opts.json)
    : await updateWithoutGateway(runningRoot, channel, opts.sha);
  report(record, opts.json);
  process.exitCode = record?.status === "succeeded" || record?.status === "skipped" ? 0 : 1;
  return true;
}

async function requestGatewayUpdate(sha?: string): Promise<string | null> {
  try {
    const response = await callGateway<{ runId: string | null; ok: boolean; message?: string }>({
      method: "update.run",
      params: sha ? { target: { kind: "git", upstreamSha: sha } } : {},
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
  const run = createRun({ trigger: "cli", before: { version: VERSION } });
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
    return { ...run, status: "succeeded" };
  }
  const { readRun } = await import("./runs.js");
  return readRun(run.runId);
}

function report(record: UpdateRunRecord | undefined, json: boolean) {
  if (json) {
    defaultRuntime.writeJson(record ?? { status: "unknown" });
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
