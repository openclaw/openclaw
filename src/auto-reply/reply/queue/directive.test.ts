import { expect, it } from "vitest";
import { extractQueueDirective } from "./directive.js";

it.each(["How does /queue work?", "Explain /queue behavior please"])(
  "preserves inline prose: %s",
  (body) => {
    expect(extractQueueDirective(body)).toMatchObject({ cleaned: body, hasDirective: false });
  },
);

it("retains strict native errors and valid directives", () => {
  expect(extractQueueDirective("/queue work?", { strict: true })).toMatchObject({
    hasDirective: true,
    rawMode: "work?",
    queueMode: undefined,
  });
  expect(extractQueueDirective("/queue: backlog")).toMatchObject({ hasDirective: true });
  expect(extractQueueDirective("/queue collect")).toMatchObject({
    hasDirective: true,
    queueMode: "collect",
    cleaned: "",
  });
});
