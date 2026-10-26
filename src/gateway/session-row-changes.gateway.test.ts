import "../config/sessions/session-entry-patch-delivery.test-support.js";
import { expect, it, onTestFinished, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { createSessionCompoundWorkerFixture } from "../config/sessions/session-compound-worker.test-support.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { setSessionActivitySummaryState } from "./session-activity-summary-state.js";
import { persistGatewaySessionLifecycleEvent } from "./session-lifecycle-state.js";
const { getSessionEntryPatchDelivery } =
  await import("../config/sessions/session-entry-patch-delivery.test-support.js");

function observeChanges() {
  const changed = vi.fn();
  const facts = vi.fn();
  // The native store also publishes stored facts; these tests own the runtime adapter.
  onTestFinished(
    sessionChanges.subscribe((change) => {
      if (change.scope === "runtime") {
        changed(change);
      }
    }),
  );
  onTestFinished(
    sessionChanges.subscribeFacts((change) => {
      if (change.scope === "runtime") {
        facts(change);
      }
    }),
  );
  return { changed, facts };
}

it("publishes lifecycle errors only after an accepted commit", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    const { scope: target } = createSessionCompoundWorkerFixture();
    setRuntimeConfigSnapshot({ session: { store: target.storePath } });
    const delivery = getSessionEntryPatchDelivery();
    const { changed, facts } = observeChanges();
    const write = (sessionId = target.sessionId) =>
      persistGatewaySessionLifecycleEvent({
        sessionKey: target.sessionKey,
        agentId: target.agentId,
        event: { sessionId, runId: "row-run", ts: 2_000, data: { phase: "error" } },
      });
    delivery.beforeCommit = () => {
      throw new Error("commit rejected");
    };
    await expect(write()).rejects.toThrow("commit rejected");
    expect(changed).not.toHaveBeenCalled();
    expect(facts).not.toHaveBeenCalled();
    delivery.beforeCommit = undefined;
    await write();
    const { sessionId: _sessionId, ...scope } = target;
    const publication = { ...scope, scope: "runtime" };
    expect(changed).toHaveBeenCalledExactlyOnceWith(publication);
    expect(facts).toHaveBeenCalledExactlyOnceWith({ ...publication, facts: { kind: "unchanged" } });
    await write("replaced-generation");
    expect(changed).toHaveBeenCalledTimes(1);
    expect(facts).toHaveBeenCalledTimes(1);
  }));

it("publishes activity admission, updates, and owner-held drops", () => {
  const { changed } = observeChanges();
  const owner = Symbol("activity-owner");
  const successor = Symbol("next-activity-owner");
  const activityTarget = { key: "agent:main:owner-publications", agentId: "main" };
  const set = setSessionActivitySummaryState.bind(null, activityTarget);
  const value = {
    sessionId: "owner-publications",
    storePath: "/tmp/owner-publications/sessions.json",
    state: "stale" as const,
  };
  try {
    expect(set(owner, value)).toBe(true);
    expect(set(owner, value)).toBe(false);
    expect(set(owner, { ...value, state: "updating" })).toBe(true);
    expect(set(owner, { ...value, state: "updating" }, true)).toBe(true);
    expect(set(successor, value)).toBe(true);
    expect(set(owner)).toBe(false);
    expect(set(successor)).toBe(true);
    const publication = { sessionKey: activityTarget.key, agentId: "main", scope: "runtime" };
    expect(changed.mock.calls).toEqual(Array.from({ length: 5 }, () => [publication]));
  } finally {
    set(owner);
    set(successor);
  }
});
