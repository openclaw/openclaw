/** Polls watched adopted sessions for direct upstream human activity. */
import { createHash } from "node:crypto";
import { isEmbeddedAgentRunActive } from "../agents/embedded-agent.js";
import { loadSessionEntry } from "../config/sessions/session-accessor.js";
import { resolveSessionStorePathForScope } from "../config/sessions/session-store-path.js";
import { readRecentUserAssistantTextForSession } from "../config/sessions/transcript.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getPluginRegistryState } from "../plugins/runtime-state.js";
import type { SessionCatalogProvider, SessionUpstreamProbe } from "../plugins/session-catalog.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import { recordSessionHumanDirectMessage } from "./session-state-events.js";
import {
  listWatchedSessionUpstreamLinks,
  readSessionUpstreamLink,
  updateSessionUpstreamLinkMarker,
} from "./session-upstream-links.js";

const SESSION_UPSTREAM_MONITOR_INTERVAL_MS = 60_000;
const SESSION_UPSTREAM_MONITOR_INITIAL_DELAY_MS = 15_000;
const SESSION_UPSTREAM_OWN_USER_TEXT_LIMIT = 10;

const log = createSubsystemLogger("sessions/upstream-monitor");

type SessionUpstreamMonitorOptions = OpenClawStateDatabaseOptions & {
  providers?: readonly SessionCatalogProvider[];
  now?: () => number;
  loadEntry?: typeof loadSessionEntry;
  isRunActive?: typeof isEmbeddedAgentRunActive;
  loadOwnRecentUserTexts?: (params: {
    entry: SessionEntry;
    probe: Omit<SessionUpstreamProbe, "ownRecentUserTexts">;
  }) => Promise<string[]>;
};

export type SessionUpstreamMonitor = { stop: () => void };

function currentProviders(): SessionCatalogProvider[] {
  return (getPluginRegistryState()?.activeRegistry?.sessionCatalogs ?? []).map(
    (registration) => registration.provider,
  );
}

function databaseOptions(options: SessionUpstreamMonitorOptions): OpenClawStateDatabaseOptions {
  return {
    ...(options.env ? { env: options.env } : {}),
    ...(options.path ? { path: options.path } : {}),
  };
}

function normalizeUserText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

// Stable identity of the physical upstream source (host/thread/ref). A re-Continue
// can rebase a session onto a new source whose activity ids (e.g. Claude byte
// offsets) collide with the old source; hashing this into dedupe keys and the CAS
// keeps those from silently deduping genuine new activity or accepting a stale scan.
function upstreamSourceKey(probe: {
  hostId: string;
  threadId: string;
  upstreamRef: unknown;
}): string {
  return createHash("sha256")
    .update(`${probe.hostId}\u0000${probe.threadId}\u0000${JSON.stringify(probe.upstreamRef)}`)
    .digest("hex")
    .slice(0, 16);
}

async function loadOwnRecentUserTexts(
  probe: Omit<SessionUpstreamProbe, "ownRecentUserTexts">,
  entry: SessionEntry,
  options: SessionUpstreamMonitorOptions,
): Promise<string[]> {
  if (options.loadOwnRecentUserTexts) {
    return await options.loadOwnRecentUserTexts({ entry, probe });
  }
  const storePath = resolveSessionStorePathForScope({
    agentId: probe.agentId,
    sessionKey: probe.sessionKey,
    ...(options.env ? { env: options.env } : {}),
  });
  const recent = await readRecentUserAssistantTextForSession({
    agentId: probe.agentId,
    sessionKey: probe.sessionKey,
    storePath,
    limit: SESSION_UPSTREAM_OWN_USER_TEXT_LIMIT,
    preferUpstreamUserText: true,
    role: "user",
  });
  return recent.map((item) => normalizeUserText(item.text)).filter(Boolean);
}

async function probeProvenanceUnchanged(
  probe: SessionUpstreamProbe,
  options: SessionUpstreamMonitorOptions,
): Promise<boolean> {
  const entry = (options.loadEntry ?? loadSessionEntry)({
    sessionKey: probe.sessionKey,
    agentId: probe.agentId,
    clone: false,
    ...(options.env ? { env: options.env } : {}),
  });
  if (!entry?.sessionId || (options.isRunActive ?? isEmbeddedAgentRunActive)(entry.sessionId)) {
    return false;
  }
  const current = await loadOwnRecentUserTexts(probe, entry, options);
  return (
    current.length === probe.ownRecentUserTexts.length &&
    current.every((text, index) => text === probe.ownRecentUserTexts[index])
  );
}

export async function runSessionUpstreamMonitorTick(
  options: SessionUpstreamMonitorOptions = {},
): Promise<void> {
  const dbOptions = databaseOptions(options);
  const linksByCatalog = listWatchedSessionUpstreamLinks(dbOptions);
  const providers = options.providers ?? currentProviders();
  const providerById = new Map(providers.map((provider) => [provider.id, provider]));
  for (const [catalogId, links] of linksByCatalog) {
    const provider = providerById.get(catalogId);
    if (!provider?.checkUpstreamActivity) {
      continue;
    }
    const probes: SessionUpstreamProbe[] = [];
    for (const link of links) {
      const probe = {
        sessionKey: link.sessionKey,
        agentId: link.agentId,
        threadId: link.threadId,
        hostId: link.hostId,
        upstreamKind: link.upstreamKind,
        upstreamRef: link.upstreamRef,
        marker: link.marker,
      } satisfies Omit<SessionUpstreamProbe, "ownRecentUserTexts">;
      // One corrupt session store must not reject the whole tick; skip that link only.
      try {
        const entry = (options.loadEntry ?? loadSessionEntry)({
          sessionKey: probe.sessionKey,
          agentId: probe.agentId,
          clone: false,
          ...(options.env ? { env: options.env } : {}),
        });
        // Active runs may still append upstream user items. Defer the scan so their
        // marker remains available for positive transcript-provenance matching.
        if (
          !entry?.sessionId ||
          (options.isRunActive ?? isEmbeddedAgentRunActive)(entry.sessionId)
        ) {
          continue;
        }
        probes.push({
          ...probe,
          ownRecentUserTexts: await loadOwnRecentUserTexts(probe, entry, options),
        });
      } catch (error) {
        log.warn(`upstream transcript provenance failed for ${probe.sessionKey}: ${String(error)}`);
      }
    }
    if (probes.length === 0) {
      continue;
    }
    const probeBySessionKey = new Map(probes.map((probe) => [probe.sessionKey, probe]));
    const linkUpdatedAtBySessionKey = new Map(
      links.map((link) => [link.sessionKey, link.updatedAt]),
    );
    try {
      const activities = await provider.checkUpstreamActivity(probes);
      for (const activity of activities) {
        const probe = probeBySessionKey.get(activity.sessionKey);
        if (!probe || !Number.isSafeInteger(activity.humanTurns) || activity.humanTurns < 0) {
          continue;
        }
        try {
          // A run can start while the provider is scanning. Recheck ownership and
          // provenance before any marker advance so its prompt remains deferred.
          if (!(await probeProvenanceUnchanged(probe, options))) {
            continue;
          }
        } catch (error) {
          log.warn(
            `upstream transcript provenance failed for ${probe.sessionKey}: ${String(error)}`,
          );
          continue;
        }
        // CAS guard AFTER the last await: a Continue can refresh this link (new
        // host/thread/source) while the scan or provenance check was in flight.
        // From here to the record the path is synchronous, so a stale scan can
        // neither record from the old source nor clobber the refreshed marker.
        const expectedUpdatedAt = linkUpdatedAtBySessionKey.get(activity.sessionKey);
        const currentLink = readSessionUpstreamLink(probe.sessionKey, probe.agentId, dbOptions);
        // Compare source identity too: a same-millisecond Continue can refresh the
        // row without changing updated_at, so the timestamp alone is not a reliable
        // optimistic lock.
        if (
          !currentLink ||
          currentLink.updatedAt !== expectedUpdatedAt ||
          upstreamSourceKey({
            hostId: currentLink.hostId,
            threadId: currentLink.threadId,
            upstreamRef: currentLink.upstreamRef,
          }) !== upstreamSourceKey(probe)
        ) {
          continue;
        }
        if (activity.humanTurns === 0) {
          updateSessionUpstreamLinkMarker(probe.sessionKey, probe.agentId, activity.nextMarker, {
            ...dbOptions,
            now: (options.now ?? Date.now)(),
            ...(expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt }),
          });
          continue;
        }
        if (!Number.isFinite(activity.occurredAt) || !activity.dedupeId) {
          continue;
        }
        const recorded = recordSessionHumanDirectMessage(
          {
            sessionKey: probe.sessionKey,
            agentId: probe.agentId,
            actor: { actorType: "human" },
            channel: catalogId,
            dedupeKey: `upstream:${probe.sessionKey}:${upstreamSourceKey(probe)}:${activity.dedupeId}`,
            ...(activity.humanTurns > 1 ? { payload: { turns: activity.humanTurns } } : {}),
            occurredAt: activity.occurredAt as number,
          },
          // Local clock for bookkeeping: upstream occurredAt is event history only
          // and is clamped inside the recorder against this same clock.
          { ...dbOptions, now: (options.now ?? Date.now)() },
        );
        if (!recorded) {
          continue;
        }
        // Commit the scan marker only after the durable event insert/dedupe succeeds.
        updateSessionUpstreamLinkMarker(probe.sessionKey, probe.agentId, activity.nextMarker, {
          ...dbOptions,
          now: (options.now ?? Date.now)(),
          ...(expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt }),
        });
      }
    } catch (error) {
      log.warn(`upstream activity probe failed for ${catalogId}: ${String(error)}`);
    }
  }
}

export function startSessionUpstreamMonitor(
  options: SessionUpstreamMonitorOptions = {},
): SessionUpstreamMonitor {
  let stopped = false;
  let running = false;
  const run = () => {
    if (stopped || running) {
      return;
    }
    running = true;
    void runSessionUpstreamMonitorTick(options)
      .catch((error: unknown) => {
        log.warn(`upstream monitor tick failed: ${String(error)}`);
      })
      .finally(() => {
        running = false;
      });
  };
  // Session catalogs own this bounded freshness exception; plugin metadata remains restart-stable.
  const initialTimer = setTimeout(run, SESSION_UPSTREAM_MONITOR_INITIAL_DELAY_MS);
  initialTimer.unref?.();
  const interval = setInterval(run, SESSION_UPSTREAM_MONITOR_INTERVAL_MS);
  interval.unref?.();
  return {
    stop: () => {
      stopped = true;
      clearTimeout(initialTimer);
      clearInterval(interval);
    },
  };
}
