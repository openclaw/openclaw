import { afterEach, expect, it } from "vitest";
import { createControlUiSettingsComponents } from "./control-ui-settings-components.solid.tsx";

afterEach(() => {
  document.body.replaceChildren();
});

const settings = {
  "plugin.fixture.schedule": { label: "Schedule" },
  "plugin.fixture.phase.*": { label: "Phase" },
};

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
