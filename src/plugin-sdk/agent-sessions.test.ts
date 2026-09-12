import type { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import { describe, expectTypeOf, it } from "vitest";

describe("agent sessions SDK", () => {
  it("keeps SessionManager.persist public", () => {
    expectTypeOf<SessionManager["persist"]>().toBeFunction();
  });
});
