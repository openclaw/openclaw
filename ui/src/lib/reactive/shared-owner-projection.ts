import { createDetachedRoot } from "./detached-root.ts";
import { projectSource } from "./projection.ts";

type SharedOwnerProjection<T> = {
  readonly read: () => T;
  readonly revision: () => number;
};

/** Each fixed read contract shares one lazy projection per owner, independently of its consumers. */
export function createSharedOwnerProjection<
  S extends { subscribe(notify: () => void): () => void },
  T,
>(read: (source: S) => T) {
  const projections = new WeakMap<S, SharedOwnerProjection<T>>();
  return (source: S): SharedOwnerProjection<T> => {
    let projection = projections.get(source);
    if (!projection) {
      projection = createDetachedRoot(() => {
        const shared = projectSource(source, {
          read,
          subscribe: (owner, notify) => owner.subscribe(notify),
          equality: "revision",
        });
        // Consumers may observe this projection, but cannot replace or dispose its shared owner.
        return { read: shared.read, revision: shared.revision };
      });
      projections.set(source, projection);
    }
    return projection;
  };
}
