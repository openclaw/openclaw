import { expect, it } from "vitest";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  captureSessionSharingAuthorityReconciliation,
  reconcileSessionSharingAuthoritiesBeforeAcquisition,
  unknownSharingAuthorities,
} from "./session-sharing-authority-state.js";

it("claims every selected recovery before overlapping acquisitions can consume one", async () => {
  const first = createDeferredCore();
  const runs = [0, 0];
  const identity = "recovery-overlap";
  const keys = ["agent:main:first", "agent:main:second"];
  const path = "/synthetic/recovery-overlap.sqlite";
  const owner = {};
  const markers = keys.map((key) => `file:${identity}\0${key}`);
  try {
    for (const [index, key] of keys.entries()) {
      unknownSharingAuthorities.set(markers[index], { owner });
      const recovery = captureSessionSharingAuthorityReconciliation(identity, [key], owner);
      recovery.prepare(path, async () => {
        runs[index]++;
        if (index === 0) {
          await first.promise;
        }
        recovery.settle();
      });
    }
    const pending = reconcileSessionSharingAuthoritiesBeforeAcquisition([path], keys);
    expect(runs).toEqual([1, 0]);
    expect(reconcileSessionSharingAuthoritiesBeforeAcquisition([path], [keys[1]])).toBeUndefined();
    first.resolve();
    await pending;
    expect(runs).toEqual([1, 1]);
    expect(markers.some((key) => unknownSharingAuthorities.has(key))).toBe(false);
  } finally {
    first.resolve();
    for (const key of markers) {
      unknownSharingAuthorities.delete(key);
    }
  }
});
