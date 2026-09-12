import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  LEGACY_PACKAGE_INSTALL_GUARD_RELATIVE_PATH,
  PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH,
} from "../../scripts/lib/package-lifecycle-marker.mjs";
import { GATEWAY_RUNTIME_GENERATION_CHANGED_RESTART_REASON } from "../infra/gateway-fresh-process-restart.js";
import { resolveOpenClawPackageRootSync } from "../infra/openclaw-root.js";
import { scheduleGatewaySigusr1Restart } from "../infra/restart.js";
import { resolveRuntimeServiceBuildId } from "../version.js";

const DEFAULT_RUNTIME_GENERATION_POLL_MS = 5_000;
const gatewayInstallRoot = resolveOpenClawPackageRootSync({ moduleUrl: import.meta.url });
const attemptedRuntimeBuildIds = new Set<string>();

type RuntimeGenerationLogger = {
  info(message: string): void;
  warn(message: string): void;
};

type RuntimeBuildGeneration = { buildId: string; activation?: "manual" };

async function readRuntimeBuildGeneration(
  buildInfoPath: string,
): Promise<RuntimeBuildGeneration | null> {
  try {
    // SAFETY: the parsed value is treated as unknown except for the optional field check below.
    const parsed = JSON.parse(await readFile(buildInfoPath, "utf8")) as {
      buildId?: unknown;
      activation?: unknown;
    };
    const buildId = normalizeOptionalString(parsed.buildId);
    if (!buildId || buildId.length > 96) {
      return null;
    }
    return {
      buildId,
      ...(parsed.activation === "manual" ? { activation: parsed.activation } : {}),
    };
  } catch {
    // Missing, partial, and invalid files are expected while a build is in progress.
    return null;
  }
}

async function isPackageLifecyclePending(installRoot: string): Promise<boolean> {
  const markerPaths = [
    path.join(installRoot, PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH),
    path.join(installRoot, LEGACY_PACKAGE_INSTALL_GUARD_RELATIVE_PATH),
  ];
  for (const markerPath of markerPaths) {
    try {
      await access(markerPath);
      return true;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        return true;
      }
    }
  }
  return false;
}

export function startGatewayRuntimeGenerationMonitor(params: {
  log: RuntimeGenerationLogger;
  intervalMs?: number;
  installRoot?: string | null;
  loadedBuildId?: string | null;
  readGeneration?: (buildInfoPath: string) => Promise<RuntimeBuildGeneration | null>;
  isInstallPending?: (installRoot: string) => Promise<boolean>;
  scheduleRestart?: typeof scheduleGatewaySigusr1Restart;
  attemptedBuildIds?: Set<string>;
}): { stop(): Promise<void> } | null {
  const installRoot = params.installRoot === undefined ? gatewayInstallRoot : params.installRoot;
  const loadedBuildId =
    params.loadedBuildId === undefined ? resolveRuntimeServiceBuildId() : params.loadedBuildId;
  if (!installRoot || !loadedBuildId) {
    return null;
  }

  const buildInfoPath = path.join(installRoot, "dist", "build-info.json");
  const readGeneration = params.readGeneration ?? readRuntimeBuildGeneration;
  const isInstallPending = params.isInstallPending ?? isPackageLifecyclePending;
  const scheduleRestart = params.scheduleRestart ?? scheduleGatewaySigusr1Restart;
  const attemptedBuildIds = params.attemptedBuildIds ?? attemptedRuntimeBuildIds;
  let stopped = false;
  let restartScheduled = false;
  let observedBuildId: string | null = null;
  let inFlight: Promise<void> | null = null;

  const check = async () => {
    const generation = await readGeneration(buildInfoPath);
    if (stopped || restartScheduled || !generation || generation.buildId === loadedBuildId) {
      observedBuildId = null;
      return;
    }
    const installPending = await isInstallPending(installRoot);
    if (stopped || restartScheduled) {
      observedBuildId = null;
      return;
    }
    if (installPending) {
      observedBuildId = null;
      return;
    }
    if (observedBuildId !== generation.buildId) {
      observedBuildId = generation.buildId;
      return;
    }
    if (generation.activation === "manual") {
      restartScheduled = true;
      clearInterval(timer);
      params.log.info(
        `runtime generation changed (${loadedBuildId} -> ${generation.buildId}); automatic restart suppressed by update policy`,
      );
      return;
    }
    if (attemptedBuildIds.has(generation.buildId)) {
      restartScheduled = true;
      clearInterval(timer);
      params.log.warn(
        `runtime generation ${generation.buildId} still requires a fresh process; run openclaw gateway restart`,
      );
      return;
    }
    restartScheduled = true;
    attemptedBuildIds.add(generation.buildId);
    clearInterval(timer);
    params.log.info(
      `runtime generation changed (${loadedBuildId} -> ${generation.buildId}); scheduling fresh-process restart`,
    );
    const result = scheduleRestart({
      delayMs: 0,
      reason: GATEWAY_RUNTIME_GENERATION_CHANGED_RESTART_REASON,
      preservePendingEmitHooksOnDeferralBypass: true,
      skipCooldown: true,
    });
    if (!result.ok) {
      params.log.warn("runtime generation restart request was rejected");
    }
  };
  const poll = () => {
    if (stopped || restartScheduled || inFlight) {
      return;
    }
    inFlight = check().finally(() => {
      inFlight = null;
    });
  };
  const timer = setInterval(poll, params.intervalMs ?? DEFAULT_RUNTIME_GENERATION_POLL_MS);
  timer.unref?.();

  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      await inFlight;
    },
  };
}
