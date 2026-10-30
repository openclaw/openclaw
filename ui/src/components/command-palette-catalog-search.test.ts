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
it("matches canonically equivalent catalog labels in either Unicode form", () => {
  const catalogItems: CommandPaletteItem[] = [
    {
      id: "skill-cafe",
      // macOS and many text sources store names in NFD.
      label: "Cafe\u0301-notes",
      icon: "zap",
      category: "skills",
      action: "nav:skills",
    },
    {
      id: "skill-plain",
      label: "plain-skill",
      icon: "zap",
      category: "skills",
      action: "nav:skills",
    },
  ];
  const nfcQuery = "Caf\u00e9";
  const nfdQuery = "Cafe\u0301";

  for (const query of [nfcQuery, nfdQuery]) {
    const items = filterCommandPaletteItems({
      query,
      includeSlashCommands: false,
      sessionItems: [],
      catalogItems,
      desktopAvailable: false,
      custodianAvailable: false,
    });
    expectItem(items, { id: "skill-cafe" });
    expect(items.some((item) => item.id === "skill-plain")).toBe(false);
  }
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
it("matches canonically equivalent catalog text in either Unicode form", () => {
  const name = "Đặng Café";
  const nfc = name.normalize("NFC");
  const nfd = name.normalize("NFD");
  const catalogItems: CommandPaletteItem[] = [
    {
      id: "plugin-nfd",
      label: nfd,
      icon: "plug",
      category: "plugins",
      action: "nav:plugins",
    },
    {
      id: "skill-nfc",
      label: "Skill",
      icon: "zap",
      category: "skills",
      action: "nav:skills",
      description: nfd,
    },
  ];
  const idsFor = (query: string) =>
    filterCommandPaletteItems({
      query,
      includeSlashCommands: false,
      sessionItems: [],
      catalogItems,
      desktopAvailable: false,
      custodianAvailable: false,
    }).map((item) => item.id);
  expect(idsFor(nfc)).toContain("plugin-nfd");
  expect(idsFor(nfd)).toContain("plugin-nfd");
  expect(idsFor(nfd)).toContain("skill-nfc");
});
