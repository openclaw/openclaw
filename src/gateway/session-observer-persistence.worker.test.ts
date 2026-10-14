import "../config/sessions/session-entry-patch-delivery.test-support.js";
import { expect, it, onTestFinished, vi } from "vitest";
import type { SessionObserverDigest } from "../../packages/gateway-protocol/src/schema/sessions.js";
import {
  loadSessionEntryReadOnly,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.sqlite-entry.js";
import { createSessionCompoundWorkerFixture as fixture } from "../config/sessions/session-compound-worker.test-support.js";
import { sessionChanges, type SessionRowChange } from "../sessions/session-row-changes.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { defaultPersistDigest } from "./session-observer-model.js";

const { getSessionEntryPatchDelivery } =
  await import("../config/sessions/session-entry-patch-delivery.test-support.js");
const delivery = getSessionEntryPatchDelivery();

function digest(
  scope: ReturnType<typeof fixture>["scope"],
  revision: number,
): SessionObserverDigest {
  return {
    sessionKey: scope.sessionKey,
    sessionId: scope.sessionId,
    runId: "observer-run",
    revision,
    updatedAt: revision,
    headline: `Checking revision ${revision}`,
    health: "on-track",
  };
}

function observeDigestPublications(sessionKey: string) {
  const changes: SessionRowChange[] = [];
  onTestFinished(
    sessionChanges.subscribe((change) => {
      if (
        "sessionKey" in change &&
        change.sessionKey === sessionKey &&
        change.scope === "runtime"
      ) {
        changes.push(change);
      }
    }),
  );
  return changes;
}

it.each([
  { currentRevision: 1, accepted: true },
  { currentRevision: 3, accepted: false },
])(
  "reduces a queued observer digest against current revision $currentRevision without losing metadata",
  async ({ currentRevision, accepted }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const f = fixture();
      const original = loadSessionEntryReadOnly(f.scope)!;
      const publications = observeDigestPublications(f.scope.sessionKey);
      const currentDigest = digest(f.scope, currentRevision);
      const proposedDigest = digest(f.scope, 2);
      delivery.beforeCommit = () => {
        delivery.beforeCommit = undefined;
        replaceSessionEntrySync(f.scope, {
          ...original,
          observerDigest: currentDigest,
          label: "Changed while observer write was queued",
          updatedAt: 100,
        });
      };

      expect(await defaultPersistDigest({ ...f.scope, digest: proposedDigest })).toBe(accepted);
      expect(delivery.commands).toEqual(["session.entry.patch.commit"]);
      expect(publications).toHaveLength(accepted ? 1 : 0);
      const expected = {
        observerDigest: accepted ? proposedDigest : currentDigest,
        label: "Changed while observer write was queued",
        updatedAt: 100,
      };
      expect(f.read()).toMatchObject(expected);
      expect(loadSessionEntryReadOnly(f.scope)).toMatchObject(expected);
    });
  },
);

it("recovers and publishes an acknowledged observer digest once after a lost worker reply", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = fixture();
    expect(loadSessionEntryReadOnly(f.scope)?.observerDigest).toBeUndefined();
    const publications = observeDigestPublications(f.scope.sessionKey);
    const proposedDigest = digest(f.scope, 1);
    const loseReply = vi.fn(() => {
      throw new Error("Observer worker reply lost after COMMIT");
    });
    delivery.afterCommit = loseReply;

    expect(await defaultPersistDigest({ ...f.scope, digest: proposedDigest })).toBe(true);
    expect(loseReply).toHaveBeenCalledOnce();
    expect(delivery.commands).toEqual(["session.entry.patch.commit"]);
    expect(publications).toHaveLength(1);
    expect(f.read()?.observerDigest).toEqual(proposedDigest);
    expect(loadSessionEntryReadOnly(f.scope)?.observerDigest).toEqual(proposedDigest);

    delivery.afterCommit = undefined;
    expect(await defaultPersistDigest({ ...f.scope, digest: proposedDigest })).toBe(false);
    expect(publications).toHaveLength(1);
    expect(f.read()?.observerDigest).toEqual(proposedDigest);
  });
});
