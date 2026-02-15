import type { GatewayRequestHandlers } from "./types.js";
import { loadConfig } from "../../config/config.js";
import { resolveOpenClawPackageRoot } from "../../infra/openclaw-root.js";
import {
  formatDoctorNonInteractiveHint,
  type RestartSentinelPayload,
  writeRestartSentinel,
} from "../../infra/restart-sentinel.js";
import { scheduleGatewaySigusr1Restart, triggerOpenClawRestart } from "../../infra/restart.js";
import { normalizeUpdateChannel } from "../../infra/update-channels.js";
import { runGatewayUpdate } from "../../infra/update-runner.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateUpdateRunParams,
} from "../protocol/index.js";

function scheduleGatewayServiceRestart(opts?: { delayMs?: number; reason?: string }): {
  ok: true;
  mode: "service";
  method: "launchctl" | "systemd" | "supervisor";
  delayMs: number;
  reason?: string;
  fallback: "sigusr1";
} {
  const delayMsRaw =
    typeof opts?.delayMs === "number" && Number.isFinite(opts.delayMs)
      ? Math.floor(opts.delayMs)
      : 2000;
  const delayMs = Math.min(Math.max(delayMsRaw, 0), 60_000);
  const reason =
    typeof opts?.reason === "string" && opts.reason.trim()
      ? opts.reason.trim().slice(0, 200)
      : undefined;
  const method =
    process.platform === "darwin"
      ? "launchctl"
      : process.platform === "linux"
        ? "systemd"
        : "supervisor";
  setTimeout(() => {
    const restart = triggerOpenClawRestart();
    if (restart.ok) {
      return;
    }
    console.warn(
      `update.run: service restart via ${restart.method} failed (${restart.detail ?? "unknown"}); falling back to in-process SIGUSR1 restart`,
    );
    scheduleGatewaySigusr1Restart({
      // Keep a short grace period so slow service-manager restarts can settle first.
      reason: reason ?? "update.run:fallback",
    });
  }, delayMs);
  return {
    ok: true,
    mode: "service",
    method,
    delayMs,
    reason,
    fallback: "sigusr1",
  };
}

export const updateHandlers: GatewayRequestHandlers = {
  "update.run": async ({ params, respond }) => {
    if (!validateUpdateRunParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid update.run params: ${formatValidationErrors(validateUpdateRunParams.errors)}`,
        ),
      );
      return;
    }
    const sessionKey =
      typeof (params as { sessionKey?: unknown }).sessionKey === "string"
        ? (params as { sessionKey?: string }).sessionKey?.trim() || undefined
        : undefined;
    const note =
      typeof (params as { note?: unknown }).note === "string"
        ? (params as { note?: string }).note?.trim() || undefined
        : undefined;
    const restartDelayMsRaw = (params as { restartDelayMs?: unknown }).restartDelayMs;
    const restartDelayMs =
      typeof restartDelayMsRaw === "number" && Number.isFinite(restartDelayMsRaw)
        ? Math.max(0, Math.floor(restartDelayMsRaw))
        : undefined;
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

    const restart = scheduleGatewayServiceRestart({
      delayMs: restartDelayMs,
      reason: "update.run",
    });

    respond(
      true,
      {
        ok: true,
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
