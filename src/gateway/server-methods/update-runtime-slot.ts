// Chat and Control UI updates of a runtime slot install: this Gateway stages and
// selects the inactive slot after update.run responds, then restarts itself. The
// Gateway that confirms the slot, or that the launcher returns to, finishes the run.
import { formatErrorMessage } from "../../infra/errors.js";
import { readPackageVersion } from "../../infra/package-json.js";
import { scheduleGatewayRestart } from "../../infra/restart.js";
import { CONTROL_PLANE_UPDATE_HANDOFF_STARTED_REASON } from "../../infra/update-control-plane-sentinel.js";
import { resolveUpdateInstallRoot } from "../../infra/update-install-root.js";
import {
  finishUpdateRunAsync as finishUpdateRun,
  recordUpdateRunPhaseAsync as recordUpdateRunPhase,
} from "../../infra/update-run-write.async.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import type { ControlPlaneActor } from "../control-plane-audit.js";

type GatewaySlotUpdateParams = {
  runId: string;
  installRoot: string;
  mode: UpdateRunResult["mode"];
  request: {
    channel?: string | undefined;
    tag?: string | undefined;
    timeoutMs?: number | undefined;
  };
  /** A pinned dev target commit. */
  sha?: string | undefined;
  actor: ControlPlaneActor;
  log?: { info: (message: string) => void; warn: (message: string) => void };
};

/** A package manager, app or image owns other installs: the result names its command. */
export async function prepareGatewaySlotUpdate(params: GatewaySlotUpdateParams) {
  const { resolveUpdateOwner, resolveUpdateTag } =
    await import("../../cli/update-cli/update-slots.js");
  const owner = await resolveUpdateOwner(
    resolveUpdateInstallRoot(params.installRoot),
    await resolveUpdateTag(params.request),
  );
  if (owner.kind === "external") {
    return { external: owner } as const;
  }
  const install = owner;
  const before = await readPackageVersion(params.installRoot);
  const result: UpdateRunResult = {
    status: "skipped",
    mode: params.mode,
    root: params.installRoot,
    reason: CONTROL_PLANE_UPDATE_HANDOFF_STARTED_REASON,
    ...(before ? { before: { version: before } } : {}),
    steps: [],
    durationMs: 0,
  };
  return {
    external: undefined,
    result,
    handoff: { status: "started" as const, command: "openclaw update (runtime slot)" },
    /** Starts once the restart sentinel is persisted, so the next Gateway can report. */
    start: async (sentinelPersisted: boolean) => {
      if (!sentinelPersisted) {
        await finishUpdateRun(params.runId, { status: "failed", reason: "sentinel" });
        return;
      }
      await runGatewaySlotUpdate(params, install);
    },
  };
}

async function runGatewaySlotUpdate(
  params: GatewaySlotUpdateParams,
  install: { root: string; git: boolean },
): Promise<void> {
  const { runId, request, actor } = params;
  try {
    await recordUpdateRunPhase(runId, "staging");
    const { runRuntimeSlotUpdate } = await import("../../cli/update-cli/update-slots.js");
    const outcome = await runRuntimeSlotUpdate(
      {
        ...(request.channel ? { channel: request.channel } : {}),
        ...(request.tag ? { tag: request.tag } : {}),
        ...(params.sha ? { sha: params.sha } : {}),
        ...(request.timeoutMs ? { timeout: String(Math.ceil(request.timeoutMs / 1000)) } : {}),
        yes: true,
        runId,
        restartSelf: () => {
          void recordUpdateRunPhase(runId, "restarting").finally(() =>
            scheduleGatewayRestart({
              delayMs: 0,
              reason: "update.run",
              audit: {
                actor: actor.actor,
                deviceId: actor.deviceId,
                clientIp: actor.clientIp,
                changedPaths: [],
              },
            }),
          );
        },
        log: (line) => params.log?.info(`update.run ${line.trim()}`),
      },
      install,
    );
    if (outcome.restart === "self" || outcome.restart === "confirmed") {
      return;
    }
    await finishUpdateRun(runId, {
      status:
        outcome.status === "ok" ? "succeeded" : outcome.status === "skipped" ? "skipped" : "failed",
      ...(outcome.reason ? { reason: outcome.reason } : {}),
      ...(outcome.status === "ok" ? {} : { nextAction: outcome.message }),
      ...(outcome.after ? { after: { version: outcome.after } } : {}),
    });
  } catch (error) {
    params.log?.warn(`update.run runtime slot update failed: ${formatErrorMessage(error)}`);
    await finishUpdateRun(runId, {
      status: "failed",
      reason: "runtime-slot-update-failed",
      nextAction: formatErrorMessage(error),
    }).catch(() => {});
  }
}
