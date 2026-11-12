// Suppresses stale scheduler completions across reload and shutdown boundaries.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  PluginHookCronReconciledContext,
  PluginHookCronReconciledEvent,
  PluginHookGatewayCronService,
} from "../plugins/hook-gateway.types.js";
import type { PluginRegistry } from "../plugins/registry-types.js";
import { getPluginRuntimeLoadContext } from "../plugins/runtime/load-context.js";
import type { GatewayCronState } from "./server-cron-contract.js";
import { reconcileOrphanedMemoryDreamingJobs } from "./server-cron-memory-dreaming-jobs.js";

type GatewayCronReconciliationArmParams = {
  reason: PluginHookCronReconciledEvent["reason"];
  config: OpenClawConfig;
  cronState: GatewayCronState;
};

export type GatewayCronReconciliation = {
  arm: (params: GatewayCronReconciliationArmParams) => {
    complete: () => Promise<void>;
  };
  invalidate: () => void;
};

export function createGatewayCronReconciliation(params: {
  port: number;
  workspaceDir: string;
  isClosing: () => boolean;
  getConfig: () => OpenClawConfig;
  getPluginRegistry: () => PluginRegistry | undefined;
  logger: { warn: (message: string) => void };
  runHook: (
    event: PluginHookCronReconciledEvent,
    ctx: PluginHookCronReconciledContext,
  ) => Promise<void>;
}): GatewayCronReconciliation {
  let activeAbortController: AbortController | undefined;

  const supersedeActive = () => {
    activeAbortController?.abort();
    activeAbortController = undefined;
  };

  return {
    arm: ({ reason, config, cronState }) => {
      supersedeActive();
      const abortController = new AbortController();
      activeAbortController = abortController;
      const service = cronState.cron;
      const cron = service as PluginHookGatewayCronService;
      const event: PluginHookCronReconciledEvent = {
        reason,
        enabled: cronState.cronEnabled,
      };
      let completed = false;

      return {
        complete: async () => {
          if (completed) {
            return;
          }
          completed = true;
          // Each signal owns one exact scheduler snapshot. Do not serialize
          // snapshots: a stuck stale observer must not hide the current state.
          if (params.isClosing() || abortController.signal.aborted) {
            return;
          }
          const cleanupConfig = params.getConfig();
          const cleanupRegistry = params.getPluginRegistry();
          await reconcileOrphanedMemoryDreamingJobs({
            cron: service,
            cfg: cleanupConfig,
            logger: params.logger,
            manifestRegistry: getPluginRuntimeLoadContext(cleanupRegistry)?.manifestRegistry,
            isCurrent: () =>
              !params.isClosing() &&
              !abortController.signal.aborted &&
              cleanupConfig === params.getConfig() &&
              cleanupRegistry === params.getPluginRegistry(),
          });
          if (params.isClosing() || abortController.signal.aborted) {
            return;
          }
          await params.runHook(event, {
            port: params.port,
            config,
            workspaceDir: params.workspaceDir,
            getCron: () => cron,
            abortSignal: abortController.signal,
          });
        },
      };
    },
    invalidate: supersedeActive,
  };
}
