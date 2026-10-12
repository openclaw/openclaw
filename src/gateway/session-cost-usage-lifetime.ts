import { registerPreparedModelRuntimePublicationListener } from "../agents/prepared-model-runtime.publication-events.js";
import { formatSqliteSessionFileMarker } from "../config/sessions/legacy-sqlite-marker.js";
import { resolveSessionStorePathForScope } from "../config/sessions/session-store-path.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { requestCostUsageCacheRefresh } from "../infra/session-cost-usage-cache-runtime.js";
import { getActiveRemoteModelCatalog } from "../model-catalog/remote-overlay.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { onInternalSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { isIncognitoSessionKey } from "../shared/incognito-session-key.js";
import { listGatewayAgentsBasic } from "./agent-list.js";

/** Committed publications feed the existing worker queue even when no report is open. */
export function startSessionCostUsageProjectionLifetime(params: {
  getConfig: () => OpenClawConfig;
  warn: (message: string) => void;
}) {
  const work = new AsyncWorkScope();
  const refreshAgent = (agentId: string, storePath?: string, sessionFiles?: string[]) => {
    if (work.isClosing) {
      return;
    }
    const config = params.getConfig();
    work.run(() =>
      requestCostUsageCacheRefresh({
        config,
        agentId,
        storePath: storePath ?? resolveSessionStorePathForScope({ agentId }, config),
        sessionFiles,
      }),
    );
  };
  const refreshAll = () => {
    if (work.isClosing) {
      return;
    }
    void work
      .track(async () => {
        const { agents } = await listGatewayAgentsBasic(params.getConfig());
        for (const agent of agents) {
          refreshAgent(agent.id);
        }
      })
      .catch((error: unknown) => {
        if (!work.isClosing) {
          params.warn(`Usage projection backfill could not start: ${String(error)}`);
        }
      });
  };
  const offTranscript = onInternalSessionTranscriptUpdate((update) => {
    const target = update.target;
    if (!target || isIncognitoSessionKey(target.sessionKey)) {
      return;
    }
    const storePath =
      target.storePath ??
      resolveSessionStorePathForScope(
        { agentId: target.agentId, sessionKey: target.sessionKey },
        params.getConfig(),
      );
    refreshAgent(target.agentId, storePath, [
      update.sessionFile ?? formatSqliteSessionFileMarker({ ...target, storePath }),
    ]);
  });
  const offRows = sessionChanges.subscribeFacts((change) => {
    if ("all" in change) {
      if (
        change.scope === "config" ||
        change.scope === "stores" ||
        typeof change.scope === "object"
      ) {
        refreshAll();
      }
    } else if (change.facts?.kind === "removed" && !isIncognitoSessionKey(change.sessionKey)) {
      if (change.agentId) {
        refreshAgent(change.agentId, change.storePath);
      } else {
        refreshAll();
      }
    }
  });
  let pricingRevision = getActiveRemoteModelCatalog(params.getConfig(), false)?.revision;
  const offModels = registerPreparedModelRuntimePublicationListener((event) => {
    if (event.phase === "published" || event.phase === "catalog-published") {
      const next = getActiveRemoteModelCatalog(params.getConfig(), false)?.revision;
      if (next === pricingRevision) {
        return;
      }
      pricingRevision = next;
      refreshAll();
    }
  });
  // The same queue bounds startup and incremental batches and publishes partial progress.
  refreshAll();
  return {
    async stop() {
      offTranscript();
      offRows();
      offModels();
      work.beginClose();
      await work.drain();
    },
  };
}
