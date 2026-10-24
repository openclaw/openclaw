import { expect, it } from "vitest";
/* @vitest-environment jsdom */
import { mountSolid } from "../test-helpers/mount-solid.ts";
import type { CommandPaletteItem } from "./command-palette-catalog-search.ts";
import { CommandPaletteResult } from "./command-palette-result.tsx";

const item: CommandPaletteItem = {
  id: "session-fixture",
  label: "Needle session",
  category: "messages",
  icon: "messageSquare",
  action: "session:agent:main:fixture",
  session: { key: "agent:main:fixture", kind: "direct", updatedAt: 1 },
};
type Agent = Parameters<typeof CommandPaletteResult>[0]["agent"];
function renderResult(overrides: Partial<CommandPaletteItem>, query: string, agent?: Agent) {
  const props = { item: { ...item, ...overrides }, query, agent };
  return mountSolid(() => <CommandPaletteResult {...props} />).container;
}

it.each([
  ["İstanbul needle", "NEEDLE", "needle"],
  ["Literal [a+b] query", "[a+b]", "[a+b]"],
  ["<img src=x onerror=alert(1)> needle", "<img", "<img"],
])("highlights literal text safely in %s", (label, query, expected) => {
  const container = renderResult({ label }, query);
  expect(container.querySelector("mark")?.textContent).toBe(expected);
  expect(container.querySelector(".cmd-palette__item-title")?.textContent?.trim()).toBe(label);
  expect(container.querySelector(".cmd-palette__item-title img")).toBeNull();
});

it.each<[string, string, [string, string][], string, boolean?, string[]?]>([
  [
    "**Bold *needle***, ~~old~~, `config` [guide](https://example.com) ![diagram](https://example.com/image.png)\n\n| A | B |\n| --- | --- |\n| one | two |",
    "needle",
    [
      ["strong em mark", "needle"],
      ["s", "old"],
      ["code", "config"],
    ],
    "a, img, table, pre, p",
    false,
    ["guide", "diagram"],
  ],
  [
    "<img src=x onerror=alert(1)> **&lt;script&gt;**",
    "<img",
    [
      ["mark", "<img"],
      ["strong", "<script>"],
    ],
    "img, script",
  ],
  ["**Literal** description", "Literal", [], "strong", true],
])(
  "renders safe %s descriptions",
  (description, query, nodes, forbidden, catalog = false, contents = []) => {
    const container = renderResult(
      {
        session: catalog ? undefined : item.session,
        category: catalog ? "skills" : "messages",
        description,
      },
      query,
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
  ["See ![A &amp; B](https://example.com/image.png).", "&", "See A & B."],
  ["See [**ex**ample](https://example.co).", "example", "See example (https://example.co)."],
  ["See [guide](https://example.com/café).", "café", "See guide (https://example.com/café)."],
  ["See ![diagram](https://例.テスト/図).", "テスト", "See diagram (https://例.テスト/図)."],
  ["See <https://example.com/caf%C3%A9>.", "%C3%A9", "See https://example.com/caf%C3%A9."],
  ["See [**example guide**](https://example.com/docs).", "example", "See example guide."],
])("keeps a passive match cue for %s", (description, query, expected) => {
  const container = renderResult({ description }, query);
  const snippet = container.querySelector(".cmd-palette__item-desc")!;
  expect(snippet.textContent).toBe(expected);
  expect(snippet.querySelector("mark")?.textContent?.toLowerCase()).toBe(query.toLowerCase());
  expect(snippet.querySelector("a, img")).toBeNull();
});

it.each([true, false])("uses only explicit session ownership: %s", (hasOwner) => {
  const container = renderResult(
    {
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
  );
  expect(container.textContent).not.toContain("Former owner");
  if (hasOwner) {
    expect(container.textContent).toContain("Owned by Current owner");
    expect(container.querySelector(".cmd-palette__owner")).not.toBeNull();
  } else {
    expect(container.querySelector(".cmd-palette__owner")).toBeNull();
  }
});
