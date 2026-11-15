import { describe, expectTypeOf, it } from "vitest";
import type { GatewayRequestHandlerOptions } from "./core.js";

type BroadcastOptions = NonNullable<
  Parameters<GatewayRequestHandlerOptions["context"]["broadcast"]>[2]
>;
type ProjectionContext = Parameters<NonNullable<BroadcastOptions["prepareSessionProjection"]>>[3];

// Third-party publication callbacks can use the shipped logical session selection.
function projectPublishedSelection(context: ProjectionContext) {
  return context.createRunProjector()({
    requestedKey: "agent:main:example",
    canonicalKey: "agent:main:example",
    sessionId: "example-session",
    agentId: "main",
    defaultAgentId: "main",
  });
}

describe("released Gateway run projection selection", () => {
  it("keeps the logical selection accepted without a physical store argument", () => {
    expectTypeOf<ReturnType<typeof projectPublishedSelection>>().toEqualTypeOf<{
      active: boolean;
      runIds?: string[];
      status?: "queued";
    }>();
  });
});
