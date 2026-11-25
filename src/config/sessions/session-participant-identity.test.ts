import { describe, expect, it } from "vitest";
import { readParticipantIdentity } from "./session-participant-identity.js";

const invalidIdentity = "Session participant identity is invalid; run openclaw doctor --fix.";

describe("stored participant identity decoding", () => {
  it("takes the actor id from its stored column without normalizing it", () => {
    expect(readParticipantIdentity('{"type":"profile","id":"ignored"}', " actor ")).toEqual({
      type: "profile",
      id: " actor ",
    });
  });

  it.each(["null", '{"type":"profile","__proto__":{}}'])(
    "rejects an invalid namespace with the existing repair guidance: %s",
    (namespace) => {
      expect(() => readParticipantIdentity(namespace, "actor-1")).toThrowError(
        new Error(invalidIdentity),
      );
    },
  );
});
