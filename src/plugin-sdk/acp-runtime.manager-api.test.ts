/** Reset custody remains core-internal without removing supported plugin operations. */
import { afterEach, expect, it } from "vitest";
import { getAcpSessionManager, testing } from "./acp-runtime.js";

afterEach(() => testing.resetAcpSessionManagerForTests());

it("preserves the plugin manager operations without exposing reset-only custody", () => {
  const manager = getAcpSessionManager();
  expect(manager.resolveSession({ cfg: {}, sessionKey: "" })).toEqual({
    kind: "none",
    sessionKey: "",
  });
  for (const operation of [
    "initializeSession",
    "runTurn",
    "cancelSession",
    "closeSession",
    "getObservabilitySnapshot",
  ] as const) {
    expect(manager[operation]).toBeTypeOf("function");
  }
  expect(manager).not.toHaveProperty("captureSessionRuntimeOwnership");
  expect(manager).not.toHaveProperty("forceDiscardSessionRuntime");
});
