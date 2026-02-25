import path from "node:path";
import { loadConfig } from "../../config/config.js";
import { extractDeliveryInfo } from "../../config/sessions.js";
import { resolveOpenClawPackageRoot } from "../../infra/openclaw-root.js";
import {
  formatDoctorNonInteractiveHint,
  type RestartSentinelPayload,
  writeRestartSentinel,
} from "../../infra/restart-sentinel.js";
import { scheduleGatewaySigusr1Restart } from "../../infra/restart.js";
import { normalizeUpdateChannel } from "../../infra/update-channels.js";
import { runGatewayUpdate } from "../../infra/update-runner.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { pathExists } from "../../utils.js";
import { formatControlPlaneActor, resolveControlPlaneActor } from "../control-plane-audit.js";
import { validateUpdateRunParams } from "../protocol/index.js";
import { parseRestartRequestParams } from "./restart-request.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

const SERVICE_REFRESH_TIMEOUT_MS = 60_000;

function resolveNodeRunner(): string {
  const base = path.basename(process.execPath).toLowerCase();
  if (base === "node" || base === "node.exe") {
    return process.execPath;
  }
  return "node";
}

function resolveEntrypointCandidates(root?: string): string[] {
  if (!root) {
    return [];
  }
  return [
    path.join(root, "dist", "entry.js"),
    path.join(root, "dist", "entry.mjs"),
    path.join(root, "dist", "index.js"),
    path.join(root, "dist", "index.mjs"),
  ];
}

/**
 * Refresh the daemon service definition (plist / systemd unit) so that
 * environment variables like OPENCLAW_SERVICE_VERSION reflect the newly
 * installed version. Mirrors the CLI's refreshGatewayServiceEnv.
 *
 * Spawns the *updated* binary so the new VERSION constant is written.
 * Returns status for logging; errors are non-fatal.
 */
async function refreshServiceEnv(
  root: string | undefined,
): Promise<{ status: "refreshed" | "skipped" | "failed"; reason?: string }> {
  if (!root) {
    return { status: "skipped", reason: "no root path" };
  }

  const args = ["gateway", "install", "--force", "--json"];
  const candidates = resolveEntrypointCandidates(root);

  if (candidates.length === 0) {
    return { status: "skipped", reason: "no entrypoint candidates" };
  }

  for (const candidate of candidates) {
    if (!(await pathExists(candidate))) {
      continue;
    }
    const res = await runCommandWithTimeout([resolveNodeRunner(), candidate, ...args], {
      timeoutMs: SERVICE_REFRESH_TIMEOUT_MS,
    });
    if (res.code === 0) {
      return { status: "refreshed" };
    }
    // Failed but continue to next candidate
  }

  return { status: "failed", reason: "all entrypoint candidates failed" };
}

export const updateHandlers: GatewayRequestHandlers = {
  "update.run": async ({ params, respond, client, context }) => {
    if (!assertValidParams(params, validateUpdateRunParams, "update.run", respond)) {
      return;
    }
    const actor = resolveControlPlaneActor(client);
    const { sessionKey, note, restartDelayMs } = parseRestartRequestParams(params);
    const { deliveryContext, threadId } = extractDeliveryInfo(sessionKey);
    const timeoutMsRaw = (params as { timeoutMs?: unknown }).timeoutMs;
    const timeoutMs =
      typeof timeoutMsRaw === "number" && Number.isFinite(timeoutMsRaw)
        ? Math.max(1000, Math.floor(timeoutMsRaw))
        : undefined;

    let result: Awaited<ReturnType<typeof runGatewayUpdate>>;
    try {
      const config = loadConfig();
      const configChannel = normalizeUpdateChannel(config.update?.channel);
      const root =
        (await resolveOpenClawPackageRoot({
          moduleUrl: import.meta.url,
          argv1: process.argv[1],
          cwd: process.cwd(),
        })) ?? process.cwd();
      result = await runGatewayUpdate({
        timeoutMs,
        cwd: root,
        argv1: process.argv[1],
        channel: configChannel ?? undefined,
      });
    } catch (err) {
      result = {
        status: "error",
        mode: "unknown",
        reason: String(err),
        steps: [],
        durationMs: 0,
      };
    }

    const payload: RestartSentinelPayload = {
      kind: "update",
      status: result.status,
      ts: Date.now(),
      sessionKey,
      deliveryContext,
      threadId,
      message: note ?? null,
      doctorHint: formatDoctorNonInteractiveHint(),
      stats: {
        mode: result.mode,
        root: result.root ?? undefined,
        before: result.before ?? null,
        after: result.after ?? null,
        steps: result.steps.map((step) => ({
          name: step.name,
          command: step.command,
          cwd: step.cwd,
          durationMs: step.durationMs,
          log: {
            stdoutTail: step.stdoutTail ?? null,
            stderrTail: step.stderrTail ?? null,
            exitCode: step.exitCode ?? null,
          },
        })),
        reason: result.reason ?? null,
        durationMs: result.durationMs,
      },
    };

    let sentinelPath: string | null = null;
    try {
      sentinelPath = await writeRestartSentinel(payload);
    } catch {
      sentinelPath = null;
    }

    // Refresh the daemon service definition so OPENCLAW_SERVICE_VERSION
    // in the plist/systemd unit reflects the newly installed version.
    // Must run before SIGUSR1 restart so the restarted process picks up
    // the updated environment. Errors are non-fatal.
    if (result.status === "ok") {
      try {
        const refreshResult = await refreshServiceEnv(result.root);
        if (refreshResult.status === "refreshed") {
          context?.logGateway?.info(`update.run: service env refreshed`);
        } else {
          context?.logGateway?.warn(
            `update.run: service env refresh ${refreshResult.status}: ${refreshResult.reason ?? "unknown"}`,
          );
        }
      } catch (err) {
        context?.logGateway?.warn(`update.run: service env refresh failed: ${String(err)}`);
      }
    }

    // Only restart the gateway when the update actually succeeded.
    // Restarting after a failed update leaves the process in a broken state
    // (corrupted node_modules, partial builds) and causes a crash loop.
    const restart =
      result.status === "ok"
        ? scheduleGatewaySigusr1Restart({
            delayMs: restartDelayMs,
            reason: "update.run",
            audit: {
              actor: actor.actor,
              deviceId: actor.deviceId,
              clientIp: actor.clientIp,
              changedPaths: [],
            },
          })
        : null;
    context?.logGateway?.info(
      `update.run completed ${formatControlPlaneActor(actor)} changedPaths=<n/a> restartReason=update.run status=${result.status}`,
    );
    if (restart?.coalesced) {
      context?.logGateway?.warn(
        `update.run restart coalesced ${formatControlPlaneActor(actor)} delayMs=${restart.delayMs}`,
      );
    }

    respond(
      true,
      {
        ok: result.status !== "error",
        result,
        restart,
        sentinel: {
          path: sentinelPath,
          payload,
        },
      },
      undefined,
    );
  },
};
