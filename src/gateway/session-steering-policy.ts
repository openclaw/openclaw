import { runtimeConfigPublication } from "../config/runtime-config-publication.js";
import { readRuntimeConfig } from "../config/runtime-snapshot.js";
import type { SessionSourceAssertion } from "../config/sessions/session-source-authority.js";

/** Retain the config owner's disable epoch through asynchronous steering admission. */
export function captureSessionSteeringEnablement(): SessionSourceAssertion {
  const epoch = runtimeConfigPublication.steeringDisableEpoch;
  let revoked = false;
  const assertCurrent = () => {
    if (
      revoked ||
      epoch !== runtimeConfigPublication.steeringDisableEpoch ||
      readRuntimeConfig().gateway?.sessionControl?.steeringEnabled !== true
    ) {
      revoked = true;
      throw new Error("Gateway active steering is disabled or its admission was revoked");
    }
  };
  assertCurrent();
  return Object.assign(assertCurrent, {
    prepareSessionSource: async () => {
      assertCurrent();
      return { assertCurrent, checks: [] };
    },
  });
}
