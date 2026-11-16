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

it("lists named commands, sessions, archived sessions, loose matches, then message hits", () => {
  const session = (label: string, category: CommandPaletteItem["category"]) => ({
    id: `session-${label}`,
    label,
    icon: "messageSquare" as const,
    category,
    action: `session:${label}`,
    session: { key: label, kind: "direct" as const, updatedAt: 1 },
  });
  const setting = (label: string, description?: string): CommandPaletteItem => ({
    id: `settings-${label}`,
    label,
    icon: "settings",
    category: "settings",
    action: "nav:appearance",
    description,
  });
  const items = filterCommandPaletteItems({
    query: "voice",
    includeSlashCommands: false,
    sessionItems: [
      session("Fix voice notes", "chats"),
      session("Voice", "chats"),
      session("Old voice notes", "archived"),
      session("message hit", "messages"),
    ],
    catalogItems: [
      setting("Talk", "Wake word and voice replies"),
      setting("Talk voice"),
      setting("Voice"),
    ],
    desktopAvailable: false,
    custodianAvailable: false,
  });
  expect(items.map((item) => `${item.category}:${item.label}`)).toEqual([
    "settings:Voice",
    "settings:Talk voice",
    "chats:Fix voice notes",
    "chats:Voice",
    "archived:Old voice notes",
    "more:Talk",
    "messages:message hit",
  ]);
});
