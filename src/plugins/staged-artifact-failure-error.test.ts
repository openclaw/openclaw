import { describe, expect, it } from "vitest";
import { ManagedPluginLifecycleError } from "./management-lifecycle-error.js";
import {
  classifyStagedArtifactFailure,
  StagedArtifactFailureError,
} from "./staged-artifact-failure-error.js";

describe("classifyStagedArtifactFailure", () => {
  it("wraps ordinary staging errors and non-Error causes in StagedArtifactFailureError", () => {
    const errorCause = new Error("staged manifest invalid");
    expect(() => classifyStagedArtifactFailure(errorCause)).toThrow(StagedArtifactFailureError);
    try {
      classifyStagedArtifactFailure(errorCause);
    } catch (thrown) {
      const error = thrown as StagedArtifactFailureError;
      expect(error).toBeInstanceOf(StagedArtifactFailureError);
      expect(error).not.toBeInstanceOf(ManagedPluginLifecycleError);
      expect(String(error.cause)).toBe("Error: staged manifest invalid");
    }

    // Non-Error causes are also wrapped.
    expect(() => classifyStagedArtifactFailure("string error")).toThrow(StagedArtifactFailureError);
  });

  it("passes ManagedPluginLifecycleError through unwrapped", () => {
    const cause = new ManagedPluginLifecycleError("capability consent rejected", {
      kind: "unavailable",
    });
    expect(() => classifyStagedArtifactFailure(cause)).toThrow(ManagedPluginLifecycleError);
    try {
      classifyStagedArtifactFailure(cause);
    } catch (thrown) {
      expect(thrown).toBe(cause);
      expect(thrown).not.toBeInstanceOf(StagedArtifactFailureError);
      expect((thrown as ManagedPluginLifecycleError).kind).toBe("unavailable");
    }
  });
});
