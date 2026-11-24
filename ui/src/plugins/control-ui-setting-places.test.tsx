import { afterEach, expect, it, vi } from "vitest";
import type { ControlUiPluginDistribution } from "./control-ui-distribution.ts";
import { findSettingPlace } from "./control-ui-setting-places.ts";
import { createControlUiSettingsComponents } from "./control-ui-settings-components.solid.tsx";

// mock-isolation: the production Vite adapter replaces this inventory with packaged plugins.
const packaged = vi.hoisted(() => [] as ControlUiPluginDistribution[]);
vi.mock("./control-ui-distribution.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./control-ui-distribution.ts")>()),
  controlUiPluginDistributions: packaged,
}));
afterEach(() => {
  packaged.length = 0;
  document.body.replaceChildren();
});

const settings = {
  "plugin.fixture.schedule": { label: "Schedule" },
  "plugin.fixture.phase.*": { label: "Phase" },
};

function distribute() {
  packaged.push({
    pluginId: "fixture",
    name: "Fixture Chat",
    revision: "r1",
    activation: "settings-only",
    settingsViews: [
      { section: "memory", panel: "overview", settings },
      {
        section: "channels",
        panel: "detail",
        channelId: "fixture-chat",
        settings: { "channels.fixture-chat.token": { label: "Token" } },
      },
    ],
    entry: "/packaged/index.js",
    styles: [],
    imports: [],
  });
}

it("resolves plugin setting IDs to the page their view sits on, after core IDs", () => {
  expect(findSettingPlace("plugin.fixture.schedule")).toBeUndefined();
  distribute();
  expect(findSettingPlace("plugin.fixture.schedule")).toMatchObject({
    id: "plugin.fixture.schedule",
    entry: { label: "Schedule" },
    page: { path: "/settings/memory", title: "Memory" },
  });
  expect(findSettingPlace("plugin.fixture.phase.deep")?.entry.label).toBe("Phase");
  expect(findSettingPlace("channels.fixture-chat.token")?.page).toMatchObject({
    path: "/settings/channels?channel=fixture-chat",
    title: "Channels > Fixture Chat",
  });
  expect(findSettingPlace("mcp.apps.enabled")?.page.path).toBe("/settings/mcp");
  expect(findSettingPlace("plugin.fixture.other")).toBeUndefined();
});

it("draws declared setting IDs on host rows and refuses undeclared ones", () => {
  const abort = new AbortController();
  const components = createControlUiSettingsComponents(abort.signal, settings);
  const row = document.body.appendChild(document.createElement("div"));
  const handle = components.mountRow(row, { setting: "plugin.fixture.phase.deep", title: "Deep" });
  const element = row.querySelector<HTMLElement>(".settings-row")!;
  expect(element.id).toBe("plugin.fixture.phase.deep");
  expect(element.querySelector("#plugin\\.fixture\\.phase\\.deep-title")?.textContent).toBe("Deep");
  const info = document.body.appendChild(document.createElement("div"));
  components.mountNavigation(info, { info: true, title: "Open", onClick: () => {} });
  expect(info.querySelector(".settings-row")?.hasAttribute("data-settings-info")).toBe(true);

  const refusal =
    'Setting ID "gateway.port" is not declared for this Settings view. Declare it in openclaw.plugin.json controlUi.settingsViews[].settings.';
  const refused = document.body.appendChild(document.createElement("div"));
  expect(() => components.mountRow(refused, { setting: "gateway.port", title: "Port" })).toThrow(
    refusal,
  );
  expect(refused.childElementCount).toBe(0);
  expect(() =>
    components.mountNavigation(refused, { setting: "gateway.port", title: "Port", onClick() {} }),
  ).toThrow(refusal);
  expect(() => handle.update({ setting: "gateway.port", title: "Port" })).toThrow(refusal);
  expect(element.id).toBe("plugin.fixture.phase.deep");
  abort.abort();
});
