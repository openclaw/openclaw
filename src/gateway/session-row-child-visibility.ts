import { isDeepStrictEqual } from "node:util";
import {
  identity,
  type MaterializedRow,
  type Row,
  type EntryRow,
} from "./session-row-projection-record.js";
import type { SessionSharingTarget } from "./session-sharing-target.types.js";

type ChildLinks = MaterializedRow["materialized"]["source"]["childLinks"];
type ChildLink = NonNullable<ChildLinks>[number];
type Visibility = {
  childKey?: string;
  swarmKey?: string;
  excludedChildKeys?: ReadonlySet<string>;
  excludedSwarmKeys?: ReadonlySet<string>;
  revision: object;
};
type Audience = { dirty: Set<string>; value: Visibility };
type Parent = {
  generation: Row["generation"];
  childLinks: ChildLinks;
  swarm: MaterializedRow["materialized"]["row"]["swarm"];
  links: Map<string, ChildLink[]>;
  swarmKeys: Set<string>;
  dependencies: Set<string>;
  audiences: Map<string, Audience>;
};

// Retain a bounded number of sharing variants, never connections or their authorization callbacks.
const MAX_AUDIENCES = 64;
const EMPTY_VISIBILITY: Visibility = Object.freeze({ revision: {} });

function updateExclusion(
  previous: ReadonlySet<string> | undefined,
  next: Set<string> | undefined,
  key: string,
  hidden: boolean,
) {
  if (hidden === (previous?.has(key) ?? false)) {
    return next;
  }
  const updated = next ?? new Set(previous);
  if (hidden) {
    updated.add(key);
  } else {
    updated.delete(key);
  }
  return updated;
}

function shareVisibility(parent: Parent, value: Visibility): Visibility {
  if (!value.excludedChildKeys && !value.excludedSwarmKeys) {
    return EMPTY_VISIBILITY;
  }
  // Authorization ran for this audience; only its identical immutable result is shared.
  for (const audience of parent.audiences.values()) {
    if (
      isDeepStrictEqual(audience.value.excludedChildKeys, value.excludedChildKeys) &&
      isDeepStrictEqual(audience.value.excludedSwarmKeys, value.excludedSwarmKeys)
    ) {
      return audience.value;
    }
  }
  return {
    ...value,
    childKey: value.excludedChildKeys && JSON.stringify([...value.excludedChildKeys].toSorted()),
    swarmKey: value.excludedSwarmKeys && JSON.stringify([...value.excludedSwarmKeys].toSorted()),
  };
}

/** Committed child publications invalidate only their dependent parents' sharing results. */
export function createSessionRowChildVisibility() {
  const parents = new Map<string, Parent>();
  const dependents = new Map<string, Set<Parent>>();
  function unlink(parent: Parent, key: string) {
    const owners = dependents.get(key)!;
    owners.delete(parent);
    if (owners.size === 0) {
      dependents.delete(key);
    }
  }
  function detach(parent: Parent) {
    for (const key of parent.dependencies) {
      unlink(parent, key);
    }
  }
  function reconcile(parent: Parent, record: MaterializedRow) {
    const { childLinks } = record.materialized.source;
    const { swarm } = record.materialized.row;
    if (parent.childLinks === childLinks && parent.swarm === swarm) {
      return;
    }
    const changed = new Set<string>();
    if (parent.childLinks !== childLinks) {
      const links = new Map<string, ChildLink[]>();
      for (const child of childLinks ?? []) {
        const children = links.get(child.key);
        if (children) {
          children.push(child);
        } else {
          links.set(child.key, [child]);
        }
      }
      for (const key of new Set([...parent.links.keys(), ...links.keys()])) {
        if (!isDeepStrictEqual(parent.links.get(key), links.get(key))) {
          changed.add(key);
        }
      }
      parent.links = links;
      parent.childLinks = childLinks;
    }
    if (parent.swarm !== swarm) {
      const keys = new Set<string>();
      for (const group of swarm?.groups ?? []) {
        for (const child of group.children ?? []) {
          keys.add(child.sessionKey);
        }
      }
      for (const key of parent.swarmKeys) {
        if (!keys.has(key)) {
          changed.add(key);
        }
      }
      for (const key of keys) {
        if (!parent.swarmKeys.has(key)) {
          changed.add(key);
        }
      }
      parent.swarmKeys = keys;
      parent.swarm = swarm;
    }
    const dependencies = new Set([...parent.links.keys(), ...parent.swarmKeys]);
    for (const key of parent.dependencies) {
      if (!dependencies.has(key)) {
        unlink(parent, key);
      }
    }
    for (const key of dependencies) {
      if (!parent.dependencies.has(key)) {
        let owners = dependents.get(key);
        if (!owners) {
          owners = new Set();
          dependents.set(key, owners);
        }
        owners.add(parent);
      }
    }
    parent.dependencies = dependencies;
    for (const audience of parent.audiences.values()) {
      for (const key of changed) {
        audience.dirty.add(key);
      }
    }
  }
  function clear() {
    parents.clear();
    dependents.clear();
  }
  return {
    clear,
    invalidate(key?: string) {
      if (key === undefined) {
        clear();
        return;
      }
      for (const parent of dependents.get(key) ?? []) {
        for (const audience of parent.audiences.values()) {
          audience.dirty.add(key);
        }
      }
    },
    remove(record: Pick<Row, "agentId" | "key" | "storeTarget">) {
      const id = identity(record);
      const parent = parents.get(id);
      if (parent) {
        detach(parent);
        parents.delete(id);
      }
    },
    read(
      record: MaterializedRow,
      audienceKey: string,
      canRead: (
        key: string,
        entry: SessionSharingTarget["entry"],
        agentId?: string,
        storePath?: string,
      ) => boolean,
      selectEntries: (query: { key: string }) => EntryRow[],
      includeSwarm = true,
    ): Visibility {
      const id = identity(record);
      let parent = parents.get(id);
      const hasSwarm = record.materialized.row.swarm?.groups.some(
        (group) => (group.children?.length ?? 0) > 0,
      );
      if (!record.materialized.source.childLinks?.length && (!includeSwarm || !hasSwarm)) {
        if (parent && !hasSwarm) {
          detach(parent);
          parents.delete(id);
        }
        return EMPTY_VISIBILITY;
      }
      if (parent && parent.generation !== record.generation) {
        detach(parent);
        parent = undefined;
      }
      if (!parent) {
        parent = {
          generation: record.generation,
          childLinks: undefined,
          swarm: undefined,
          links: new Map(),
          swarmKeys: new Set(),
          dependencies: new Set(),
          audiences: new Map(),
        };
        parents.set(id, parent);
      }
      reconcile(parent, record);
      const variant = `${Number(includeSwarm)}:${audienceKey}`;
      let audience = parent.audiences.get(variant);
      if (!audience) {
        if (parent.audiences.size === MAX_AUDIENCES) {
          parent.audiences.delete(parent.audiences.keys().next().value!);
        }
        audience = { dirty: new Set(parent.dependencies), value: EMPTY_VISIBILITY };
        parent.audiences.set(variant, audience);
      }
      if (audience.dirty.size === 0) {
        return audience.value;
      }
      const pending = audience.dirty;
      audience.dirty = new Set();
      let children: Set<string> | undefined;
      let swarm: Set<string> | undefined;
      try {
        for (const key of pending) {
          const hidden =
            parent.links
              .get(key)
              ?.some((child) => !canRead(key, child.entry, child.agentId, child.storePath)) ??
            false;
          const swarmHidden =
            includeSwarm &&
            parent.swarmKeys.has(key) &&
            (hidden ||
              selectEntries({ key }).some(
                (child) =>
                  !canRead(child.key, child.entry, child.agentId, child.storeTarget.storePath),
              ));
          children = updateExclusion(audience.value.excludedChildKeys, children, key, hidden);
          swarm = updateExclusion(audience.value.excludedSwarmKeys, swarm, key, swarmHidden);
        }
      } catch (error) {
        // Pending worker facts retry through preparation without certifying a partial audience.
        for (const key of pending) {
          audience.dirty.add(key);
        }
        throw error;
      }
      if (children || swarm) {
        audience.value = shareVisibility(parent, {
          excludedChildKeys:
            children?.size === 0 ? undefined : (children ?? audience.value.excludedChildKeys),
          excludedSwarmKeys:
            swarm?.size === 0 ? undefined : (swarm ?? audience.value.excludedSwarmKeys),
          revision: {},
        });
      }
      return audience.value;
    },
  };
}
