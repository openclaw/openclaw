import { expect, it } from "vitest";
import { renderConfigInto, renderConfigView } from "./config-view.test-support.tsx";

it("keeps the loaded form and Setup mounted but read-only while the schema refreshes", () => {
  const { container, props } = renderConfigView({
    schema: {
      type: "object",
      properties: {
        gateway: { type: "object", properties: { mode: { type: "string" } } },
        wizard: {
          type: "object",
          properties: { appRecommendations: { type: "boolean" } },
        },
      },
    },
    uiHints: { "gateway.mode": { advanced: false } },
    formValue: { gateway: { mode: "local" }, wizard: { appRecommendations: true } },
    forceShowAdvanced: true,
  });
  const field = container.querySelector<HTMLInputElement>(".config-content input");
  const setup = container.querySelector<HTMLDetailsElement>("#config-section-wizard");
  if (!field || !setup) {
    throw new Error("Expected a loaded Advanced form and Setup disclosure");
  }
  setup.open = true;

  props.schemaLoading = true;
  renderConfigInto(props, container);
  expect(container.querySelector(".config-loading")).toBeNull();
  expect(container.querySelector(".config-content input")).toBe(field);
  expect(field.disabled).toBe(true);
  expect(container.querySelector("#config-section-wizard")).toBe(setup);
  expect(setup.open).toBe(true);
  expect(setup.querySelector<HTMLInputElement>(".settings-toggle__input")?.disabled).toBe(true);
  expect(container.querySelector(".config-content")?.getAttribute("aria-busy")).toBe("true");

  props.schemaLoading = false;
  renderConfigInto(props, container);
  expect(container.querySelector(".config-content input")).toBe(field);
  expect(field.disabled).toBe(false);
  expect(setup.open).toBe(true);

  const initial = renderConfigView({ schema: null, schemaLoading: true });
  expect(initial.container.querySelector(".config-loading")).not.toBeNull();
  expect(initial.container.querySelector(".config-content input")).toBeNull();
});
