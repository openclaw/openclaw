/* @vitest-environment jsdom */
import { render } from "lit";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { CommandPaletteItem } from "./command-palette-catalog-search.ts";
import { renderCommandPaletteResult } from "./command-palette-result.ts";

const item: CommandPaletteItem = {
  id: "session-fixture",
  label: "Needle session",
  category: "messages",
  icon: "messageSquare",
  action: "session:agent:main:fixture",
  session: { key: "agent:main:fixture", kind: "direct", updatedAt: 1 },
};
let container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
});
afterEach(() => container.remove());

it.each([
  { label: "İstanbul needle", query: "NEEDLE", expected: "needle" },
  { label: "Literal [a+b] query", query: "[a+b]", expected: "[a+b]" },
  { label: "<img src=x onerror=alert(1)> needle", query: "<img", expected: "<img" },
])("highlights literal text safely in $label", ({ label, query, expected }) => {
  render(renderCommandPaletteResult({ ...item, label }, query), container);
  expect(container.querySelector("mark")?.textContent).toBe(expected);
  expect(container.querySelector(".cmd-palette__item-title")?.textContent?.trim()).toBe(label);
  expect(container.querySelector(".cmd-palette__item-title img")).toBeNull();
});

it("uses the explicit session owner, never the creator or a guessed transcript author", () => {
  render(
    renderCommandPaletteResult(
      {
        ...item,
        session: {
          ...item.session!,
          createdActor: { type: "human", id: "creator", label: "Former owner" },
          owner: {
            actor: {
              type: "human",
              id: "owner",
              label: "Current owner",
              identity: { type: "profile", id: "owner" },
            },
          },
        },
      },
      "needle",
      { id: "main", name: "Assistant" },
    ),
    container,
  );
  expect(container.textContent).toContain("Owner: Current owner");
  expect(container.textContent).not.toContain("Former owner");
  expect(container.querySelector(".cmd-palette__owner")).not.toBeNull();
});

it("leaves unknown ownership absent rather than borrowing the creator", () => {
  render(
    renderCommandPaletteResult(
      {
        ...item,
        session: {
          ...item.session!,
          createdActor: { type: "human", id: "creator", label: "Not the owner" },
        },
      },
      "needle",
      { id: "main" },
    ),
    container,
  );
  expect(container.querySelector(".cmd-palette__owner")).toBeNull();
  expect(container.textContent).not.toContain("Not the owner");
});
