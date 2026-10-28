import { createEffect, createMemo, onCleanup } from "solid-js";
import type { SessionCatalogPullRequestSummary } from "../../../packages/gateway-protocol/src/schema/sessions-catalog.js";
import { SESSION_PULL_REQUESTS_SUBSCRIBE_METHOD } from "../../../src/gateway/control-ui-contract.js";
import { operatorScopeSatisfied } from "../../../src/shared/operator-scope-compat.js";
import { gatewayPresentationScope } from "../app/gateway-presentation-scope.ts";
import type { ApplicationGateway } from "../app/gateway.ts";
import { canCallGatewayMethod } from "../lib/gateway-methods.ts";
import { createParkedProjection } from "../lib/reactive/parked-projection.ts";
import { projectSource } from "../lib/reactive/projection.ts";
import {
  summarizeSessionPullRequests,
  sessionPullRequestsForGateway,
} from "../lib/session-pull-requests.ts";
import type { SessionCapability } from "../lib/sessions/index.ts";
import { parseAgentSessionKey, scopedSessionArtifactKey } from "../lib/sessions/session-key.ts";
import type { SidebarRecentSession } from "./app-sidebar-session-types.ts";

type IndicatorEntry = {
  summary: SessionCatalogPullRequestSummary | undefined;
  worktreeId: string;
  count: number | undefined;
  branchKnown: boolean;
};

/** Passive row projections; the shared store owns snapshots and checkout subscriptions. */
export function createSessionPullRequestIndicators(options: {
  getConnected: () => boolean;
  getPresented: () => boolean;
  getRows: () => readonly SidebarRecentSession[];
  getSelectedAgentId: () => string;
  getGateway: () => ApplicationGateway | undefined;
  getSessions: () => SessionCapability | undefined;
}) {
  // Any admitted reader projects the shared store; the store itself issues passive sidebar reads only
  // for broad readers, so a session-only reader sees snapshots its own conversation read delivered.
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
  const broadRead = () => {
    const gateway = options.getGateway();
    return Boolean(
      gateway &&
      operatorScopeSatisfied("operator.read", gateway.snapshot.hello?.auth?.scopes ?? []),
    );
  };
  const rows = createMemo(() => options.getRows().filter((row) => !row.isChild));
  const scope = createMemo(
    () => {
      const gateway = readable();
      // Losing or gaining broad read rebinds the store so passive snapshots never outlive their scope.
      return gateway && options.getConnected()
        ? {
            gateway,
            client: gateway.snapshot.client,
            agentId: options.getSelectedAgentId(),
            sessions: options.getSessions(),
            broad: broadRead(),
          }
        : null;
    },
    {
      equals: (a, b) =>
        a?.gateway === b?.gateway &&
        a?.broad === b?.broad &&
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
        } else if (
          snapshot &&
          (snapshot.status === "ready" ||
            snapshot.pullRequests.length ||
            snapshot.taskPullRequests?.length)
        ) {
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
        if (
          !snapshot.discardPrevious &&
          snapshot.status !== "ready" &&
          snapshot.pullRequests.length === 0 &&
          !snapshot.taskPullRequests?.length
        ) {
          if (prior) {
            entries.set(row.key, prior);
          }
          continue;
        }
        const branchKnown =
          snapshot.discardPrevious ||
          snapshot.branchRead !== false ||
          snapshot.pullRequestCount !== undefined ||
          snapshot.pullRequests.length > 0 ||
          (prior?.worktreeId === (row.worktreeId ?? "") && prior.branchKnown);
        entries.set(row.key, {
          summary: summarizeSessionPullRequests(
            [
              ...snapshot.pullRequests,
              ...(snapshot.taskPullRequests ?? []).flatMap((task) =>
                task.pullRequest ? [task.pullRequest] : [],
              ),
            ],
            prior?.summary,
          ),
          worktreeId: row.worktreeId ?? "",
          branchKnown,
          count:
            !branchKnown && snapshot.pullRequests.length === 0 && !snapshot.taskPullRequestCount
              ? undefined
              : (snapshot.pullRequestCount ??
                Math.max(
                  new Set(
                    [...snapshot.pullRequests, ...(snapshot.taskPullRequests ?? [])].map(
                      (request) => request.url,
                    ),
                  ).size,
                  snapshot.taskPullRequestCount ?? 0,
                )),
        });
      }
    }
    return { binding: current, entries };
  });
  const presentation = createParkedProjection(
    () => ({ readable: Boolean(readable()), broad: broadRead(), entries: summaries().entries }),
    // Keep the last rendered facts during link loss; live watch admission remains above.
    () => options.getPresented() && options.getConnected(),
    () => {
      const gateway = options.getGateway();
      return gateway ? gatewayPresentationScope(gateway).key : undefined;
    },
  );
  return {
    count(sessionKey: string) {
      const current = presentation();
      return current.readable ? current.entries.get(sessionKey)?.count : undefined;
    },
    summary(sessionKey: string, worktreeId: string, initial?: SessionCatalogPullRequestSummary) {
      const current = presentation();
      if (!current.readable) {
        // Catalog-only rows already carry an authorized summary; live PR access is separate.
        return worktreeId ? undefined : initial;
      }
      // A session-only reader shows catalog facts for a checkout row only when its own read confirmed them.
      const catalogSummary = current.broad || !worktreeId ? initial : undefined;
      const entry = current.entries.get(sessionKey);
      // Receipt-only hydration says nothing about a catalog branch summary.
      return entry?.worktreeId === worktreeId
        ? (entry.summary ?? (!entry.branchKnown ? catalogSummary : undefined))
        : catalogSummary;
    },
  };
}

export type SessionPullRequestIndicators = ReturnType<typeof createSessionPullRequestIndicators>;
