import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { createExecApprovalForwarder } from "../infra/exec-approval-forwarder.js";
import { type PluginApprovalRequestPayload } from "../infra/plugin-approvals.js";
import {
  resolveCommandSecretsFromActiveRuntimeSnapshot,
  type CommandSecretAssignment,
} from "../secrets/runtime-command-secrets.js";
import { getActiveSecretsRuntimeSnapshot } from "../secrets/runtime.js";
import {
  buildGatewayReloadPlan,
  diffConfigPaths,
  type ChannelKind,
} from "./config-reload.js";
import { createExecApprovalIosPushDelivery } from "./exec-approval-ios-push.js";
import { ExecApprovalManager } from "./exec-approval-manager.js";
import { createExecApprovalHandlers } from "./server-methods/exec-approval.js";
import { createPluginApprovalHandlers } from "./server-methods/plugin-approval.js";
import { createSecretsHandlers } from "./server-methods/secrets.js";
import {
  disconnectStaleSharedGatewayAuthClients,
  setCurrentSharedGatewaySessionGeneration,
  type SharedGatewayAuthClient,
  type SharedGatewaySessionGenerationState,
} from "./server-shared-auth-generation.js";
import type { ActivateRuntimeSecrets } from "./server-startup-config.js";

type GatewayAuxHandlerLogger = {
  warn?: (message: string) => void;
  error?: (message: string) => void;
  debug?: (message: string) => void;
};

export function createGatewayAuxHandlers(params: {
  log: GatewayAuxHandlerLogger;
  activateRuntimeSecrets: ActivateRuntimeSecrets;
  sharedGatewaySessionGenerationState: SharedGatewaySessionGenerationState;
  resolveSharedGatewaySessionGenerationForConfig: (config: OpenClawConfig) => string | undefined;
  clients: Iterable<SharedGatewayAuthClient>;
  startChannel: (name: ChannelKind) => Promise<void>;
  stopChannel: (name: ChannelKind) => Promise<void>;
  logChannels: { info: (msg: string) => void };
}) {
  const execApprovalManager = new ExecApprovalManager();
  const execApprovalForwarder = createExecApprovalForwarder();
  const execApprovalIosPushDelivery = createExecApprovalIosPushDelivery({ log: params.log });
  const execApprovalHandlers = createExecApprovalHandlers(execApprovalManager, {
    forwarder: execApprovalForwarder,
    iosPushDelivery: execApprovalIosPushDelivery,
  });
  const pluginApprovalManager = new ExecApprovalManager<PluginApprovalRequestPayload>();
  const pluginApprovalHandlers = createPluginApprovalHandlers(pluginApprovalManager, {
    forwarder: execApprovalForwarder,
  });
  // Serialize the entire `secrets.reload` path (activation + channel restart)
  // so concurrent callers cannot overlap the stop/start loop and so the
  // "before" snapshot used for the reload-plan diff is always the snapshot
  // replaced by this call's activation, not one captured by a prior caller.
  let reloadTail: Promise<void> = Promise.resolve();
  const runExclusiveReload = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = reloadTail.then(fn, fn);
    reloadTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
  const secretsHandlers = createSecretsHandlers({
    reloadSecrets: () =>
      runExclusiveReload(async () => {
        const active = getActiveSecretsRuntimeSnapshot();
        if (!active) {
          throw new Error("Secrets runtime snapshot is not active.");
        }
        const previousSharedGatewaySessionGeneration =
          params.sharedGatewaySessionGenerationState.current;
        const prepared = await params.activateRuntimeSecrets(active.sourceConfig, {
          reason: "reload",
          activate: true,
        });
        const nextSharedGatewaySessionGeneration =
          params.resolveSharedGatewaySessionGenerationForConfig(prepared.config);
        const plan = buildGatewayReloadPlan(diffConfigPaths(active.config, prepared.config));
        setCurrentSharedGatewaySessionGeneration(
          params.sharedGatewaySessionGenerationState,
          nextSharedGatewaySessionGeneration,
        );
        if (previousSharedGatewaySessionGeneration !== nextSharedGatewaySessionGeneration) {
          disconnectStaleSharedGatewayAuthClients({
            clients: params.clients,
            expectedGeneration: nextSharedGatewaySessionGeneration,
          });
        }
        if (plan.restartChannels.size > 0) {
          if (
            isTruthyEnvValue(process.env.OPENCLAW_SKIP_CHANNELS) ||
            isTruthyEnvValue(process.env.OPENCLAW_SKIP_PROVIDERS)
          ) {
            params.logChannels.info(
              "skipping channel reload (OPENCLAW_SKIP_CHANNELS=1 or OPENCLAW_SKIP_PROVIDERS=1)",
            );
          } else {
            for (const channel of plan.restartChannels) {
              params.logChannels.info(`restarting ${channel} channel after secrets reload`);
              try {
                await params.stopChannel(channel);
                await params.startChannel(channel);
              } catch (err) {
                // Isolate per-channel failures so one channel's stop/start
                // error does not leave other changed channels unrestarted.
                params.logChannels.info(
                  `failed to restart ${channel} channel after secrets reload: ${String(err)}`,
                );
              }
            }
          }
        }
        return { warningCount: prepared.warnings.length };
      }),
    resolveSecrets: async ({ commandName, targetIds }) => {
      const { assignments, diagnostics, inactiveRefPaths } =
        resolveCommandSecretsFromActiveRuntimeSnapshot({
          commandName,
          targetIds: new Set(targetIds),
        });
      if (assignments.length === 0) {
        return { assignments: [] as CommandSecretAssignment[], diagnostics, inactiveRefPaths };
      }
      return { assignments, diagnostics, inactiveRefPaths };
    },
  });

  return {
    execApprovalManager,
    pluginApprovalManager,
    extraHandlers: {
      ...execApprovalHandlers,
      ...pluginApprovalHandlers,
      ...secretsHandlers,
    },
  };
}
