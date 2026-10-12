/** Polls watched adopted sessions for direct upstream human activity. */
import { createHash } from "node:crypto";
import { isEmbeddedAgentRunActive } from "../agents/embedded-agent.js";
import { allowsProcessHomeSessionScan } from "../config/paths.js";
import type { loadSessionEntryReadOnly } from "../config/sessions/session-accessor.js";
import { withSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import { resolveSessionStorePathForScope } from "../config/sessions/session-store-path.js";
import { readRecentUserAssistantTextForSession } from "../config/sessions/transcript.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { GatewayScheduler } from "../infra/gateway-scheduler.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getPluginRegistryState } from "../plugins/runtime-state.js";
import type { SessionCatalogProvider, SessionUpstreamProbe } from "../plugins/session-catalog.js";
import type { OpenClawStateDatabaseOptions } from "../state/openclaw-state-db.js";
import {
  recordSessionHumanDirectMessage,
  recordSessionStateEventAsync,
} from "./session-state-events.js";
import { settleSessionUpstreamLink } from "./session-upstream-links-runtime.js";
import { listWatchedSessionUpstreamLinks } from "./session-upstream-links.js";

const SESSION_UPSTREAM_MONITOR_INTERVAL_MS = 60_000;
const SESSION_UPSTREAM_MONITOR_INITIAL_DELAY_MS = 15_000;
const SESSION_UPSTREAM_OWN_USER_TEXT_LIMIT = 10;
const SESSION_UPSTREAM_MISSING_THRESHOLD = 3;

const log = createSubsystemLogger("sessions/upstream-monitor");

type SessionUpstreamMonitorOptions = OpenClawStateDatabaseOptions & {
  providers?: readonly SessionCatalogProvider[];
  now?: () => number;
  signal?: AbortSignal;
  loadEntry?: typeof loadSessionEntryReadOnly;
  isRunActive?: typeof isEmbeddedAgentRunActive;
  loadOwnRecentUserTexts?: (params: {
    entry: SessionEntry;
    probe: Omit<SessionUpstreamProbe, "ownRecentUserTexts">;
  }) => Promise<string[]>;
};

type SessionUpstreamMonitor = { stop: () => Promise<void> };

type SessionUpstreamMissingCounter = {
  count: number;
  linkUpdatedAt: number;
};

// Stable identity of the physical upstream source (host/thread/ref). A re-Continue
// can rebase a session onto a new source whose activity ids (e.g. Claude byte
// offsets) collide with the old source; hashing this into dedupe keys and the CAS
// keeps those from silently deduping genuine new activity or accepting a stale scan.
function upstreamSourceKey(
  probe: Pick<SessionUpstreamProbe, "hostId" | "threadId" | "upstreamRef">,
): string {
  return createHash("sha256")
    .update(`${probe.hostId}\u0000${probe.threadId}\u0000${JSON.stringify(probe.upstreamRef)}`)
    .digest("hex")
    .slice(0, 16);
}

function upstreamMonitorLinkKey(
  probe: Pick<
    SessionUpstreamProbe,
    "sessionKey" | "agentId" | "hostId" | "threadId" | "upstreamRef"
  >,
): string {
  return `${probe.sessionKey}\n${probe.agentId}\n${upstreamSourceKey(probe)}`;
}

function assertMonitorCurrent(options: SessionUpstreamMonitorOptions): void {
  options.signal?.throwIfAborted();
}

function isIdleSession(
  entry: SessionEntry | undefined,
  options: SessionUpstreamMonitorOptions,
): boolean {
  return Boolean(
    !options.signal?.aborted &&
    entry?.sessionId &&
    !(options.isRunActive ?? isEmbeddedAgentRunActive)(entry.sessionId),
  );
}

async function loadProbeSession(
  probe: Pick<SessionUpstreamProbe, "sessionKey" | "agentId">,
  options: SessionUpstreamMonitorOptions,
): Promise<SessionEntry | undefined> {
  assertMonitorCurrent(options);
  const scope = {
    sessionKey: probe.sessionKey,
    agentId: probe.agentId,
    clone: false,
    env: options.env,
  };
  const loadEntry = options.loadEntry;
  const entry = loadEntry
    ? loadEntry(scope)
    : await withSessionEntryReadOnlyInWorker(
        scope,
        () => assertMonitorCurrent(options),
        async (read) => {
          if (!read.ok) {
            throw read.error;
          }
          return read.value;
        },
      );
  return entry;
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
  return recent.map((item) => item.text.trim().replace(/\s+/g, " ")).filter(Boolean);
}

async function runSessionUpstreamMonitorTick(
  options: SessionUpstreamMonitorOptions = {},
  missingCounts: Map<string, SessionUpstreamMissingCounter> = new Map(),
): Promise<void> {
  if (options.signal?.aborted) {
    return;
  }
  const dbOptions = {
    ...(options.env ? { env: options.env } : {}),
    ...(options.path ? { path: options.path } : {}),
  };
  const linksByCatalog = await listWatchedSessionUpstreamLinks(dbOptions);
  if (options.signal?.aborted) {
    return;
  }
  const watchedLinkKeys = new Set(
    [...linksByCatalog.values()].flatMap((links) => links.map(upstreamMonitorLinkKey)),
  );
  // Monitor-owned counters must follow the watched-link lifecycle or churn would leak keys.
  for (const key of missingCounts.keys()) {
    if (!watchedLinkKeys.has(key)) {
      missingCounts.delete(key);
    }
  }
  const providers =
    options.providers ??
    (getPluginRegistryState()?.activeRegistry?.sessionCatalogs ?? []).map(
      (registration) => registration.provider,
    );
  const providerById = new Map(providers.map((provider) => [provider.id, provider]));
  for (const [catalogId, links] of linksByCatalog) {
    const provider = providerById.get(catalogId);
    if (!provider?.checkUpstreamActivity) {
      continue;
    }
    const probes: SessionUpstreamProbe[] = [];
    const sessionBySessionKey = new Map<string, SessionEntry>();
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
        const session = await loadProbeSession(probe, options);
        // Active runs may still append upstream user items. Defer the scan so their
        // marker remains available for positive transcript-provenance matching.
        if (!session || !isIdleSession(session, options)) {
          continue;
        }
        const ownRecentUserTexts = await loadOwnRecentUserTexts(probe, session, options);
        if (options.signal?.aborted) {
          return;
        }
        probes.push({
          ...probe,
          ownRecentUserTexts,
        });
        sessionBySessionKey.set(probe.sessionKey, session);
      } catch (error) {
        log.warn(`upstream transcript provenance failed for ${probe.sessionKey}: ${String(error)}`);
      }
    }
    if (probes.length === 0) {
      continue;
    }
    const probeBySessionKey = new Map(probes.map((probe) => [probe.sessionKey, probe]));
    const linkBySessionKey = new Map(links.map((link) => [link.sessionKey, link]));
    try {
      const outcomes = await provider.checkUpstreamActivity(probes, {
        allowProcessHomeFallback: allowsProcessHomeSessionScan(options.env ?? process.env),
      });
      if (options.signal?.aborted) {
        return;
      }
      const missingSessionKeys = new Set(
        outcomes
          .filter((outcome) => outcome.kind === "missing")
          .map((outcome) => outcome.sessionKey),
      );
      for (const probe of probes) {
        if (!missingSessionKeys.has(probe.sessionKey)) {
          missingCounts.delete(upstreamMonitorLinkKey(probe));
        }
      }
      for (const outcome of outcomes) {
        const probe = probeBySessionKey.get(outcome.sessionKey);
        const session = sessionBySessionKey.get(outcome.sessionKey);
        const currentLink = linkBySessionKey.get(outcome.sessionKey);
        if (!probe || !session || !currentLink) {
          continue;
        }
        try {
          const expectedUpdatedAt = currentLink.updatedAt;
          // Activity is advisory bookkeeping. One idle check after provider I/O is
          // sufficient; a run starting after this point is observed by the next tick.
          const currentSession = await loadProbeSession(probe, options);
          if (!currentSession || currentSession.sessionId !== session.sessionId) {
            missingCounts.delete(upstreamMonitorLinkKey(probe));
            continue;
          }
          if (!isIdleSession(currentSession, options)) {
            continue;
          }
          const admission = { assertCurrent: () => assertMonitorCurrent(options) };
          const missingCountKey = upstreamMonitorLinkKey(probe);
          if (outcome.kind === "missing") {
            const previous = missingCounts.get(missingCountKey);
            const missingCount = Math.min(
              SESSION_UPSTREAM_MISSING_THRESHOLD,
              (previous?.linkUpdatedAt === expectedUpdatedAt ? previous.count : 0) + 1,
            );
            missingCounts.set(missingCountKey, {
              count: missingCount,
              linkUpdatedAt: expectedUpdatedAt,
            });
            if (missingCount < SESSION_UPSTREAM_MISSING_THRESHOLD) {
              continue;
            }
            const sourceKey = upstreamSourceKey(probe);
            const recorded = await recordSessionStateEventAsync(
              {
                sessionKey: probe.sessionKey,
                agentId: probe.agentId,
                kind: "upstream_missing",
                actorType: "system",
                dedupeKey: `upstream-missing:${probe.sessionKey}:${sourceKey}:${currentLink.updatedAt}`,
                summary: `upstream missing via ${catalogId}`,
                payload: { channel: catalogId },
              },
              {
                ...dbOptions,
                now: (options.now ?? Date.now)(),
                ...admission,
                expectedUpstream: currentLink,
              },
            );
            if (!recorded) {
              missingCounts.set(missingCountKey, {
                count: SESSION_UPSTREAM_MISSING_THRESHOLD - 1,
                linkUpdatedAt: expectedUpdatedAt,
              });
              continue;
            }
            if (
              await settleSessionUpstreamLink(
                currentLink,
                { kind: "missing" },
                { ...dbOptions, ...admission },
              )
            ) {
              missingCounts.delete(missingCountKey);
            }
            continue;
          }
          missingCounts.delete(missingCountKey);
          const activity = outcome;
          if (!Number.isSafeInteger(activity.humanTurns) || activity.humanTurns < 0) {
            continue;
          }
          if (activity.humanTurns === 0) {
            await settleSessionUpstreamLink(
              currentLink,
              { kind: "activity", marker: activity.nextMarker, now: (options.now ?? Date.now)() },
              { ...dbOptions, ...admission },
            );
            continue;
          }
          if (!Number.isFinite(activity.occurredAt) || !activity.dedupeId) {
            continue;
          }
          const recorded = await recordSessionHumanDirectMessage(
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
            {
              ...dbOptions,
              now: (options.now ?? Date.now)(),
              expectedUpstream: currentLink,
              ...admission,
            },
          );
          if (recorded) {
            // A failed or uncertain event insert never consumes the upstream marker.
            await settleSessionUpstreamLink(
              currentLink,
              { kind: "activity", marker: activity.nextMarker, now: (options.now ?? Date.now)() },
              { ...dbOptions, ...admission },
            );
          }
        } catch (error) {
          log.warn(`upstream settlement failed for ${probe.sessionKey}: ${String(error)}`);
        }
      }
    } catch (error) {
      log.warn(`upstream activity check failed for ${catalogId}: ${String(error)}`);
    }
  }
}

export function startSessionUpstreamMonitor(
  options: SessionUpstreamMonitorOptions & { scheduler: GatewayScheduler },
): SessionUpstreamMonitor {
  const { scheduler } = options;
  let running: Promise<void> | undefined;
  const lifecycle = scheduler.scope();
  const tickOptions = {
    ...options,
    now: options.now ?? (() => scheduler.now()),
    signal: options.signal ? AbortSignal.any([lifecycle.signal, options.signal]) : lifecycle.signal,
  };
  const missingCounts = new Map<string, SessionUpstreamMissingCounter>();
  const run = () => {
    if (lifecycle.signal.aborted || running) {
      return undefined;
    }
    running = runSessionUpstreamMonitorTick(tickOptions, missingCounts)
      .catch((error: unknown) => {
        log.warn(`upstream monitor tick failed: ${String(error)}`);
      })
      .finally(() => {
        running = undefined;
      });
    return running;
  };
  // Session catalogs own this bounded freshness exception; plugin metadata remains restart-stable.
  lifecycle.schedule({
    id: "sessions:upstream-initial-probe",
    delayMs: SESSION_UPSTREAM_MONITOR_INITIAL_DELAY_MS,
    run,
  });
  lifecycle.schedule({
    id: "sessions:upstream-monitor",
    delayMs: SESSION_UPSTREAM_MONITOR_INTERVAL_MS,
    everyMs: SESSION_UPSTREAM_MONITOR_INTERVAL_MS,
    run,
  });
  return {
    stop: () => lifecycle.stop(),
  };
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.sessionUpstreamMonitorTestApi")
  ] = { runSessionUpstreamMonitorTick };
}
