// @vitest-environment jsdom
import { expect, it } from "vitest";
import { placeComposerDictation } from "./composer-dictation-session.ts";

it("placeComposerDictation spaces inserted and replaced selections", () => {
  const place = (start: number, end: number, spoken: string) =>
    placeComposerDictation(spoken, null, { start, end, value: "hello world" });
  expect(place(6, 6, "brave new")).toMatchObject({ value: "hello brave new world", caret: 16 });
  expect(place(6, 11, "there")).toMatchObject({ value: "hello there", caret: 11 });
});

it("places reviewed literal bodies without trimming their authored edge whitespace", () => {
  const body = "\n001 {{name}}\n\n<date> $HOME\n";
  expect(
    placeComposerDictation(body, null, { start: 0, end: 0, value: "" }, undefined, undefined, true)
      .value,
  ).toBe(body);
  expect(placeComposerDictation(body, null, { start: 0, end: 0, value: "" }).value).toBe(
    body.trim(),
  );
});
