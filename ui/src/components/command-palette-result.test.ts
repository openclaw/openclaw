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

it("renders basic Markdown in message snippets without interactive or block content", () => {
  render(
    renderCommandPaletteResult(
      {
        ...item,
        description:
          "**Bold *needle***, ~~old~~, `config` [guide](https://example.com) ![diagram](https://example.com/image.png)\n\n| A | B |\n| --- | --- |\n| one | two |",
      },
      "needle",
    ),
    container,
  );
  const snippet = container.querySelector(".cmd-palette__item-desc")!;
  expect(snippet.querySelector("strong em mark")?.textContent).toBe("needle");
  expect(snippet.querySelector("s")?.textContent).toBe("old");
  expect(snippet.querySelector("code")?.textContent).toBe("config");
  expect(snippet.textContent).toContain("guide");
  expect(snippet.textContent).toContain("diagram");
  expect(snippet.querySelector("a, img, table, pre, p")).toBeNull();
});

it.each([
  {
    description: "See ![**diagram**](https://example.com/image.png).",
    query: "diagram",
    expected: "See diagram.",
  },
  {
    description: "See ![A &amp; B](https://example.com/image.png).",
    query: "&",
    expected: "See A & B.",
  },
  {
    description: "See [**ex**ample](https://example.com/docs).",
    query: "example",
    expected: "See example (https://example.com/docs).",
  },
  {
    description: "See [guide](https://example.com/café).",
    query: "café",
    expected: "See guide (https://example.com/café).",
  },
  {
    description: "See ![diagram](https://例え.テスト/図.png).",
    query: "テスト",
    expected: "See diagram (https://例え.テスト/図.png).",
  },
  {
    description: "See <https://example.com/caf%C3%A9>.",
    query: "%C3%A9",
    expected: "See https://example.com/caf%C3%A9.",
  },
  {
    description: "See [guide](https://example.com/docs).",
    query: "EXAMPLE",
    expected: "See guide (https://example.com/docs).",
  },
  {
    description: "See [**example guide**](https://example.com/docs).",
    query: "example",
    expected: "See example guide.",
  },
  {
    description: "See <https://example.com/docs>.",
    query: "example",
    expected: "See https://example.com/docs.",
  },
  {
    description: "See ![diagram](https://example.com/image.png).",
    query: "image.png",
    expected: "See diagram (https://example.com/image.png).",
  },
])("keeps a passive match cue for $description", ({ description, query, expected }) => {
  render(renderCommandPaletteResult({ ...item, description }, query), container);
  const snippet = container.querySelector(".cmd-palette__item-desc")!;
  expect(snippet.textContent).toBe(expected);
  expect(snippet.querySelector("mark")?.textContent?.toLowerCase()).toBe(query.toLowerCase());
  expect(snippet.querySelector("a, img")).toBeNull();
});

it("escapes raw HTML and encoded markup in message snippets", () => {
  render(
    renderCommandPaletteResult(
      { ...item, description: "<img src=x onerror=alert(1)> **&lt;script&gt;**" },
      "<img",
    ),
    container,
  );
  const snippet = container.querySelector(".cmd-palette__item-desc")!;
  expect(snippet.querySelector("img, script")).toBeNull();
  expect(snippet.querySelector("mark")?.textContent).toBe("<img");
  expect(snippet.querySelector("strong")?.textContent).toBe("<script>");
});

it("keeps catalog descriptions literal", () => {
  render(
    renderCommandPaletteResult(
      { ...item, session: undefined, category: "skills", description: "**Literal** description" },
      "Literal",
    ),
    container,
  );
  const snippet = container.querySelector(".cmd-palette__item-desc")!;
  expect(snippet.querySelector("strong")).toBeNull();
  expect(snippet.textContent).toBe("**Literal** description");
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
  expect(container.textContent).toContain("Owned by Current owner");
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
