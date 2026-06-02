import { logVerbose } from "../../infra/globals.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { rejectNonOwnerCommand } from "./command-gates.js";
import { extractDeliveryInfo } from "../../config/sessions.js";
import type { RestartSentinelPayload } from "../../infra/restart-sentinel.js";
import {
  buildRestartSuccessContinuation,
  formatDoctorNonInteractiveHint,
} from "../../infra/restart-sentinel.js";

function buildRestartCommandSentinel(params: HandleCommandsParams): RestartSentinelPayload | null {
  const sessionKey = params.sessionKey;
  if (!sessionKey) {
    return null;
  }
  const { deliveryContext, threadId } = extractDeliveryInfo(sessionKey);
  const payload: RestartSentinelPayload = {
    kind: "restart",
    status: "ok",
    ts: Date.now(),
    sessionKey,
    deliveryContext,
    threadId,
    message: "/restart",
    continuation: buildRestartSuccessContinuation({ sessionKey }),
    doctorHint: formatDoctorNonInteractiveHint(),
    stats: {
      mode: "gateway.restart",
      reason: "/restart",
    },
  };
  return payload;
}
import { isRestartEnabled } from "../../config/commands.flags.js";
import {
  scheduleGatewaySigusr1Restart,
  triggerOpenClawRestart,
} from "../../infra/restart.js";
import { removeRestartSentinelFile, writeRestartSentinel } from "../../infra/restart-sentinel.js";
import type { CommandHandler, HandleCommandsParams } from "./commands-types.js";

/**
 * Read the version of the currently running openclaw process from the
 * package.json next to the launcher entry point (process.argv[1]).
 */
function getRunningOpenClawVersion(): string | null {
  try {
    const entry = process.argv[1]?.trim();
    if (!entry) return null;
    const pkgPath = join(dirname(entry), "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    return typeof pkg?.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

/**
 * Query the globally installed npm version for a package.
 * Uses `npm list -g <pkg> --json` so it respects the current prefix.
 */
function getGlobalNpmVersion(packageName: string): string | null {
  try {
    const result = spawnSync("npm", ["list", "-g", packageName, "--json"], {
      encoding: "utf8",
      timeout: 3000,
    });
    if (result.status !== 0) return null;
    const parsed = JSON.parse(result.stdout);
    return parsed.dependencies?.[packageName]?.version ?? null;
  } catch {
    return null;
  }
}

export const handleRestartCommand: CommandHandler = async (params, allowTextCommands) => {
  if (!allowTextCommands) {
    return null;
  }
  if (params.command.commandBodyNormalized !== "/restart") {
    return null;
  }
  if (!params.command.isAuthorizedSender) {
    logVerbose(
      `Ignoring /restart from unauthorized sender: ${params.command.senderId || "<unknown>"}`,
    );
    return { shouldContinue: false };
  }
  const nonOwner = rejectNonOwnerCommand(params, "/restart");
  if (nonOwner) {
    return nonOwner;
  }
  if (!isRestartEnabled(params.cfg)) {
    return {
      shouldContinue: false,
      reply: {
        text: "⚠️ /restart is disabled (commands.restart=false).",
      },
    };
  }

  /* ---- version-mismatch guard: if npm updated globally, SIGUSR1 won't reload
     node_modules, so force a full restart instead. ---- */
  const runningVersion = getRunningOpenClawVersion();
  const globalVersion = getGlobalNpmVersion("openclaw");
  const versionMismatch =
    runningVersion !== null &&
    globalVersion !== null &&
    runningVersion !== globalVersion;

  if (versionMismatch) {
    logVerbose(`restart: version mismatch detected (running ${runningVersion} vs npm ${globalVersion}); forcing full restart`);
  }

  const hasSigusr1Listener = process.listenerCount("SIGUSR1") > 0;
  const sentinelPayload = buildRestartCommandSentinel(params);

  /**
   * SIGUSR1 in-process reload (fastest, keeps same PID).
   * Only available when the gateway run-loop has registered a SIGUSR1 handler.
   */
  if (hasSigusr1Listener && !versionMismatch) {
    let sentinelPath: string | null = null;
    scheduleGatewaySigusr1Restart({
      reason: "/restart",
      emitHooks: sentinelPayload
        ? {
            beforeEmit: async () => {
              sentinelPath = await writeRestartSentinel(sentinelPayload);
            },
            afterEmitRejected: async () => {
              await removeRestartSentinelFile(sentinelPath);
            },
          }
        : undefined,
    });
    return {
      shouldContinue: false,
      reply: {
        text: "⚙️ Restarting OpenClaw in-process (SIGUSR1); back in a few seconds.",
      },
    };
  }

  /**
   * Fallback: systemd / launchctl / schtasks full restart.
   * This reloads the node binary and therefore picks up new npm packages.
   */
  /* eslint-disable-next-line no-lonely-if */
  let sentinelPath: string | null = null;
  try {
    if (sentinelPayload) sentinelPath = await writeRestartSentinel(sentinelPayload);
  } catch (err) {
    logVerbose(`failed to write /restart sentinel: ${String(err)}`);
    return {
      shouldContinue: false,
      reply: {
        text: "⚠️ Restart failed: could not persist the post-restart acknowledgement.",
      },
    };
  }
  const restartMethod = triggerOpenClawRestart();
  if (!restartMethod.ok) {
    await removeRestartSentinelFile(sentinelPath);
    const detail = restartMethod.detail ? ` Details: ${restartMethod.detail}` : "";
    return { shouldContinue: false, reply: { text: `⚠️ Restart failed (${restartMethod.method}).${detail}` } };
  }
  const versionNote =
    versionMismatch && runningVersion && globalVersion
      ? ` (npm package ${runningVersion} → ${globalVersion})`
      : "";
  return {
    shouldContinue: false,
    reply: {
      text: `⚙️ Restarting OpenClaw via ${restartMethod.method}${versionNote}; give me a few seconds to come back online.`,
    },
  };
};