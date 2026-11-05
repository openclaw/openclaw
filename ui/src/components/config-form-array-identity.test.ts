// @vitest-environment jsdom
import { expectDefined } from "@openclaw/normalization-core";
import { expect, it } from "vitest";
import { renderArrayFixture } from "../test-helpers/config-form-fixtures.tsx";
import type { JsonSchema } from "./config-form.shared.ts";

function arrayFixture(
  schema: JsonSchema,
  value: unknown[],
  onPatch?: (next: unknown[], render: (value: unknown[]) => void) => boolean | void,
) {
  const container = document.createElement("div");
  const render = (next: unknown[]): void =>
    renderArrayFixture(container, {
      schema,
      value: next,
      path: ["values"],
      onPatch: (_path, candidate) => {
        if (!Array.isArray(candidate)) {
          throw new Error("Expected an array patch");
        }
        return onPatch ? onPatch(candidate, render) : render(candidate);
      },
    });
  render(value);
  return {
    container,
    render,
    inputs: () =>
      Array.from(container.querySelectorAll<HTMLInputElement>(".settings-subrows input")),
    click: (label: string) =>
      expectDefined(
        container.querySelector<HTMLButtonElement>(`button[aria-label='${label}']`),
        label,
      ).click(),
  };
}

const strings: JsonSchema = { type: "array", items: { type: "string", default: "same" } };
function expectRows(actual: HTMLInputElement[], expected: (HTMLInputElement | undefined)[]) {
  expect(actual).toHaveLength(expected.length);
  expected.forEach((node, index) => expect(actual[index]).toBe(node));
}

it("keeps appended primitive identities unique after an equal row is removed", () => {
  const { click, inputs } = arrayFixture(strings, ["same", "same"]);
  const [first, second] = inputs();
  click("Remove item");
  expectRows(inputs(), [second]);
  click("Add");
  const appended = inputs();
  expect(appended.map((input) => input.value)).toEqual(["same", "same"]);
  expect(appended[0]).toBe(second);
  expect(appended[1]).not.toBe(first);
  expect(appended[1]).not.toBe(second);
});

it("removes row metadata from rejected candidate arrays", () => {
  const original = ["same", "same"];
  let rejected: unknown[] | undefined;
  const { click, inputs, render } = arrayFixture(strings, original, (candidate, update) => {
    rejected = candidate;
    update(candidate);
    return false;
  });
  const [, second] = inputs();
  click("Remove item");
  expectRows(inputs(), [second]);
  render(structuredClone(original));
  expect(inputs()).toHaveLength(2);
  const [restoredFirst, restoredSecond] = inputs();
  expect(restoredSecond).toBe(second);
  expect(restoredFirst).not.toBe(second);
  render(expectDefined(rejected, "rejected candidate"));
  expectRows(inputs(), [restoredFirst]);
});

it("matches cloned and reordered rows once, including equal occurrences", () => {
  const first = [{ name: "first" }, { name: "same" }, { name: "same" }];
  const { inputs, render } = arrayFixture(
    {
      type: "array",
      items: { type: "object", properties: { name: { type: "string" } } },
    },
    first,
  );
  const nodes = inputs();
  const reordered = structuredClone([first[1], first[0], first[2]]);
  for (const snapshot of [reordered, structuredClone(reordered)]) {
    render(snapshot);
    const current = inputs();
    expectRows(current, [nodes[1], nodes[0], nodes[2]]);
    expect(current.map((input) => input.value)).toEqual(["same", "first", "same"]);
  }
});

it("does not give an unchanged row's identity to a new equal value", () => {
  const { inputs, render } = arrayFixture(strings, ["first", "same"]);
  const [, survivor] = inputs();
  render(["same", "same"]);
  const next = inputs();
  expect(next[1]).toBe(survivor);
  expect(next[0]).not.toBe(survivor);
  expect(next.map((input) => input.value)).toEqual(["same", "same"]);
});
