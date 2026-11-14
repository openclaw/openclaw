import type {
  UpdateAvailable,
  UpdateScheduleState,
} from "../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { computeNextRunAtMs } from "../cron/schedule.js";
import type { RemoteCatalogPublicationResult } from "../model-catalog/remote-overlay.js";
import {
  refreshRemoteModelCatalog,
  REMOTE_MODEL_CATALOG_TTL_MS,
} from "../model-catalog/remote-refresh.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { isTruthyEnvValue } from "./env.js";
import type { GatewayActiveWorkInspectors } from "./gateway-active-work.js";
import { isGatewayExternallySupervised } from "./gateway-supervision.js";
import type { UpdateCheckLifecycle } from "./update-check-lifecycle.js";
import type { resolveStartupInstallStatus } from "./update-install-status.js";
import { runGatewayUpdateCheck, resolveCheckIntervalMs } from "./update-startup.js";
import { getUpdateSchedule } from "./update-status-state.js";

export function createGatewayUpdateCheck(params: {
  lifecycle: UpdateCheckLifecycle;
  getConfig: () => OpenClawConfig;
  applyRemoteCatalogUpdate: (signal: AbortSignal) => Promise<RemoteCatalogPublicationResult>;
  log: { info: (msg: string, meta?: Record<string, unknown>) => void };
  isNixMode: boolean;
  onUpdateAvailableChange?: (updateAvailable: UpdateAvailable | null) => void;
  onUpdateScheduleChange?: (schedule: UpdateScheduleState) => void;
  onUpdateRunCreated?: () => void;
  activeWorkInspectors?: Partial<GatewayActiveWorkInspectors>;
}): {
  initialize: () => ReturnType<typeof resolveStartupInstallStatus>;
  start: () => void;
  stop: () => Promise<void>;
} {
  const { lifecycle } = params;
  let started = false;
  let stopConfigListener: (() => void) | undefined;
  const updatePolicy = () => JSON.stringify(params.getConfig().update ?? {});
  let policy = updatePolicy();
  const check = async () => {
    try {
      await runGatewayUpdateCheck(params, lifecycle);
    } catch (error) {
      // Discovery failures must not crash or retire the Gateway update loop.
      if (!lifecycle.signal.aborted) {
        params.log.info("update check failed; retrying at the next scheduled check", {
          error: String(error),
        });
      }
    }
    const cfg = params.getConfig();
    const interval = resolveCheckIntervalMs(cfg, getUpdateSchedule()?.install?.kind);
    const expr =
      cfg.update?.auto?.enabled &&
      cfg.update?.checkOnStart !== false &&
      cfg.update?.channel !== "extended-stable" &&
      !isTruthyEnvValue(process.env.OPENCLAW_NO_AUTO_UPDATE) &&
      !isGatewayExternallySupervised()
        ? cfg.update.auto.schedule
        : undefined;
    if (!expr) {
      return interval;
    }
    const now = Date.now();
    const next = computeNextRunAtMs({ kind: "cron", expr }, now);
    return next === undefined ? interval : Math.min(interval, Math.max(1, next - now));
  };
  return {
    initialize: lifecycle.initialize,
    stop: () => {
      stopConfigListener?.();
      return lifecycle.stop();
    },
    start: () => {
      if (started || lifecycle.signal.aborted) {
        return;
      }
      started = true;
      // Config publication already emits these notifications after installing the
      // live snapshot. Re-arm the existing owner, not a second polling scheduler.
      stopConfigListener = sessionChanges.subscribe((change) => {
        if (
          !("all" in change) ||
          typeof change.scope !== "string" ||
          !change.scope.startsWith("config")
        ) {
          return;
        }
        const nextPolicy = updatePolicy();
        if (policy === nextPolicy || lifecycle.signal.aborted) {
          return;
        }
        policy = nextPolicy;
        if (lifecycle.campaign?.getState()?.state !== "applying") {
          lifecycle.campaign?.clear();
        }
        lifecycle.schedule("update.check", check);
      });
      lifecycle.signal.addEventListener("abort", () => stopConfigListener?.(), { once: true });
      lifecycle.schedule("update.check", check);
      lifecycle.schedule("update.remote-model-catalog", async () => {
        let nextCheckInMs = REMOTE_MODEL_CATALOG_TTL_MS;
        try {
          const result = await refreshRemoteModelCatalog({
            config: params.getConfig(),
            signal: lifecycle.signal,
          });
          if (lifecycle.signal.aborted) {
            return REMOTE_MODEL_CATALOG_TTL_MS;
          }
          nextCheckInMs =
            result.status === "fresh" ? result.nextCheckInMs : REMOTE_MODEL_CATALOG_TTL_MS;
          if (result.status === "error") {
            params.log.info(
              "remote model catalog refresh failed; next check in 6 hours, or run openclaw models refresh",
              { error: result.error },
            );
          } else if (result.status !== "disabled") {
            const state = await params.applyRemoteCatalogUpdate(lifecycle.signal);
            if (state === "published") {
              params.log.info("remote model catalog applied");
            } else if (state === "superseded") {
              params.log.info("remote model catalog check superseded; deferred to the next check");
            }
          }
        } catch (error) {
          if (!lifecycle.signal.aborted) {
            params.log.info("remote model catalog check failed", { error: String(error) });
          }
        }
        return nextCheckInMs;
      });
    },
  };
}
