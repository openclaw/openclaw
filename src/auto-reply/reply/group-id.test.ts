// Tests group id derivation for channel sessions and persisted routes.
import { describe, expect, it } from "vitest";
import { extractExplicitGroupId } from "./group-id.js";

describe("extractExplicitGroupId simple targets", () => {
  it("extracts group ID from bare group: prefix with topic", () => {
    expect(extractExplicitGroupId("group:-1003776849159:topic:999")).toBe("-1003776849159");
  });
});
