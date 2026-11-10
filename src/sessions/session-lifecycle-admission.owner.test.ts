import { expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { selectedEffects } from "./session-controller.lifecycle-projections.js";
import { captureSessionControllerEffects } from "./session-controller.lifecycle-work.js";
import { beginSessionEffect } from "./session-controller.lifecycle.js";
import { targetFrom } from "./session-controller.target.js";

it("captures acquired owners without waiting for pending successors", async () => {
  const scope = "store-named-owner";
  const identities = ["agent:main:named-owner", "session-named-owner"];
  const target = targetFrom({ scope, identities });
  const owner = Symbol.for("openclaw.test.namedSessionWorkAdmissionOwner");
  const unrelated = await beginSessionEffect({ scope, identities, assertAllowed: () => {} });
  const started = createDeferred();
  const allowed = createDeferred();
  const admissionPromise = beginSessionEffect({
    scope,
    identities,
    owner,
    assertAllowed: async () => {
      started.resolve();
      await allowed.promise;
    },
  });
  try {
    await started.promise;
    const pending = [...selectedEffects([target])].find((effect) => effect.owner === owner);
    expect(pending).toBeDefined();
    const release = pending!.ref.released;
    expect(
      captureSessionControllerEffects({ scope, identities }).map(({ effect }) => effect.ref),
    ).toEqual([unrelated]);
    unrelated.release();
    expect(pending!.ref.isActive()).toBe(true);
    expect(captureSessionControllerEffects({ scope, identities })).toEqual([]);
    allowed.resolve();
    const admission = await admissionPromise;
    expect(admission).toBe(pending!.ref);
    const laterStarted = createDeferred();
    const laterAllowed = createDeferred();
    const laterAdmission = beginSessionEffect({
      scope,
      identities,
      owner,
      serializeOwner: true,
      assertAllowed: () => {
        laterStarted.resolve();
        expect(admission.isActive()).toBe(false);
        return laterAllowed.promise;
      },
    });
    const acquired = captureSessionControllerEffects({ scope, identities });
    expect(acquired.map(({ effect }) => effect.ref)).toEqual([admission]);
    const acquiredRelease = acquired[0]!.released;
    expect(acquiredRelease).toBe(release);
    admission.release();
    try {
      await acquiredRelease;
      await release;
      await laterStarted.promise;
      expect(captureSessionControllerEffects({ scope, identities })).toEqual([]);
      expect(selectedEffects([target]).size).toBe(1);
    } finally {
      laterAllowed.resolve();
      const later = await laterAdmission;
      later.release();
      await later.released;
    }
    expect(selectedEffects([target]).size).toBe(0);
  } finally {
    unrelated.release();
    allowed.resolve();
    (await admissionPromise).release();
  }
});
