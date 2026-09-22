import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { GatewayRequestError } from "../../api/gateway.ts";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import type { SessionCapability, SessionListSnapshot, SessionRowObservation } from "./index.ts";
import { fetchPagedSessionRows } from "./paged-session-rows.ts";
import {
  normalizeAgentId,
  areUiSessionKeysEquivalent,
  parseAgentSessionKey,
} from "./session-key.ts";

const SWARM_SESSION_PAGE_SIZE = 10_000;

function childQuery(parentKey: string) {
  return {
    spawnedBy: parentKey,
    limit: SWARM_SESSION_PAGE_SIZE,
    includeGlobal: false,
    includeUnknown: false,
    configuredAgentsOnly: true,
  };
}

function readSwarmEnabled(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  const enabled = asNullableRecord(value)?.enabled;
  return typeof enabled === "boolean" ? enabled : undefined;
}

export function isSwarmEnabledInConfig(config: unknown, agentId?: string): boolean {
  const root = asNullableRecord(config);
  const globalEnabled = readSwarmEnabled(asNullableRecord(root?.tools)?.swarm);
  const agents = asNullableRecord(root?.agents);
  const entries = asNullableRecord(agents?.entries);
  const normalizedAgentId = agentId ? normalizeAgentId(agentId) : null;
  const authoredAgentId = normalizedAgentId
    ? Object.keys(entries ?? {}).find(
        (candidate) => normalizeAgentId(candidate) === normalizedAgentId,
      )
    : null;
  const agent = authoredAgentId ? asNullableRecord(entries?.[authoredAgentId]) : null;
  const agentEnabled = readSwarmEnabled(asNullableRecord(agent?.tools)?.swarm);
  return agentEnabled ?? globalEnabled ?? true;
}

function isNewerSessionRow(candidate: GatewaySessionRow, current: GatewaySessionRow): boolean {
  // Equal persisted timestamps intentionally prefer the later row source,
  // while Map replacement preserves each key's first insertion position.
  return (candidate.updatedAt ?? 0) >= (current.updatedAt ?? 0);
}

export function mergeSwarmSessionRows(
  ...rowSources: readonly (readonly GatewaySessionRow[])[]
): GatewaySessionRow[] {
  const merged = new Map<string, GatewaySessionRow>();
  for (const rows of rowSources) {
    for (const row of rows) {
      const current = merged.get(row.key);
      if (!current || isNewerSessionRow(row, current)) {
        merged.set(row.key, row);
      }
    }
  }
  return [...merged.values()];
}

export async function hydrateSwarmSessionRows(params: {
  sessions: Pick<SessionCapability, "list" | "inheritRow">;
  parentKey: string;
  isCurrent: () => boolean;
  initialResult?: SessionsListResult;
}): Promise<GatewaySessionRow[] | null> {
  const childRows = await fetchPagedSessionRows({
    list: (offset) => params.sessions.list({ ...childQuery(params.parentKey), offset }),
    initialResult: params.initialResult,
    isCurrent: params.isCurrent,
    missingResultError: "child session list returned no result",
    mapPageRows: (rows) => {
      const runtimeSampledAt = Date.now();
      return rows.map((row) => params.sessions.inheritRow({ ...row, runtimeSampledAt }, row));
    },
  });
  return childRows;
}

type SwarmHydrationParams = {
  sessions: Pick<SessionCapability, "list" | "inheritRow" | "observeRow" | "observeList">;
  agentId?: string;
  readParent: () => Promise<GatewaySessionRow | null>;
  parentKey: string;
  sourceEpoch: number;
  currentRows: () => readonly GatewaySessionRow[];
  onRows: (rows: GatewaySessionRow[]) => void;
};

type SwarmRead = "parent" | "children";

export class SwarmRosterHydrator {
  rows: GatewaySessionRow[] = [];
  private key = "";
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly retries: Record<
    SwarmRead,
    { attempts: number; timer: ReturnType<typeof setTimeout> | null }
  > = {
    parent: { attempts: 0, timer: null },
    children: { attempts: 0, timer: null },
  };
  private params: SwarmHydrationParams | null = null;
  private parent: SessionRowObservation | null = null;
  private parentRow: GatewaySessionRow | null = null;
  private parentSummary = "";
  private children: ReturnType<SessionCapability["observeList"]> | null = null;
  private childResult: SessionsListResult | null = null;
  private childRows: GatewaySessionRow[] = [];
  private parentRequest: Promise<void> | null = null;
  private parentRefreshQueued = false;
  private publishingParentRead = false;

  update(params: SwarmHydrationParams): void {
    const key = `${params.sourceEpoch}:${params.agentId ?? ""}:${params.parentKey}`;
    const changed =
      this.key !== key ||
      this.params?.sessions !== params.sessions ||
      (this.parent && !this.parent.isCurrent());
    if (changed) {
      this.reset(key);
    }
    this.params = params;
    if (changed) {
      // The seed only fills the initial frame. The observed child query owns all
      // subsequent membership and field updates, including removals and denials.
      this.childRows = params
        .currentRows()
        .filter((row) => !areUiSessionKeysEquivalent(row.key, params.parentKey));
      this.rows = this.childRows;
      params.onRows(this.rows);
    }
    if (this.children || this.timer !== null) {
      return;
    }
    this.timer = setTimeout(() => this.connect(), 250);
  }

  dispose(): void {
    this.reset("");
  }

  private connect(): void {
    this.timer = null;
    const params = this.params;
    if (!params) {
      return;
    }
    const generation = this.generation;
    const isCurrent = () => this.generation === generation;
    const agentId = params.agentId ?? parseAgentSessionKey(params.parentKey)?.agentId;
    if (!agentId) {
      return;
    }
    this.parent = params.sessions.observeRow(
      { key: params.parentKey, agentId },
      (parent) => {
        if (isCurrent()) {
          this.applyParent(parent);
        }
      },
      {
        onInvalidate: () => {
          if (isCurrent() && !this.parentRequest) {
            void this.readParent();
          }
        },
      },
    );
    this.children = params.sessions.observeList(childQuery(params.parentKey), (snapshot) => {
      if (isCurrent()) {
        this.applyChildren(snapshot);
      }
    });
    // Parent counts remain independent of the optional child-name page.
    void this.readParent();
    void this.children.refresh().catch(() => {
      if (isCurrent()) {
        this.retry("children");
      }
    });
  }

  private applyParent(parent: GatewaySessionRow | null): void {
    const previous = this.parentRow;
    const summary = JSON.stringify([
      parent?.sessionId,
      parent?.childSessions,
      parent?.swarm?.groups.map(({ children: _children, ...group }) => group),
      parent?.swarm?.otherActiveGroups,
    ]);
    const changed = this.parentSummary !== summary;
    // Roster/event summaries omit members. Equal summary facts retain the detailed
    // read's membership; changed groups are re-read through the same row observation.
    this.parentRow =
      parent && !changed && previous?.swarm && parent.swarm
        ? {
            ...parent,
            swarm: {
              ...parent.swarm,
              groups: parent.swarm.groups.map((group) => ({
                ...group,
                children:
                  group.children ??
                  previous.swarm?.groups.find((entry) => entry.groupId === group.groupId)?.children,
              })),
            },
          }
        : parent;
    this.parentSummary = summary;
    this.rows = this.parentRow ? mergeSwarmSessionRows(this.childRows, [this.parentRow]) : [];
    this.params?.onRows(this.rows);
    if (parent && changed && this.parent && !this.publishingParentRead) {
      void this.readParent();
    }
  }

  private recovered(owner: SwarmRead): void {
    const retry = this.retries[owner];
    if (retry.timer !== null) {
      clearTimeout(retry.timer);
    }
    retry.timer = null;
    retry.attempts = 0;
  }

  private retry(owner: SwarmRead): void {
    const retry = this.retries[owner];
    if (!this.params || retry.timer !== null) {
      return;
    }
    const generation = this.generation;
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(retry.attempts++, 5));
    retry.timer = setTimeout(() => {
      retry.timer = null;
      if (owner === "parent") {
        void this.readParent();
      } else {
        void this.children?.refresh().catch(() => {
          if (generation === this.generation) {
            this.retry(owner);
          }
        });
      }
    }, delay);
  }

  private readParent(): Promise<void> {
    if (this.parentRequest) {
      this.parentRefreshQueued = true;
      return this.parentRequest;
    }
    const params = this.params;
    const parent = this.parent;
    if (!params || !parent?.isCurrent()) {
      return Promise.resolve();
    }
    const generation = this.generation;
    const isCurrent = () => generation === this.generation && parent === this.parent;
    const reconcile = parent.captureReconcile();
    const publish = (row: GatewaySessionRow | undefined) => {
      // The describe publishes synchronously through its observation. Only external
      // summaries should queue replacement work behind this same read.
      this.publishingParentRead = true;
      try {
        return reconcile(row);
      } finally {
        this.publishingParentRead = false;
      }
    };
    const request = Promise.resolve()
      .then(() => params.readParent())
      .then((row) => {
        if (!isCurrent()) {
          return;
        }
        const outcome = publish(row ?? undefined);
        if (outcome.status === "invalidated") {
          this.parentRefreshQueued = true;
        } else if (outcome.status === "current") {
          this.recovered("parent");
        }
      })
      .catch((error: unknown) => {
        if (!isCurrent()) {
          return;
        }
        if (error instanceof GatewayRequestError && error.code === "INVALID_REQUEST") {
          const outcome = publish(undefined);
          if (outcome.status === "invalidated") {
            this.parentRefreshQueued = true;
          } else if (outcome.status === "current") {
            this.recovered("parent");
          }
        } else {
          this.retry("parent");
        }
      })
      .finally(() => {
        if (!isCurrent() || this.parentRequest !== request) {
          return;
        }
        this.parentRequest = null;
        if (this.parentRefreshQueued) {
          this.parentRefreshQueued = false;
          void this.readParent();
        }
      });
    this.parentRequest = request;
    return request;
  }

  private applyChildren(snapshot: SessionListSnapshot): void {
    const params = this.params;
    const result = snapshot.result;
    if (snapshot.error && !snapshot.loading) {
      this.retry("children");
      return;
    }
    if (!params || snapshot.loading || !result || result === this.childResult) {
      return;
    }
    this.childResult = result;
    const previousChildren = new Map(this.childRows.map((row) => [row.key, row]));
    const described = new Map(
      this.parentRow?.swarm?.groups.flatMap((group) =>
        (group.children ?? []).map(
          (child) => [child.sessionKey, { ...child, groupId: group.groupId }] as const,
        ),
      ),
    );
    const changedMembers = result.sessions.filter((row) => {
      const previous = previousChildren.get(row.key);
      return previous?.swarmGroupId !== row.swarmGroupId || previous?.status !== row.status;
    });
    const currentKeys = new Set(result.sessions.map((row) => row.key));
    const removedMember = [...described.keys()].some(
      (key) => previousChildren.has(key) && !currentKeys.has(key),
    );
    // Reuse a parent read that already observed this child change. Equal aggregate
    // counts alone cannot prove unchanged membership outside the primary page.
    const missingDetail = changedMembers.some((row) => {
      const member = described.get(row.key);
      return (
        row.swarmGroupId &&
        (member?.groupId !== row.swarmGroupId || (row.status && member?.status !== row.status))
      );
    });
    if (this.parentRow && (removedMember || missingDetail)) {
      void this.readParent();
    }
    const generation = this.generation;
    const isCurrent = () => generation === this.generation && this.childResult === result;
    void hydrateSwarmSessionRows({
      sessions: params.sessions,
      parentKey: params.parentKey,
      initialResult: result,
      isCurrent,
    })
      .then((rows) => {
        if (!rows || !isCurrent()) {
          return;
        }
        const parent = this.parentRow;
        this.childRows = rows;
        this.rows = parent ? mergeSwarmSessionRows(this.childRows, [parent]) : [];
        this.recovered("children");
        params.onRows(this.rows);
      })
      .catch(() => {
        if (isCurrent()) {
          this.retry("children");
        }
      });
  }

  private reset(key: string): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
    }
    this.parent?.dispose();
    this.children?.dispose();
    this.params = null;
    this.parent = null;
    this.parentRow = null;
    this.parentSummary = "";
    this.children = null;
    this.childResult = null;
    this.childRows = [];
    this.parentRequest = null;
    this.parentRefreshQueued = false;
    this.rows = [];
    this.key = key;
    this.generation += 1;
    this.recovered("parent");
    this.recovered("children");
    this.timer = null;
  }
}
