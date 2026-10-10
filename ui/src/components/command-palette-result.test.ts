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

it.each([
  {
    name: "passive Markdown",
    catalog: false,
    description:
      "**Bold *needle***, ~~old~~, `config` [guide](https://example.com) ![diagram](https://example.com/image.png)\n\n| A | B |\n| --- | --- |\n| one | two |",
    query: "needle",
    contents: ["guide", "diagram"],
    nodes: [
      ["strong em mark", "needle"],
      ["s", "old"],
      ["code", "config"],
    ],
    forbidden: "a, img, table, pre, p",
  },
  {
    name: "escaped markup",
    catalog: false,
    description: "<img src=x onerror=alert(1)> **&lt;script&gt;**",
    query: "<img",
    contents: [],
    nodes: [
      ["mark", "<img"],
      ["strong", "<script>"],
    ],
    forbidden: "img, script",
  },
  {
    name: "literal catalog copy",
    catalog: true,
    description: "**Literal** description",
    query: "Literal",
    contents: [],
    nodes: [],
    forbidden: "strong",
  },
] satisfies Array<{
  name: string;
  catalog: boolean;
  description: string;
  query: string;
  contents: string[];
  nodes: [string, string][];
  forbidden: string;
}>)(
  "renders safe $name descriptions",
  ({ catalog, description, query, contents, nodes, forbidden }) => {
    render(
      renderCommandPaletteResult(
        {
          ...item,
          session: catalog ? undefined : item.session,
          category: catalog ? "skills" : "messages",
          description,
        },
        query,
      ),
      container,
    );
    const snippet = container.querySelector(".cmd-palette__item-desc")!;
    for (const [selector, text] of nodes) {
      expect(snippet.querySelector(selector)?.textContent).toBe(text);
    }
    for (const text of contents) {
      expect(snippet.textContent).toContain(text);
    }
    expect(snippet.querySelector(forbidden)).toBeNull();
    if (catalog) {
      expect(snippet.textContent).toBe(description);
    }
  },
);

it.each([
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
    description: "See [**example guide**](https://example.com/docs).",
    query: "example",
    expected: "See example guide.",
  },
])("keeps a passive match cue for $description", ({ description, query, expected }) => {
  render(renderCommandPaletteResult({ ...item, description }, query), container);
  const snippet = container.querySelector(".cmd-palette__item-desc")!;
  expect(snippet.textContent).toBe(expected);
  expect(snippet.querySelector("mark")?.textContent?.toLowerCase()).toBe(query.toLowerCase());
  expect(snippet.querySelector("a, img")).toBeNull();
});

it.each([true, false])("uses only explicit session ownership: %s", (hasOwner) => {
  render(
    renderCommandPaletteResult(
      {
        ...item,
        session: {
          ...item.session!,
          createdActor: { type: "human", id: "creator", label: "Former owner" },
          owner: hasOwner
            ? {
                actor: {
                  type: "human",
                  id: "owner",
                  label: "Current owner",
                  identity: { type: "profile", id: "owner" },
                },
              }
            : undefined,
        },
      },
      "needle",
      hasOwner ? { id: "main", name: "Assistant" } : { id: "main" },
    ),
    container,
  );
  expect(container.textContent).not.toContain("Former owner");
  if (hasOwner) {
    expect(container.textContent).toContain("Owned by Current owner");
    expect(container.querySelector(".cmd-palette__owner")).not.toBeNull();
  } else {
    expect(container.querySelector(".cmd-palette__owner")).toBeNull();
  }
});
