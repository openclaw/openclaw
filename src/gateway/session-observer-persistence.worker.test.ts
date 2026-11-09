import "../config/sessions/session-entry-patch-delivery.test-support.js";
import { expect, it, onTestFinished, vi } from "vitest";
import type { SessionObserverDigest } from "../../packages/gateway-protocol/src/schema/sessions.js";
import {
  loadSessionEntryReadOnly,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.sqlite-entry.js";
import { createSessionCompoundWorkerFixture as fixture } from "../config/sessions/session-compound-worker.test-support.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { defaultPersistDigest } from "./session-observer-model.js";

const { getSessionEntryPatchDelivery } =
  await import("../config/sessions/session-entry-patch-delivery.test-support.js");
const delivery = getSessionEntryPatchDelivery();

it.each([
  { revision: 1, accepted: true, lostReply: false },
  { revision: 3, accepted: false, lostReply: false },
  { revision: 0, accepted: true, lostReply: true },
])("persists revision $revision with lost reply $lostReply", ({ revision, accepted, lostReply }) =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    const f = fixture();
    const original = loadSessionEntryReadOnly(f.scope)!;
    const digest = (value: number): SessionObserverDigest => ({
      sessionKey: f.scope.sessionKey,
      sessionId: f.scope.sessionId,
      runId: "observer-run",
      revision: value,
      updatedAt: value,
      headline: `Checking revision ${value}`,
      health: "on-track",
    });
    const proposed = digest(lostReply ? 1 : 2);
    const current = digest(revision);
    const metadata = { label: "Changed while observer write was queued", updatedAt: 100 };
    const published = vi.fn();
    onTestFinished(
      sessionChanges.subscribe((change) => {
        if (
          "sessionKey" in change &&
          change.sessionKey === f.scope.sessionKey &&
          change.scope === "runtime"
        ) {
          published();
        }
      }),
    );
    const loseReply = vi.fn(() => {
      throw new Error("Observer worker reply lost after COMMIT");
    });
    if (lostReply) {
      expect(original.observerDigest).toBeUndefined();
      delivery.afterCommit = loseReply;
    } else {
      delivery.beforeCommit = () => {
        delivery.beforeCommit = undefined;
        replaceSessionEntrySync(f.scope, { ...original, observerDigest: current, ...metadata });
      };
    }
    expect(await defaultPersistDigest({ ...f.scope, digest: proposed })).toBe(accepted);
    expect(delivery.commands).toEqual(["session.entry.patch.commit"]);
    expect(published).toHaveBeenCalledTimes(accepted ? 1 : 0);
    const expected = accepted ? proposed : current;
    for (const entry of [f.read(), loadSessionEntryReadOnly(f.scope)]) {
      expect(entry?.observerDigest).toEqual(expected);
      if (!lostReply) {
        expect(entry).toMatchObject(metadata);
      }
    }
    if (lostReply) {
      expect(loseReply).toHaveBeenCalledOnce();
      delivery.afterCommit = undefined;
      expect(await defaultPersistDigest({ ...f.scope, digest: proposed })).toBe(false);
      expect(published).toHaveBeenCalledOnce();
      expect(f.read()?.observerDigest).toEqual(proposed);
    }
  }),
);
