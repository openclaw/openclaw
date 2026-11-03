import { isDeepStrictEqual } from "node:util";
import { readSwarmReservationRevision } from "../agents/subagents/swarm/swarm-scheduler.js";
import { readAgentRunIndexVersion } from "../infra/agent-run-registry.js";
import type { SessionRowChange } from "../sessions/session-row-changes.js";
import { createSessionRowChildVisibility } from "./session-row-child-visibility.js";
import {
  identity,
  present,
  type MaterializedRow,
  type Row,
  type Query,
  type SnapshotOptions,
} from "./session-row-projection-record.js";
import type { SessionChildActivity, SessionListRowContext } from "./session-utils-contracts.js";
import { sessionChildLinkExpiresAt } from "./session-utils-core.js";
import { projectPreparedSessionChild } from "./session-utils-display.js";

type Link = NonNullable<MaterializedRow["materialized"]["source"]["childLinks"]>[number];
type Contribution = {
  link: Link;
  included: boolean;
  active: boolean | undefined;
  expires: number;
  volatile: boolean;
};
type View = {
  excluded?: ReadonlySet<string>;
  active: number;
  keys?: string[];
  keysDirty: boolean;
  value?: SessionChildActivity;
};
type Parent = {
  revision: object;
  generation: Row["generation"];
  links: MaterializedRow["materialized"]["source"]["childLinks"];
  children: Map<string, Contribution>;
  dirty: Set<string>;
  byKey: Map<string, Contribution[]>;
  views: Map<object | undefined, View>;
  nextExpiry: number;
  sampledAt: number;
};
const EMPTY: SessionChildActivity = {
  revision: {},
  childSessions: undefined,
  hasActiveSubagentRun: false,
};
const childId = (link: Link) => `${link.agentId ?? ""}\0${link.storePath ?? ""}\0${link.key}`;

/** The resident projection updates child contributions; consumers reuse their visible aggregate. */
export function createSessionRowChildActivity() {
  const parents = new Map<string, Parent>();
  const dependents = new Map<string, Set<Parent>>();
  let agentRevision = readAgentRunIndexVersion();
  let reservationRevision = readSwarmReservationRevision();
  function invalidate(key?: string) {
    for (const parent of key === undefined ? parents.values() : (dependents.get(key) ?? [])) {
      if (key === undefined) {
        for (const child of parent.children.values()) {
          parent.dirty.add(child.link.key);
        }
      } else {
        parent.dirty.add(key);
      }
    }
  }
  function remove(record: Pick<Row, "agentId" | "key" | "storeTarget">) {
    const id = identity(record);
    const parent = parents.get(id);
    if (!parent) {
      return;
    }
    for (const child of parent.children.values()) {
      const owners = dependents.get(child.link.key);
      owners?.delete(parent);
      if (!owners?.size) {
        dependents.delete(child.link.key);
      }
    }
    parents.delete(id);
  }
  return {
    invalidate,
    invalidateRuntime(keys?: Iterable<string>) {
      if (keys) {
        for (const key of keys) {
          invalidate(key);
        }
      } else {
        invalidate();
      }
      agentRevision = readAgentRunIndexVersion();
    },
    remove,
    clear() {
      parents.clear();
      dependents.clear();
    },
    read(
      record: MaterializedRow,
      context: SessionListRowContext,
      now: number,
      excluded?: ReadonlySet<string>,
      exclusionRevision?: object,
    ): SessionChildActivity {
      if (agentRevision !== readAgentRunIndexVersion()) {
        invalidate();
        agentRevision = readAgentRunIndexVersion();
      }
      if (reservationRevision !== readSwarmReservationRevision()) {
        for (const parent of parents.values()) {
          for (const child of parent.children.values()) {
            if (child.volatile) {
              parent.dirty.add(child.link.key);
            }
          }
        }
        reservationRevision = readSwarmReservationRevision();
      }
      if (!record.materialized.source.childLinks?.length) {
        remove(record);
        return EMPTY;
      }
      const viewKey = excluded ? exclusionRevision : undefined;
      const id = identity(record);
      let parent = parents.get(id);
      if (parent?.generation !== record.generation) {
        remove(record);
        parent = undefined;
      }
      if (!parent) {
        parent = {
          revision: {},
          generation: record.generation,
          links: undefined,
          children: new Map(),
          byKey: new Map(),
          dirty: new Set(),
          views: new Map(),
          nextExpiry: Infinity,
          sampledAt: now,
        };
        parents.set(id, parent);
      }
      const links = record.materialized.source.childLinks;
      if (parent.links !== links) {
        const next = new Map<string, Contribution>();
        for (const link of links ?? []) {
          const key = childId(link);
          const previous = parent.children.get(key);
          const child = previous ?? {
            link,
            included: false,
            active: undefined,
            expires: Infinity,
            volatile: false,
          };
          if (!previous || !isDeepStrictEqual(previous.link, link)) {
            parent.dirty.add(link.key);
          }
          child.link = link;
          next.set(key, child);
          let owners = dependents.get(link.key);
          if (!owners) {
            dependents.set(link.key, (owners = new Set()));
          }
          owners.add(parent);
        }
        let structureChanged = next.size !== parent.children.size;
        const previousOrder = parent.children.keys();
        for (const key of next.keys()) {
          if (key !== previousOrder.next().value) {
            structureChanged = true;
          }
        }
        for (const [key, child] of parent.children) {
          if (!next.has(key)) {
            for (const view of parent.views.values()) {
              if (child.included && child.active && !view.excluded?.has(child.link.key)) {
                view.active--;
              }
            }
          }
        }
        if (structureChanged) {
          parent.revision = {};
          for (const view of parent.views.values()) {
            view.keysDirty = true;
            view.value = undefined;
          }
        }
        parent.byKey = new Map();
        parent.nextExpiry = Infinity;
        for (const child of next.values()) {
          parent.nextExpiry = Math.min(parent.nextExpiry, child.expires);
          const siblings = parent.byKey.get(child.link.key) ?? [];
          siblings.push(child);
          parent.byKey.set(child.link.key, siblings);
        }
        for (const child of parent.children.values()) {
          if (!parent.byKey.has(child.link.key)) {
            const owners = dependents.get(child.link.key);
            owners?.delete(parent);
            if (!owners?.size) {
              dependents.delete(child.link.key);
            }
          }
        }
        parent.children = next;
        parent.links = links;
      }
      if (now < parent.sampledAt || now > parent.nextExpiry) {
        for (const child of parent.children.values()) {
          if (now < parent.sampledAt || now > child.expires) {
            parent.dirty.add(child.link.key);
          }
        }
      }
      const subagentRuns = context.subagentRuns.atTime(now);
      if (parent.dirty.size) {
        let recomputeExpiry = now < parent.sampledAt || now > parent.nextExpiry;
        for (const key of parent.dirty) {
          for (const child of parent.byKey.get(key) ?? []) {
            const { link } = child;
            const { included, active: propagated } = projectPreparedSessionChild(
              link,
              record.key,
              now,
              { ...context, subagentRuns },
            );
            if (included !== child.included || propagated !== child.active) {
              parent.revision = {};
              for (const view of parent.views.values()) {
                if (view.excluded?.has(link.key)) {
                  continue;
                }
                view.active +=
                  (included && propagated ? 1 : 0) - (child.included && child.active ? 1 : 0);
                if (included !== child.included) {
                  view.keysDirty = true;
                }
              }
            }
            child.included = included;
            child.active = propagated;
            const expiry = Math.min(
              subagentRuns.nextChangeAt(link.key),
              sessionChildLinkExpiresAt(link.key, link.entry, subagentRuns, now),
            );
            if (child.expires === parent.nextExpiry && expiry !== child.expires) {
              recomputeExpiry = true;
            }
            child.expires = expiry;
            parent.nextExpiry = Math.min(parent.nextExpiry, expiry);
            child.volatile = subagentRuns.hasUnendedRuns(link.key);
          }
        }
        if (recomputeExpiry) {
          parent.nextExpiry = Infinity;
          for (const child of parent.children.values()) {
            parent.nextExpiry = Math.min(parent.nextExpiry, child.expires);
          }
        }
        parent.dirty.clear();
      }
      parent.sampledAt = now;
      let view = parent.views.get(viewKey);
      if (!view) {
        // Match the bounded audience history of child authorization; never retain clients.
        if (parent.views.size === 64) {
          parent.views.delete(parent.views.keys().next().value);
        }
        view = { excluded, active: 0, keysDirty: true };
        for (const child of parent.children.values()) {
          if (child.included && child.active && !excluded?.has(child.link.key)) {
            view.active++;
          }
        }
        parent.views.set(viewKey, view);
      }
      if (!view.value || view.value.revision !== parent.revision) {
        if (view.keysDirty) {
          const keys = [];
          for (const child of parent.children.values()) {
            if (child.included && !view.excluded?.has(child.link.key)) {
              keys.push(child.link.key);
            }
          }
          view.keys = keys.length ? keys : undefined;
          view.keysDirty = false;
        }
        view.value = {
          revision: parent.revision,
          childSessions: view.keys,
          hasActiveSubagentRun: view.active > 0,
        };
      }
      return view.value;
    },
  };
}

/** Bind derived child facts to the resident projection's publications and disposal. */
export function createSessionRowChildProjection(params: {
  context(): SessionListRowContext;
  matching(query: Query, kind?: string): Row[];
  referenced(reference: string): Row | undefined;
}) {
  const activity = createSessionRowChildActivity();
  const visibility = createSessionRowChildVisibility();
  function clear() {
    activity.clear();
    visibility.clear();
  }
  function invalidate(key?: string) {
    visibility.invalidate(key);
    if (key === undefined) {
      activity.invalidate();
      return;
    }
    const seen = new Set<string>();
    const pending = [key];
    for (const child of pending) {
      if (seen.has(child)) {
        continue;
      }
      seen.add(child);
      activity.invalidate(child);
      for (const row of params.matching({ key: child })) {
        for (const ref of row.parents) {
          const parent = params.referenced(ref);
          if (parent) {
            pending.push(parent.key);
          }
        }
      }
    }
  }
  const readChildActivity = (
    record: MaterializedRow,
    now: number,
    excluded?: ReadonlySet<string>,
    revision?: object,
  ) => {
    const owner = record.privateSource ? createSessionRowChildActivity() : activity;
    return owner.read(record, params.context(), now, excluded, revision);
  };
  return {
    clear,
    invalidate,
    remove(row: Row) {
      invalidate(row.key);
      activity.remove(row);
      visibility.remove(row);
    },
    replace(row: Row) {
      invalidate(row.key);
      if (row.entry?.archivedAt !== undefined && !row.materialized) {
        // Archive pages release display custody independently of the stored row generation.
        activity.remove(row);
        visibility.remove(row);
      }
    },
    mark(change: SessionRowChange) {
      if (!("all" in change)) {
        invalidate(change.sessionKey);
        return;
      }
      if (change.factsInvalidated) {
        clear();
        return;
      }
      if (change.scope === "agent-runs") {
        const keys = change.runtimeSession
          ? params.matching({ key: change.runtimeSession.sessionId }, "id").map((row) => row.key)
          : undefined;
        if (keys) {
          for (const key of keys) {
            invalidate(key);
          }
        }
        activity.invalidateRuntime(keys);
      } else if (
        change.scope !== "subagent-runs" &&
        change.scope !== "worker-environments" &&
        change.scope !== "worker-placements" &&
        change.scope !== "sessions" &&
        change.scope !== "catalog"
      ) {
        clear();
      }
    },
    readers: {
      readChildVisibility: (...args: Parameters<typeof visibility.read>) => {
        const owner = args[0].privateSource ? createSessionRowChildVisibility() : visibility;
        return owner.read(...args);
      },
      readChildActivity,
      present(record: MaterializedRow, options: SnapshotOptions = {}) {
        const now = options.now ?? Date.now();
        return present(record, params.context(), {
          ...options,
          now,
          childActivity:
            options.childActivity ??
            readChildActivity(
              record,
              now,
              options.excludedChildKeys,
              options.excludedChildKeys ? {} : undefined,
            ),
        });
      },
    },
  };
}
