import { expect, it } from "vitest";
import {
  type CommandPaletteItem,
  filterCommandPaletteItems,
  getStaticCommandPaletteCatalogItems,
} from "./command-palette-catalog-search.ts";

function expectItem(items: CommandPaletteItem[], expected: Partial<CommandPaletteItem>) {
  expect(items).toContainEqual(expect.objectContaining(expected));
}

it("opens meeting transcripts from search without querying agent chat history", () => {
  const items = filterCommandPaletteItems({
    query: "meeting",
    includeSlashCommands: false,
    sessionItems: [],
    catalogItems: [],
    desktopAvailable: false,
    custodianAvailable: false,
  });
  expectItem(items, { label: "Meetings", action: "nav:meetings" });
});
it("exposes app cards and permission-filtered settings sections without RPCs", () => {
  const regular = getStaticCommandPaletteCatalogItems(false);
  const admin = getStaticCommandPaletteCatalogItems(true);

  expectItem(regular, { category: "apps", label: "iPhone" });
  expectItem(regular, { category: "settings", action: "nav:profile" });
  expect(regular.some((item) => item.action === "nav:security")).toBe(false);
  expect(admin.some((item) => item.action === "nav:security")).toBe(true);
  expect(regular.some((item) => item.label === "Meeting capture")).toBe(false);
  expectItem(admin, {
    label: "Meeting capture",
    action: "nav:communications",
    search: "?section=transcripts",
  });
});
