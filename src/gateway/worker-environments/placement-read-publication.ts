import type { DatabasePathIdentity } from "../../infra/sqlite-worker-identity.js";
import { sessionChanges, type SessionRowChange } from "../../sessions/session-row-changes.js";
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
  let current = true;
  let publishedChange: SessionRowChange | undefined;
  const invalidate = () => {
    current = false;
    if (publishedChange) {
      publications.delete(publishedChange);
    }
  };
  const unsubscribe = sessionChanges.subscribeFacts((change) => {
    if (change === publishedChange) {
      return;
    }
    if ("all" in change) {
      if (
        change.scope === "worker-placements" ||
        change.scope === "worker-environments" ||
        change.scope === "stores"
      ) {
        invalidate();
      }
    } else if (change.scope === undefined || change.factsInvalidated) {
      for (const placement of projection.placements.values()) {
        if (
          change.sessionKey === placement.sessionKey &&
          (!change.agentId || change.agentId === placement.agentId)
        ) {
          invalidate();
        }
      }
    }
  });
  return {
    publish(change: SessionRowChange) {
      if (current) {
        publishedChange = change;
        publications.set(change, { identity, projection });
      }
    },
    release() {
      unsubscribe();
      invalidate();
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
