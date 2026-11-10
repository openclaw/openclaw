/* @vitest-environment jsdom */

import { expect, it, onTestFinished, vi } from "vitest";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { DashboardAuthorFilter, type DashboardAuthorOption } from "./dashboard-tools.tsx";

function author(id: string, label: string): DashboardAuthorOption {
  return { id, label, avatar: { type: "human", id }, count: 1 };
}

it.each([
  ["김민수", "민", "민"],
  ["Kim 민수 Lee", "Lee", "Lee"],
  ["José García".normalize("NFD"), "garcia", "García".normalize("NFD")],
  ["ΝΙΚΟΣ", "κος", "ΚΟΣ"],
])("bolds the matched text of %j for %j", async (name, query, expected) => {
  const container = document.body.appendChild(document.createElement("div"));
  onTestFinished(() => container.remove());
  const authors = [author("target", name)];
  for (let index = 0; index < 8; index += 1) {
    authors.push(author(`other-${index}`, `Other ${index}`));
  }
  mountSolid(
    () => (
      <DashboardAuthorFilter
        authors={authors}
        filters={{ query: "", ownerIds: [], sort: "updated", view: "grid", group: "none" }}
        handlers={{ onFilterChange: vi.fn() }}
      />
    ),
    { container },
  );
  container.querySelector<HTMLButtonElement>(".dashboards-tools__trigger")!.click();
  const input = await waitForSolid(() => {
    const element = document.querySelector<HTMLInputElement>(".dashboards-authors__search input");
    expect(element).not.toBeNull();
    return element!;
  });
  input.value = query;
  input.dispatchEvent(new InputEvent("input", { bubbles: true }));
  await waitForSolid(() => {
    const names = [...document.querySelectorAll(".dashboards-authors__name")];
    expect(names.map((element) => element.textContent)).toEqual([name]);
    expect(names[0]?.querySelector("b")?.textContent).toBe(expected);
  });
});
