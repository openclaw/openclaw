import { expect, it, vi } from "vitest";
import { createTestGatewayClient } from "../test-helpers/gateway-client.ts";
import {
  type CommandPaletteItem,
  filterCommandPaletteItems,
  getStaticCommandPaletteCatalogItems,
  loadCommandPaletteCatalogItems,
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

it("loads bounded name and description catalogs in parallel", async () => {
  const skill = { skillKey: "forecast-brief", name: "Forecast", description: "Weather" };
  const plugin = { id: "weather-helper", name: "Weather", description: "Tools" };
  const catalogs: Record<string, unknown> = {
    "cron.list": { jobs: [{ id: "nightly", name: "Nightly invoices" }] },
    "skills.status": { skills: [skill] },
    "plugins.list": { plugins: [plugin] },
  };
  const request = vi.fn(async (method: string) => {
    if (!Object.hasOwn(catalogs, method)) {
      throw new Error(`Unexpected method: ${method}`);
    }
    return catalogs[method];
  });

  const items = await loadCommandPaletteCatalogItems({
    client: createTestGatewayClient(request),
    agentId: "main",
    agents: async () => ({
      defaultId: "main",
      mainKey: "main",
      scope: "global",
      agents: [{ id: "main", name: "Main assistant" }],
    }),
    methodAvailable: () => true,
  });

  expectItem(items, { category: "agents", label: "Main assistant" });
  expectItem(items, { category: "automations", label: "Nightly invoices" });
  expectItem(items, { category: "skills", label: "Forecast", description: "Weather" });
  expectItem(items, {
    category: "plugins",
    label: "Weather",
    description: "Tools",
    icon: "plug",
  });
  expect(request).toHaveBeenCalledWith(
    "cron.list",
    expect.objectContaining({ includeDisabled: true, limit: 200, offset: 0, compact: true }),
  );
  expect(request).toHaveBeenCalledWith("skills.status", { agentId: "main" });
  expect(request).toHaveBeenCalledWith("plugins.list", {});
  expect(request).not.toHaveBeenCalledWith("models.list", expect.anything());
});
