import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { formatUiError } from "../../lib/format-error.ts";
import {
  childSessionListQuery,
  fetchChildSessionRows,
} from "../../lib/sessions/child-session-data.ts";
import type { SessionCapability, SessionListSnapshot } from "../../lib/sessions/index.ts";
import { isSubagentsPanelSession } from "./chat-spawned-subagent.ts";

type ChildList = {
  query: ReturnType<typeof childSessionListQuery> & { agentId?: string };
  rows: GatewaySessionRow[];
  snapshot?: SessionListSnapshot;
  observation?: ReturnType<SessionCapability["observeList"]>;
  pendingRead?: Promise<void>;
  error?: string;
};

export type SubagentsPanelChildrenSnapshot = {
  rows: Array<{ session: GatewaySessionRow; depth: number }>;
  loading: boolean;
  hasResult: boolean;
  error: string | null;
};

function incomplete(snapshot: SessionListSnapshot): boolean {
  const pagination = snapshot.pagination;
  return (
    (pagination?.hasMore ?? snapshot.result?.hasMore) ||
    (pagination?.totalCount !== undefined && pagination.count < pagination.totalCount)
  );
}

/** Owns the tab's paged child-list subscriptions; Details never instantiates this tree. */
export class SubagentsPanelChildren {
  private readonly lists = new Map<string, ChildList>();
  private applying = false;
  private disposed = false;
  private hasResult = false;

  constructor(
    private readonly sessions: SessionCapability,
    private readonly options: {
      query: ChildList["query"];
      includeDescendants: boolean;
      isCurrent: () => boolean;
      changed: (snapshot: SubagentsPanelChildrenSnapshot) => void;
    },
  ) {}

  start(): void {
    this.observe(this.options.query);
  }

  private current(list?: ChildList): boolean {
    return (
      !this.disposed &&
      this.options.isCurrent() &&
      (!list || this.lists.get(list.query.spawnedBy) === list)
    );
  }

  private observe(query: ChildList["query"]): ChildList {
    const list: ChildList = { query, rows: [] };
    this.lists.set(query.spawnedBy, list);
    list.observation = this.sessions.observeList(query, (snapshot) => {
      if (!this.current(list)) {
        return;
      }
      list.snapshot = snapshot;
      if (snapshot.error) {
        list.rows = [];
      } else if (snapshot.result && !incomplete(snapshot)) {
        list.error = undefined;
        list.rows = snapshot.result.sessions.filter(isSubagentsPanelSession);
      }
      this.publish();
      if (snapshot.result && incomplete(snapshot) && !snapshot.loading && !snapshot.error) {
        void this.read(list, snapshot.result);
      }
    });
    void this.read(list);
    return list;
  }

  private async read(list: ChildList, initialResult?: SessionsListResult): Promise<void> {
    if (list.pendingRead) {
      return list.pendingRead;
    }
    if (!this.current(list)) {
      return;
    }
    list.error = undefined;
    const pending = Promise.resolve()
      .then(async () => {
        if (!this.current(list)) {
          return;
        }
        await fetchChildSessionRows({
          sessions: this.sessions,
          parentKey: list.query.spawnedBy,
          agentId: list.query.agentId,
          isCurrent: () => this.current(list),
          initialResult,
        });
      })
      .catch((error: unknown) => {
        if (this.current(list)) {
          list.error = formatUiError(error);
          this.publish();
        }
      })
      .finally(() => {
        if (list.pendingRead === pending) {
          list.pendingRead = undefined;
        }
      });
    list.pendingRead = pending;
    await pending;
  }

  async refresh(): Promise<void> {
    await Promise.all(
      [...this.lists.values()].flatMap((list) => (list.pendingRead ? [list.pendingRead] : [])),
    );
    if (this.current()) {
      await Promise.all([...this.lists.values()].map((list) => this.read(list)));
    }
  }

  private publish(): void {
    // Cached lists can call back synchronously while their parent is being visited.
    if (this.applying || !this.current()) {
      return;
    }
    this.applying = true;
    const retained = new Set([this.options.query.spawnedBy]);
    const rows: SubagentsPanelChildrenSnapshot["rows"] = [];
    const seen = new Set<string>();
    const visit = (list: ChildList, depth: number) => {
      for (const session of list.rows) {
        if (seen.has(session.key)) {
          continue;
        }
        seen.add(session.key);
        rows.push({ session, depth });
        if (
          this.options.includeDescendants &&
          (session.childSessions?.length || session.hasActiveSubagentRun)
        ) {
          retained.add(session.key);
          visit(
            this.lists.get(session.key) ?? this.observe(childSessionListQuery(session.key)),
            depth + 1,
          );
        }
      }
    };
    try {
      const root = this.lists.get(this.options.query.spawnedBy);
      if (root) {
        visit(root, 0);
        if (root.snapshot?.result && !incomplete(root.snapshot)) {
          this.hasResult = true;
        }
      }
      for (const [key, list] of this.lists) {
        if (!retained.has(key)) {
          list.observation?.dispose();
          this.lists.delete(key);
        }
      }
    } finally {
      this.applying = false;
    }
    const lists = [...this.lists.values()];
    const error = lists.map((list) => list.error ?? list.snapshot?.error).find(Boolean) ?? null;
    const loading = lists.some(
      ({ snapshot, error: readError }) =>
        !readError &&
        (!snapshot ||
          (!snapshot.error && (!snapshot.result || snapshot.loading || incomplete(snapshot)))),
    );
    this.options.changed({ rows, loading, hasResult: this.hasResult, error });
  }

  dispose(): void {
    this.disposed = true;
    for (const list of this.lists.values()) {
      list.observation?.dispose();
    }
    this.lists.clear();
  }
}
