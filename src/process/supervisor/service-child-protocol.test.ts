import { expect, it } from "vitest";
import { readServiceChildReady } from "./service-child-protocol.js";

it("keeps older native peers usable without inventing a birth identity", () => {
  expect(
    readServiceChildReady(
      { type: "ready", commandPid: 17, anchorPid: 16, treeOwnership: "linux-subreaper" },
      true,
    ),
  ).toEqual({ ok: true });
  expect(readServiceChildReady({ type: "ready", commandPid: 17, anchorPid: 16 }, false)).toEqual({
    ok: true,
  });
});

it.for([-1, Number.NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1])(
  "refuses invalid native birth %s",
  (commandStartIdentity) => {
    expect(
      readServiceChildReady(
        {
          type: "ready",
          commandPid: 17,
          anchorPid: 16,
          treeOwnership: "linux-subreaper",
          commandStartIdentity,
        },
        true,
      ),
    ).toEqual({ ok: false, error: "invalid native root birth identity" });
  },
);

it("binds native birth to its selected ownership contract and immutable observed root", () => {
  const message = {
    type: "ready" as const,
    commandPid: 17,
    anchorPid: 16,
    treeOwnership: "linux-subreaper" as const,
    commandStartIdentity: 7,
  };
  expect(readServiceChildReady(message, false)).toEqual({
    ok: false,
    error: "process owner did not admit the selected ownership contract",
  });
  const result = readServiceChildReady(message, true);
  message.commandStartIdentity = 8;
  expect(result).toEqual({ ok: true, identity: { pid: 17, startIdentity: 7 } });
  if (!result.ok) {
    throw new Error("Missing ready receipt");
  }
  expect(Object.isFrozen(result.identity)).toBe(true);
});
