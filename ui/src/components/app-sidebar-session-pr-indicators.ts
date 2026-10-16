import { createEffect, createMemo, onCleanup } from "solid-js";
import type { SessionCatalogPullRequestSummary } from "../../../packages/gateway-protocol/src/schema/sessions-catalog.js";
import type { ApplicationGateway } from "../app/gateway.ts";
import { canCallGatewayMethod } from "../lib/gateway-methods.ts";
import { createParkedProjection } from "../lib/reactive/parked-projection.ts";
import { projectSource } from "../lib/reactive/projection.ts";
import {
  summarizeSessionPullRequests,
  SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
  sessionPullRequestsForGateway,
} from "../lib/session-pull-requests.ts";
import type { SessionCapability } from "../lib/sessions/index.ts";
import { parseAgentSessionKey, scopedSessionArtifactKey } from "../lib/sessions/session-key.ts";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";

type IndicatorEntry = {
  summary: SessionCatalogPullRequestSummary | undefined;
  worktreeId: string;
};

type SessionPullRequestIndicatorsOptions = {
  getConnected: () => boolean;
  getPresented: () => boolean;
  getRows: () => readonly SidebarRecentSession[];
  getSelectedAgentId: () => string;
  getGateway: () => ApplicationGateway | undefined;
  getSessions: () => SessionCapability | undefined;
};

/** Passive row projections; the shared store owns snapshots and checkout subscriptions. */
export function createSessionPullRequestIndicators(options: SessionPullRequestIndicatorsOptions) {
  const readable = () => {
    const gateway = options.getGateway();
    return gateway &&
      canCallGatewayMethod(
        gateway.snapshot,
        SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD,
        "operator.read",
      )
      ? gateway
      : null;
  };
  const rows = createMemo(() => options.getRows().filter((row) => !row.isChild && row.worktreeId));
  const scope = createMemo(
    () => {
      const gateway = readable();
      return gateway && options.getConnected()
        ? {
            gateway,
            client: gateway.snapshot.client,
            agentId: options.getSelectedAgentId(),
            sessions: options.getSessions(),
          }
        : null;
    },
    {
      equals: (a, b) =>
        a?.gateway === b?.gateway &&
        a?.client === b?.client &&
        a?.agentId === b?.agentId &&
        a?.sessions === b?.sessions,
    },
  );
  const binding = createMemo(() => {
    const current = scope();
    if (!current) {
      return null;
    }
    const store = sessionPullRequestsForGateway(current.gateway);
    const watchOwner = {};
    const scopedKey = (key: string) =>
      scopedSessionArtifactKey(key, parseAgentSessionKey(key)?.agentId ?? current.agentId);
    let visible: readonly SidebarRecentSession[] = [];
    // These receipts preserve synchronous canonical invalidation, not presentation state.
    const seen = new Set<string>();
    const reconcileRemoved = () => {
      for (const row of visible) {
        const snapshot = store.get(scopedKey(row.key));
        if (!snapshot && seen.delete(row.key)) {
          const sessions = current.sessions;
          sessions?.setPullRequestSummary(
            row.key,
            undefined,
            sessions.capturePullRequestEpoch(row.key),
          );
        } else if (snapshot && (snapshot.status === "ready" || snapshot.pullRequests.length)) {
          seen.add(row.key);
        }
      }
    };
    const projection = projectSource(store, {
      read: (source) => source,
      subscribe: (source, notify) =>
        source.subscribe(() => {
          reconcileRemoved();
          notify();
        }),
      equality: "revision",
    });
    onCleanup(() => {
      projection.dispose();
      store.unwatch(watchOwner);
    });
    return {
      projection,
      scopedKey,
      watch(next: readonly SidebarRecentSession[]) {
        visible = next;
        const keys = new Set(next.map((row) => row.key));
        for (const key of seen) {
          if (!keys.has(key)) {
            seen.delete(key);
          }
        }
        store.watch(
          watchOwner,
          next.map((row) => scopedKey(row.key)),
          { passive: true },
        );
        reconcileRemoved();
      },
    };
  });
  // The external store's watch union follows committed visible rows; it never starts checkout polling.
  createEffect(
    () => {
      const current = binding();
      // Custody stays live while parked presentation drops its source dependencies.
      current?.projection.revision();
      return [current, rows()];
    },
    ([current, visible]) => current?.watch(visible),
  );
  const summaries = createMemo<{
    binding: ReturnType<typeof binding>;
    entries: Map<string, IndicatorEntry>;
  }>((previous) => {
    const current = binding();
    const entries = new Map<string, IndicatorEntry>();
    if (current) {
      const store = current.projection.read();
      for (const row of rows()) {
        const snapshot = store.get(current.scopedKey(row.key));
        const prior = previous?.binding === current ? previous.entries.get(row.key) : undefined;
        if (!snapshot) {
          continue;
        }
        if (snapshot.status !== "ready" && snapshot.pullRequests.length === 0) {
          if (prior) {
            entries.set(row.key, prior);
          }
          continue;
        }
        entries.set(row.key, {
          summary: summarizeSessionPullRequests(snapshot.pullRequests, prior?.summary),
          worktreeId: row.worktreeId!,
        });
      }
    }
    return { binding: current, entries };
  });
  const presentation = createParkedProjection(
    () => ({ readable: Boolean(readable()), entries: summaries().entries }),
    options.getPresented,
  );
  return {
    summary(sessionKey: string, worktreeId: string, initial?: SessionCatalogPullRequestSummary) {
      const current = presentation();
      if (!current.readable) {
        return undefined;
      }
      const entry = current.entries.get(sessionKey);
      // Ready-empty is authoritative; only seed rows before their first snapshot.
      return entry?.worktreeId === worktreeId ? entry.summary : initial;
    },
  };
}

export type SessionPullRequestIndicators = ReturnType<typeof createSessionPullRequestIndicators>;
