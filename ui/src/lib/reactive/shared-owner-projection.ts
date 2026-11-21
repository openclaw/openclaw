import { createDetachedRoot } from "./detached-root.ts";
import { projectSource } from "./projection.ts";

type SharedOwnerProjection<T> = {
  readonly read: () => T;
  readonly revision: () => number;
  subscribe(this: void, listener: () => void): () => void;
};

/** Each fixed contract shares one lazy projection per source, independently of its consumers. */
export function createSharedSourceProjection<S extends object, T>(contract: {
  read(source: S): T;
  subscribe(source: S, notify: () => void): () => void;
}) {
  const projections = new WeakMap<S, SharedOwnerProjection<T>>();
  return (source: S): SharedOwnerProjection<T> => {
    let projection = projections.get(source);
    if (!projection) {
      projection = createDetachedRoot(() => {
        const shared = projectSource(source, { ...contract, equality: "revision" });
        // Consumers may observe this projection, but cannot replace or dispose its shared owner.
        return { read: shared.read, revision: shared.revision, subscribe: shared.subscribe };
      });
      projections.set(source, projection);
    }
    return projection;
  };
}

export function createSharedOwnerProjection<
  S extends { subscribe(notify: () => void): () => void },
  T,
>(read: (source: S) => T) {
  return createSharedSourceProjection({
    read,
    subscribe: (source, notify) => source.subscribe(notify),
  });
}
