import type { DatabasePathIdentity } from "../../infra/sqlite-worker-identity.js";
import type { SessionRowChange } from "../../sessions/session-row-changes.js";
import type { WorkerSessionPlacementProjection } from "./placement-read-projection.types.js";

const publications = new WeakMap<
  SessionRowChange,
  { identity: DatabasePathIdentity; projection: WorkerSessionPlacementProjection }
>();

/** Receipt facts last only through their committed notification, never as turn authority. */
export function preparePlacementProjectionPublication(
  identity: DatabasePathIdentity,
  projection: WorkerSessionPlacementProjection,
) {
  let publishedChange: SessionRowChange | undefined;
  return {
    publish(change: SessionRowChange) {
      publishedChange = change;
      publications.set(change, { identity, projection });
    },
    release() {
      if (publishedChange) {
        publications.delete(publishedChange);
      }
      publishedChange = undefined;
    },
  };
}

export function readPublishedPlacementProjection(
  identity: DatabasePathIdentity,
  change: SessionRowChange,
): WorkerSessionPlacementProjection | undefined {
  const published = publications.get(change);
  return published?.identity.key === identity.key &&
    published.identity.birthtime === identity.birthtime
    ? published.projection
    : undefined;
}
