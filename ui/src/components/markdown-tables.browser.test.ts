import { createComponent } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { MessageMarkdown } from "../pages/chat/components/chat-message-text-view.tsx";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { flush } from "../test-helpers/solid-settle.ts";
import "../styles/base.css";
import "../styles/chat/text.css";
import {
  enhanceMarkdownTables,
  handleMarkdownTableInteraction,
  releaseMarkdownTables,
} from "./markdown-tables.ts";
import { toSanitizedMarkdownHtml } from "./markdown.ts";

const originalDirection = document.documentElement.getAttribute("dir");
let owner: HTMLElement | undefined;
let unmount: (() => void) | undefined;

afterEach(() => {
  if (owner) {
    releaseMarkdownTables(owner);
    unmount?.();
    unmount = undefined;
    owner.remove();
    owner = undefined;
  }
  if (originalDirection === null) {
    document.documentElement.removeAttribute("dir");
  } else {
    document.documentElement.setAttribute("dir", originalDirection);
  }
});

describe("expanded Markdown table direction", () => {
  it("updates overflow masks after horizontal scrolling and viewport resizing", async () => {
    owner = document.body.appendChild(document.createElement("section"));
    owner.className = "chat-text";
    owner.style.width = "180px";
    owner.innerHTML = toSanitizedMarkdownHtml("| Name | Value |\n| --- | --- |\n| Alpha | One |", {
      tableInteractions: "enabled",
    });
    owner.querySelector("table")!.style.width = "800px";
    enhanceMarkdownTables(owner);
    const shell = owner.querySelector<HTMLElement>(".markdown-table")!;
    const viewport = owner.querySelector<HTMLElement>(".markdown-table__viewport")!;
    const masks = () => [
      shell.classList.contains("markdown-table--can-scroll-left"),
      shell.classList.contains("markdown-table--can-scroll-right"),
    ];
    await expect.poll(masks).toEqual([false, true]);
    viewport.scrollLeft = viewport.scrollWidth - viewport.clientWidth;
    await expect.poll(masks).toEqual([true, false]);
    owner.style.width = "1000px";
    await expect.poll(masks).toEqual([false, false]);
    owner.style.width = "180px";
    await expect.poll(masks).toEqual([false, true]);
  });

  it.each([
    { pageDirection: "ltr", message: "مرحبا", firstColumnOnRight: true },
    { pageDirection: "rtl", message: "Hello", firstColumnOnRight: false },
  ])("preserves message column order in a $pageDirection page", async (fixture) => {
    document.documentElement.dir = fixture.pageDirection;
    owner = document.body.appendChild(document.createElement("section"));
    owner.addEventListener("click", handleMarkdownTableInteraction);
    ({ unmount } = mountSolid(
      () =>
        createComponent(MessageMarkdown, {
          markdown: `${fixture.message}\n\n| First | Second | Third |\n| --- | --- | --- |\n| A | B | C |`,
          messageKey: "table-direction",
          options: { role: "assistant", isStreaming: false },
          markdownOptions: { tableInteractions: "enabled" },
        }),
      { container: owner },
    ));
    flush();

    const inlineTable = owner.querySelector("table")!;
    const firstColumnOnRight = (table: HTMLTableElement) => {
      const cells = table.rows[0]!.cells;
      return cells[0]!.getBoundingClientRect().left > cells[2]!.getBoundingClientRect().left;
    };
    expect(firstColumnOnRight(inlineTable)).toBe(fixture.firstColumnOnRight);

    await page.elementLocator(owner).getByRole("button", { name: "Expand table" }).click();
    await expect.element(page.getByRole("dialog", { name: "Expanded table" })).toBeVisible();
    const expandedTable = owner.querySelector<HTMLTableElement>(".markdown-table-dialog table")!;
    expect(firstColumnOnRight(expandedTable)).toBe(fixture.firstColumnOnRight);
  });
});
