import type { OpenClawConfig } from "../config/types.openclaw.js";
import { onSessionCostUsageUpdated } from "../infra/session-cost-usage-events.js";
import type { createSubsystemLogger } from "../logging/subsystem.js";
import { isSessionStoreTopologyChange, sessionChanges } from "../sessions/session-row-changes.js";
import type { SessionCostUsagePublication } from "../shared/usage-types.js";
import { modelSelectionPoliciesMatch } from "./operator-model-presentation.js";
import { onOperatorRolePolicyChanged } from "./operator-role-policy.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import type { GatewaySidecarStopOwner } from "./server-sidecar-owners.js";
import { invalidateSharedReadResponses } from "./shared-read-responses.js";

type GatewayLogger = ReturnType<typeof createSubsystemLogger>;

/** A committed auth change remains successful even if its best-effort UI notification fails. */
export function broadcastChatMetadataChanged(
  context: Pick<GatewayRequestContext, "broadcast" | "logGateway">,
  payload: Partial<SessionCostUsagePublication> & {
    modelSelectionChanged?: boolean;
    modelCatalogChanged?: boolean;
    authChanged?: boolean;
  } = {},
): void {
  try {
    context.broadcast("chat.metadata.changed", payload, { dropIfSlow: true });
  } catch {
    context.logGateway.warn("chat metadata change notification failed");
  }
}

export async function createGatewayChatMetadataLifecycle(params: {
  getConfig: () => OpenClawConfig;
  log: GatewayLogger;
}) {
  let context: GatewayRequestContext | undefined;
  let preparedModelRuntimeState: "unobserved" | "available" | "unavailable" = "unobserved";
  let preparedModelRuntimeEventVersion = 0;
  const { createGatewayChatMetadataRuntime } =
    await import("./server-methods/chat-metadata-runtime.js");
  const { ChatMetadataSnapshotUnavailableError } =
    await import("./server-methods/chat-metadata-facts.js");
  const runtime = createGatewayChatMetadataRuntime({
    getConfig: params.getConfig,
    getContext: () => {
      if (!context) {
        throw new Error("gateway request context is unavailable during chat metadata preparation");
      }
      return context;
    },
    onChanged: (change) => {
      if (context) {
        broadcastChatMetadataChanged(context, change);
      }
    },
    log: params.log,
  });
  const refreshLogged = (notifyIfUnchanged = false) => {
    void runtime.refresh({ notifyIfUnchanged }).catch((error: unknown) => {
      params.log.warn(`chat metadata refresh failed: ${String(error)}`);
    });
  };
  const refreshForSubordinateChange = (notifyIfUnchanged = false) => {
    if (context) {
      invalidateSharedReadResponses(context.broadcast, "chat.metadata.changed");
    }
    // Auth and skill facts are subordinate to the prepared model owner. During replacement the
    // publication event owns the one catch-up refresh after every related fact is committed.
    if (preparedModelRuntimeState === "available") {
      // The metadata owner compares captured facts before fencing changed generations.
      // Unrelated workspace events and repeated catalog statuses must not discard its cache.
      refreshLogged(notifyIfUnchanged);
    }
  };
  const registerRefreshListeners = async (): Promise<() => void> => {
    const [
      { registerRuntimeAuthProfileStoreMutationListener },
      { registerPreparedModelRuntimePublicationListener },
      { registerSkillsChangeListener },
    ] = await Promise.all([
      import("../agents/auth-profiles/runtime-snapshots.js"),
      import("../agents/prepared-model-runtime.js"),
      import("../skills/runtime/refresh.js"),
    ]);
    const unregisterPreparedModelRuntimePublication =
      registerPreparedModelRuntimePublicationListener((event) => {
        if (
          event.phase === "catalog-status" ||
          (event.phase === "catalog-published" &&
            event.modelFactsChanged === false &&
            !event.refreshStatusChanged)
        ) {
          if (context) {
            invalidateSharedReadResponses(context.broadcast, "chat.metadata.changed");
          }
          return;
        }
        if (event.phase === "catalog-published" || event.phase === "catalog-failed") {
          refreshForSubordinateChange(
            event.phase === "catalog-published" && event.refreshStatusChanged === true,
          );
          return;
        }
        if (context) {
          invalidateSharedReadResponses(context.broadcast, "chat.metadata.changed");
        }
        preparedModelRuntimeEventVersion += 1;
        if (event.phase === "invalidated") {
          // Initial catch-up may already be building an owner published before attachment.
          // Later invalidations preserve the existing replacement wait or terminal failure.
          if (preparedModelRuntimeState !== "unavailable") {
            runtime.invalidate();
          }
          preparedModelRuntimeState = "unavailable";
          return;
        }
        if (event.phase === "failed") {
          preparedModelRuntimeState = "unavailable";
          runtime.fail(event.error);
          return;
        }
        preparedModelRuntimeState = "available";
        refreshLogged();
      });
    const unregisterSkillsChange = registerSkillsChangeListener((event) => {
      if (event.reason !== "watch-available") {
        refreshForSubordinateChange();
      }
    });
    const unregisterRuntimeAuthProfileStoreMutation =
      registerRuntimeAuthProfileStoreMutationListener(() => {
        refreshForSubordinateChange();
      });
    const unregisterTopology = sessionChanges.subscribe((change) => {
      if (isSessionStoreTopologyChange(change)) {
        refreshForSubordinateChange();
      }
    });
    return () => {
      unregisterTopology();
      unregisterRuntimeAuthProfileStoreMutation();
      unregisterPreparedModelRuntimePublication();
      unregisterSkillsChange();
    };
  };

  return {
    attachContext: async (
      next: GatewayRequestContext,
      publishSidecars: GatewaySidecarStopOwner["publish"],
    ) => {
      context = next;
      let selectionConfig = next.getCommittedRuntimeConfig?.() ?? params.getConfig();
      const unregister = await registerRefreshListeners();
      const unregisterUsage = onSessionCostUsageUpdated((publication) => {
        broadcastChatMetadataChanged(next, {
          ...publication,
          modelCatalogChanged: false,
          authChanged: false,
        });
      });
      const unregisterRolePolicy = onOperatorRolePolicyChanged((change) => {
        if (change.kind === "config" && change.context === next && context === next) {
          const config = next.getCommittedRuntimeConfig?.() ?? params.getConfig();
          const unchanged = modelSelectionPoliciesMatch(selectionConfig, config);
          selectionConfig = config;
          if (!unchanged) {
            broadcastChatMetadataChanged(next, { modelSelectionChanged: true });
          }
        }
      });
      publishSidecars({
        stop: async () => {
          unregisterUsage();
          unregisterRolePolicy();
          unregister();
          await runtime.stop();
        },
      });
      // Publications that complete before listener registration would otherwise be missed.
      // During ordinary startup the owner is published after attachment, so an unavailable
      // snapshot here is expected and the publication listener performs the first refresh.
      const eventVersion = preparedModelRuntimeEventVersion;
      await runtime.refresh().then(
        () => {
          // A successful catch-up proves availability when publication completed before the
          // listener was registered. Do not overwrite a newer invalidation or failure event.
          if (preparedModelRuntimeEventVersion === eventVersion) {
            preparedModelRuntimeState = "available";
          }
        },
        (error: unknown) => {
          if (!(error instanceof ChatMetadataSnapshotUnavailableError)) {
            // Capture reached a published owner before this later metadata build failed. Keep
            // stable auth/skill changes able to retry unless a newer owner event says otherwise.
            if (preparedModelRuntimeEventVersion === eventVersion) {
              preparedModelRuntimeState = "available";
            }
            params.log.warn(`chat metadata catch-up refresh failed: ${String(error)}`);
          }
        },
      );
    },
    read: runtime.read,
    readModelsList: runtime.readModelsList,
    readStartup: runtime.readStartup,
    refresh: runtime.refresh,
  };
}
