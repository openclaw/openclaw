import { getRuntimeConfig } from "../config/config.js";
import type { GatewayScheduler } from "../infra/gateway-scheduler.js";
import { purgeExpiredSecretStoreEntries } from "../secrets/store/secret-store.js";
import {
  createGitHubOAuthLifecycle,
  installActiveGitHubOAuthLifecycle,
} from "./github-oauth-lifecycle.js";
import { createModelAccountConnectService } from "./model-account-connect.js";
import {
  broadcastChatMetadataChanged,
  type createGatewayChatMetadataLifecycle,
} from "./server-chat-metadata-lifecycle.js";
import { attachSessionChangeEventLifetime } from "./server-methods/session-change-event.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import type { GatewaySidecarStopOwner } from "./server-sidecar-owners.js";
import type { GatewayPostReadySidecarHandle } from "./server-startup-sidecar-scheduler.js";
import { startIncognitoSessionLifetime } from "./session-incognito-lifetime.js";

type GatewayChatMetadataLifecycle = Awaited<ReturnType<typeof createGatewayChatMetadataLifecycle>>;
const GITHUB_PUBLICATION_RECONCILE_INTERVAL_MS = 60_000;

function startGitHubPublicationMaintenance(
  reconcile: () => Promise<void>,
  logWarning: (message: string) => void,
): GatewayPostReadySidecarHandle {
  let current: Promise<void> | undefined;
  let stopped = false;
  const run = () => {
    if (stopped || current) {
      return;
    }
    const operation = reconcile()
      .catch(() => logWarning("GitHub publication recovery failed; will retry."))
      .finally(() => {
        if (current === operation) {
          current = undefined;
        }
      });
    current = operation;
  };
  run();
  const interval = setInterval(run, GITHUB_PUBLICATION_RECONCILE_INTERVAL_MS);
  interval.unref?.();
  return {
    stop: async () => {
      stopped = true;
      clearInterval(interval);
      await current;
    },
  };
}

export async function attachInitialGatewayLifetimeSidecars(params: {
  scheduler: GatewayScheduler;
  chatMetadataLifecycle: GatewayChatMetadataLifecycle;
  gatewayRequestContext: GatewayRequestContext;
  flushPendingSessionsChangedEvents: (context?: object) => Promise<void>;
  minimalTestGateway: boolean;
  logWarning: (message: string) => void;
  reconcileGitHubPublications?: () => Promise<void>;
  publishSidecars: GatewaySidecarStopOwner["publish"];
}): Promise<void> {
  // Kernel preparation precedes HTTP/internal dispatch. Incognito has no restart inventory.
  params.publishSidecars(
    startIncognitoSessionLifetime({
      scheduler: params.scheduler,
      context: params.gatewayRequestContext,
      logWarning: params.logWarning,
    }),
  );
  await params.chatMetadataLifecycle.attachContext(
    params.gatewayRequestContext,
    params.publishSidecars,
  );
  const modelAccountConnect = createModelAccountConnectService({
    getConfig: params.gatewayRequestContext.getRuntimeConfig,
    onChanged: () => broadcastChatMetadataChanged(params.gatewayRequestContext),
  });
  params.gatewayRequestContext.modelAccountConnectService = modelAccountConnect;
  params.publishSidecars({
    stop: async () => {
      await modelAccountConnect.stop();
      if (params.gatewayRequestContext.modelAccountConnectService === modelAccountConnect) {
        delete params.gatewayRequestContext.modelAccountConnectService;
      }
    },
  });
  const githubOAuth = createGitHubOAuthLifecycle({
    scheduler: params.scheduler,
    getConfig: params.gatewayRequestContext.getRuntimeConfig,
    getPersistedConfig: () => getRuntimeConfig({ pin: false }),
    warn: params.logWarning,
  });
  params.gatewayRequestContext.githubOAuthService = githubOAuth;
  const uninstallGitHubOAuth = installActiveGitHubOAuthLifecycle(githubOAuth);
  if (!params.minimalTestGateway) {
    githubOAuth.start();
  }
  params.publishSidecars({
    stop: async () => {
      uninstallGitHubOAuth();
      await githubOAuth.stop();
      if (params.gatewayRequestContext.githubOAuthService === githubOAuth) {
        delete params.gatewayRequestContext.githubOAuthService;
      }
    },
  });
  if (!params.minimalTestGateway) {
    let warned = false;
    params.publishSidecars(
      params.scheduler.schedule({
        id: "maintenance:secret-expiry",
        atMs: params.scheduler.now(),
        everyMs: 60_000,
        run: () =>
          purgeExpiredSecretStoreEntries()
            .then(() => {
              warned = false;
            })
            .catch(() => {
              if (!warned) {
                params.logWarning("Secret store expiry cleanup failed; will retry.");
                warned = true;
              }
            }),
      }),
    );
  }
  if (params.reconcileGitHubPublications) {
    params.publishSidecars(
      startGitHubPublicationMaintenance(params.reconcileGitHubPublications, params.logWarning),
    );
  }
  attachSessionChangeEventLifetime(params.gatewayRequestContext, () =>
    params.publishSidecars({
      stop: async () => {
        await params.flushPendingSessionsChangedEvents(params.gatewayRequestContext);
      },
    }),
  );
}
