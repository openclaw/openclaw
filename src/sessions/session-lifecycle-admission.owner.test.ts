import { expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  beginSessionEffect,
  getCompetingSessionWorkAdmissionRelease,
} from "./session-controller.lifecycle.js";

it("captures acquired owners without waiting for pending successors", async () => {
  const scope = "store-named-owner";
  const identities = ["agent:main:named-owner", "session-named-owner"];
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
    const release = getCompetingSessionWorkAdmissionRelease({ scope, identities, owner });
    expect(release).toBeInstanceOf(Promise);
    expect(
      getCompetingSessionWorkAdmissionRelease({
        scope,
        identities,
        owner,
        excludePendingOwner: owner,
      }),
    ).toBeUndefined();
    unrelated.release();
    expect(getCompetingSessionWorkAdmissionRelease({ scope, identities, owner })).toBeInstanceOf(
      Promise,
    );
    allowed.resolve();
    const admission = await admissionPromise;
    const laterAllowed = createDeferred();
    const laterAdmission = beginSessionEffect({
      scope,
      identities,
      owner,
      serializeOwner: true,
      assertAllowed: () => laterAllowed.promise,
    });
    const acquiredRelease = getCompetingSessionWorkAdmissionRelease({
      scope,
      identities,
      owner,
      excludePendingOwner: owner,
    });
    expect(acquiredRelease).toBeInstanceOf(Promise);
    admission.release();
    try {
      await acquiredRelease;
      await release;
      expect(getCompetingSessionWorkAdmissionRelease({ scope, identities, owner })).toBeInstanceOf(
        Promise,
      );
    } finally {
      laterAllowed.resolve();
      (await laterAdmission).release();
    }
    expect(getCompetingSessionWorkAdmissionRelease({ scope, identities, owner })).toBeUndefined();
  } finally {
    unrelated.release();
    allowed.resolve();
    (await admissionPromise).release();
  }
});
