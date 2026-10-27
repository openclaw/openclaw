/* @vitest-environment jsdom */
import { expect, it } from "vitest";
import {
  mountRoster,
  selectFilter,
} from "../test-helpers/app-sidebar-cases/roster.test-support.ts";
import "../test-helpers/app-sidebar-suite.ts";
import "./app-sidebar.tsx";

it("shows the current status before opening filters and updates it after each choice", async () => {
  const { sidebar } = await mountRoster();
  const trigger = () => sidebar.querySelector<HTMLButtonElement>(".sidebar-session-sort");
  expect(trigger()?.textContent?.trim()).toBe("Active");
  expect(trigger()?.getAttribute("aria-label")).toBe("Filter & sort · Active");
  expect(trigger()?.getAttribute("aria-description")).toBe("Status: Active");

  for (const [value, label] of [
    ["snoozed", "Snoozed"],
    ["archived", "Archived"],
    ["all", "All"],
    ["active", "Active"],
  ]) {
    await selectFilter(sidebar, `status:${value}`);
    expect(trigger()?.textContent?.trim()).toBe(label);
    expect(trigger()?.getAttribute("aria-label")).toBe(`Filter & sort · ${label}`);
    expect(trigger()?.getAttribute("aria-description")).toBe(`Status: ${label}`);
  }
});
