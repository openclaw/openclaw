import type { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import { describe, expectTypeOf, it } from "vitest";

describe("agent sessions SDK", () => {
  it("keeps SessionManager.persist public", () => {
    expectTypeOf<SessionManager["persist"]>().toBeFunction();
  });

  it("keeps tool-result preparation internal", () => {
    expectTypeOf<SessionManager>().not.toHaveProperty("prepareModelVisibleToolText");
    expectTypeOf<typeof import("openclaw/plugin-sdk/agent-sessions")>().not.toHaveProperty(
      "prepareSessionToolResult",
    );
    expectTypeOf<typeof import("openclaw/plugin-sdk/agent-sessions")>().not.toHaveProperty(
      "setSessionToolTextPreparer",
    );
  });
});
