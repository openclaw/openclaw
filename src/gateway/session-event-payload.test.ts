import { expect, it } from "vitest";
import { buildGatewaySessionEventFields } from "./session-event-payload.js";

it("projects the created actor and explicitly clears it for actorless sessions", () => {
  expect(
    buildGatewaySessionEventFields({
      sessionRow: {
        key: "agent:main:owned",
        kind: "direct",
        updatedAt: 1,
        createdActor: { type: "human", id: "profile-ada", label: "Ada" },
      },
    }).createdActor,
  ).toEqual({ type: "human", id: "profile-ada", label: "Ada" });

  expect(
    buildGatewaySessionEventFields({
      sessionRow: { key: "agent:main:ownerless", kind: "direct", updatedAt: 2 },
    }).createdActor,
  ).toBeNull();
});
