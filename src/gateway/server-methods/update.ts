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
import { resolveStableNodePath } from "../../infra/stable-node-path.js";
import { normalizeUpdateChannel } from "../../infra/update-channels.js";
import { runGatewayUpdate } from "../../infra/update-runner.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { formatControlPlaneActor, resolveControlPlaneActor } from "../control-plane-audit.js";
import { validateUpdateRunParams } from "../protocol/index.js";
import { parseRestartRequestParams } from "./restart-request.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

const SERVICE_REFRESH_TIMEOUT_MS = 60_000;

// Candidate entry points to try when invoking the updated install.
// Mirrors resolveGatewayInstallEntrypointCandidates() in the CLI update-command.
const GATEWAY_INSTALL_ENTRY_CANDIDATES = [
  "dist/entry.js",
  "dist/entry.mjs",
  "dist/index.js",
  "dist/index.mjs",
];

/**
 * After a successful npm/pnpm update, rewrite the service unit file (systemd /
 * launchd / Windows Task) so that OPENCLAW_SERVICE_VERSION is updated to the
 * newly installed version.
 *
 * Without this step, the gateway process is reloaded in-place via SIGUSR1,
 * which keeps the original process environment intact. The environment variable
 * OPENCLAW_SERVICE_VERSION is baked into the service unit at install time and
 * is therefore still set to the *previous* version. As a result the web control
 * panel continues to display the old version number until the service is fully
 * restarted (e.g. by running `openclaw update` from the terminal, which calls
 * `gateway install --force` before restarting).
 *
 * This function mirrors `refreshGatewayServiceEnv()` in
 * `src/cli/update-cli/update-command.ts`, bringing the gateway `update.run`
 * path to parity with the CLI update path.
 *
 * Failures are intentionally non-fatal: the SIGUSR1 reload still proceeds, and
 * the version mismatch is only cosmetic (the binary itself is up to date).
 */
async function refreshGatewayServiceEnv(root: string): Promise<void> {
  const nodePath = await resolveStableNodePath(process.execPath);
  for (const candidate of GATEWAY_INSTALL_ENTRY_CANDIDATES) {
    const entryPath = path.join(root, candidate);
    try {
      await import("node:fs/promises").then((fs) => fs.access(entryPath));
    } catch {
      continue;
    }
    const res = await runCommandWithTimeout(
      [nodePath, entryPath, "gateway", "install", "--force"],
      { timeoutMs: SERVICE_REFRESH_TIMEOUT_MS },
    );
    if (res.code === 0) {
      return;
    }
    throw new Error(
      `service env refresh failed (${entryPath}): ${(res.stderr || res.stdout).trim().split("\n").slice(-3).join("\n")}`,
    );
  }
  // No candidate entry point was found — throw so the call-site .catch logs a warning.
  throw new Error(
    `service env refresh skipped: no entry point found under ${root} (tried ${GATEWAY_INSTALL_ENTRY_CANDIDATES.join(", ")})`,
  );
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

    // Only restart the gateway when the update actually succeeded.
    // Restarting after a failed update leaves the process in a broken state
    // (corrupted node_modules, partial builds) and causes a crash loop.

    // Before scheduling the SIGUSR1 in-place reload, rewrite the service unit
    // file so that OPENCLAW_SERVICE_VERSION reflects the newly installed
    // version.  We await this so the unit is written before the restart signal
    // fires.  Failures are non-fatal: a warning is logged and the restart
    // proceeds; the only consequence is the cosmetic version mismatch that
    // this call is trying to fix.
    if (
      result.status === "ok" &&
      result.root &&
      (result.mode === "npm" || result.mode === "pnpm")
    ) {
      await refreshGatewayServiceEnv(result.root).catch((err) => {
        context?.logGateway?.warn(`update.run: service env refresh failed: ${String(err)}`);
      });
    }

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
