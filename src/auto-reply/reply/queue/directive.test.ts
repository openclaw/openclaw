import { expect, it } from "vitest";
import { parseInlineSessionDirectives as parse } from "../directive-handling.parse.js";

it.each(["How does /queue work?", "Explain /queue behavior please", "/queue work?"])(
  "preserves text queue prose: %s",
  (body) => {
    const parsed = parse(body, { command: { kind: "text", name: "queue" } });
    expect(parsed).toMatchObject({ cleaned: body, hasQueueDirective: false });
    expect(parsed.rawQueueMode).toBeUndefined();
    expect(parsed.command).toBeUndefined();
  },
);

it("retains invalid native queue arguments for validation", () => {
  const parsed = parse("/queue work?", { command: { kind: "native", name: "queue" } });
  expect(parsed).toMatchObject({ cleaned: "", hasQueueDirective: true, rawQueueMode: "work?" });
  expect(parsed.queueMode).toBeUndefined();
  expect(parsed.command).toEqual({ name: "queue" });
});

it.each(["text", "native"] as const)("retains explicit and valid %s queue directives", (kind) => {
  const command = { kind, name: "queue" } as const;
  const invalid = parse("/queue: backlog", { command });
  expect(invalid).toMatchObject({ cleaned: "", hasQueueDirective: true, rawQueueMode: "backlog" });
  expect(invalid.queueMode).toBeUndefined();
  expect(parse("/queue collect", { command })).toMatchObject({
    hasQueueDirective: true,
    queueMode: "collect",
    cleaned: "",
  });
});
