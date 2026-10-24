import { AsyncLocalStorage } from "node:async_hooks";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
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
import { readAgentDatabaseAdmissionRefusal } from "../state/agent-database-admission.js";
import { listGatewayAgentsBasic } from "./agent-list.js";

/** Committed publications feed the existing worker queue even when no report is open. */
export function startSessionCostUsageProjectionLifetime(params: {
  getConfig: () => OpenClawConfig;
  warn: (message: string) => void;
}) {
  // Publications can borrow startup admission; projection work keeps its own context.
  const inOwnerContext = AsyncLocalStorage.snapshot();
  const work = new AsyncWorkScope();
  const refreshAgent = (
    agentId: string,
    storePath?: string,
    sessionFiles?: string[],
    coalesce = false,
  ) =>
    inOwnerContext(() => {
      if (work.isClosing || readAgentDatabaseAdmissionRefusal(agentId)) {
        return;
      }
      const config = params.getConfig();
      work.run(() =>
        requestCostUsageCacheRefresh({
          config,
          agentId,
          storePath: storePath ?? resolveSessionStorePathForScope({ agentId }, config),
          sessionFiles,
          coalesce,
        }),
      );
    });
  const refreshAgents = (agentId?: string) =>
    inOwnerContext(() => {
      if (work.isClosing) {
        return;
      }
      void work
        .track(async () => {
          const { agents } = await listGatewayAgentsBasic(params.getConfig());
          for (const agent of agents) {
            if (agentId === undefined || agent.id === agentId) {
              refreshAgent(agent.id);
            }
          }
        })
        .catch((error: unknown) => {
          if (!work.isClosing) {
            params.warn(`Usage projection backfill could not start: ${String(error)}`);
          }
        });
    });
  const offTranscript = onInternalSessionTranscriptUpdate((update) => {
    const target = update.target;
    if (!target || isIncognitoSessionKey(target.sessionKey)) {
      return;
    }
    // User/metadata rows join the next usage scan; unqualified publications can
    // represent rewrites or compaction and must still invalidate the projection.
    if (isRecord(update.message) && !update.message.usage) {
      const role = update.message.role;
      if (role === "user" || role === "system" || role === "toolResult" || role === "custom") {
        return;
      }
    }
    const storePath =
      target.storePath ??
      resolveSessionStorePathForScope(
        { agentId: target.agentId, sessionKey: target.sessionKey },
        params.getConfig(),
      );
    refreshAgent(
      target.agentId,
      storePath,
      [update.sessionFile ?? formatSqliteSessionFileMarker({ ...target, storePath })],
      true,
    );
  });
  const offRows = sessionChanges.subscribeFacts((change) => {
    if ("all" in change) {
      if (
        change.scope === "config" ||
        change.scope === "stores" ||
        typeof change.scope === "object"
      ) {
        const scope = change.scope;
        // Default stores are agent-local; custom selectors can share physical storage.
        const agentId =
          !change.factsInvalidated &&
          typeof scope === "object" &&
          scope.topology === true &&
          scope.storePath === undefined &&
          !params.getConfig().session?.store
            ? scope.agentId
            : undefined;
        refreshAgents(agentId);
      }
    } else if (
      change.facts?.kind === "removed" &&
      !change.facts.transcriptInventoryUnchanged &&
      !isIncognitoSessionKey(change.sessionKey)
    ) {
      if (change.agentId) {
        refreshAgent(change.agentId, change.storePath);
      } else {
        refreshAgents();
      }
    }
  });
  let pricingRevision = getActiveRemoteModelCatalog(params.getConfig())?.revision;
  const offModels = registerPreparedModelRuntimePublicationListener((event) => {
    if (event.phase === "published" || event.phase === "catalog-published") {
      const next = getActiveRemoteModelCatalog(params.getConfig())?.revision;
      if (next === pricingRevision) {
        return;
      }
      pricingRevision = next;
      refreshAgents();
    }
  });
  // The same queue bounds startup and incremental batches and publishes partial progress.
  refreshAgents();
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
