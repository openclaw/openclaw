import { expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  beginSessionWorkAdmission,
  getSessionWorkAdmissionOwnerRelease,
} from "./session-lifecycle-admission.js";

it("captures acquired owners without waiting for pending successors", async () => {
  const scope = "store-named-owner";
  const identities = ["agent:main:named-owner", "session-named-owner"];
  const owner = Symbol.for("openclaw.test.namedSessionWorkAdmissionOwner");
  const unrelated = await beginSessionWorkAdmission({ scope, identities, assertAllowed: () => {} });
  const started = createDeferred();
  const allowed = createDeferred();
  const admissionPromise = beginSessionWorkAdmission({
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
    const release = getSessionWorkAdmissionOwnerRelease({ scope, identities, owner });
    expect(release).toBeInstanceOf(Promise);
    expect(
      getSessionWorkAdmissionOwnerRelease({ scope, identities, owner, phase: "acquired" }),
    ).toBeUndefined();
    unrelated.release();
    expect(getSessionWorkAdmissionOwnerRelease({ scope, identities, owner })).toBeInstanceOf(
      Promise,
    );
    allowed.resolve();
    const admission = await admissionPromise;
    const laterAllowed = createDeferred();
    const laterAdmission = beginSessionWorkAdmission({
      scope,
      identities,
      owner,
      serializeOwner: true,
      assertAllowed: () => laterAllowed.promise,
    });
    const acquiredRelease = getSessionWorkAdmissionOwnerRelease({
      scope,
      identities,
      owner,
      phase: "acquired",
    });
    expect(acquiredRelease).toBeInstanceOf(Promise);
    admission.release();
    try {
      await acquiredRelease;
      await release;
      expect(getSessionWorkAdmissionOwnerRelease({ scope, identities, owner })).toBeInstanceOf(
        Promise,
      );
    } finally {
      laterAllowed.resolve();
      (await laterAdmission).release();
    }
    expect(getSessionWorkAdmissionOwnerRelease({ scope, identities, owner })).toBeUndefined();
  } finally {
    unrelated.release();
    allowed.resolve();
    (await admissionPromise).release();
  }
});
