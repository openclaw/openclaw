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

it("renders only passive inline markup in message descriptions", () => {
  const description =
    "<img src=x onerror=alert(1)> **Bold *needle***, ~~old~~, `config` [guide](https://example.com) ![diagram](https://example.com/image.png) **&lt;script&gt;**\n\n| A | B |\n| --- | --- |\n| one | two |";
  const snippet = renderResult({ description }, "needle").querySelector(".cmd-palette__item-desc")!;
  for (const [selector, text] of Object.entries({
    "strong em mark": "needle",
    s: "old",
    code: "config",
  })) {
    expect(snippet.querySelector(selector)?.textContent).toBe(text);
  }
  for (const text of ["guide", "diagram", "<script>"]) {
    expect(snippet.textContent).toContain(text);
  }
  expect(snippet.querySelector("a, img, script, table, pre, p")).toBeNull();
});

it("keeps catalog descriptions literal", () => {
  const description = "**Literal** description";
  const snippet = renderResult(
    { session: undefined, category: "skills", description },
    "Literal",
  ).querySelector(".cmd-palette__item-desc")!;
  expect(snippet.textContent).toBe(description);
  expect(snippet.querySelector("strong")).toBeNull();
});

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
  const actor = { type: "human", id: "owner", label: "Current owner" } as const;
  const container = renderResult(
    {
      session: {
        ...item.session!,
        createdActor: { type: "human", id: "creator", label: "Former owner" },
        owner: hasOwner ? { actor } : undefined,
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
