import { expect, it } from "vitest";
import { createDeferred as deferred } from "../../../../test/helpers/promise.js";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { renderConfigInto, renderConfigView } from "./config-view.test-support.tsx";

it("keeps the loaded form and Setup mounted but read-only while the schema refreshes", async () => {
  const refresh = deferred<{ ok: true; value: undefined }>();
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
  await waitForSolid(() => {
    expect(container.querySelector(".config-loading")).toBeNull();
    expect(container.querySelector<HTMLInputElement>(".config-content input")?.disabled).toBe(
      false,
    );
  });
  const field = container.querySelector<HTMLInputElement>(".config-content input");
  const setup = container.querySelector<HTMLDetailsElement>("#config-section-wizard");
  if (!field || !setup) {
    throw new Error("Expected a loaded Advanced form and Setup disclosure");
  }
  setup.open = true;

  props.schemaLoading = true;
  props.schemaRead = refresh.promise;
  renderConfigInto(props, container);
  await waitForSolid(() => {
    const current = container.querySelector<HTMLInputElement>(".config-content input");
    expect(current).toBe(field);
    expect(field.disabled).toBe(true);
  });
  expect(container.querySelector(".config-loading")).toBeNull();
  expect(container.querySelector(".config-content input")).toBe(field);
  expect(field.disabled).toBe(true);
  expect(container.querySelector("#config-section-wizard")).toBe(setup);
  expect(setup.open).toBe(true);
  expect(setup.querySelector(".settings-toggle__input")?.hasAttribute("aria-disabled")).toBe(true);
  expect(container.querySelector(".config-content")?.getAttribute("aria-busy")).toBe("true");

  props.schemaLoading = false;
  refresh.resolve({ ok: true, value: undefined });
  renderConfigInto(props, container);
  await waitForSolid(() => expect(field.disabled).toBe(false));
  expect(container.querySelector(".config-content input")).toBe(field);
  expect(field.disabled).toBe(false);
  expect(setup.open).toBe(true);

  const failure = deferred<{ ok: false; error: string }>();
  props.schemaLoading = true;
  props.schemaRead = failure.promise;
  renderConfigInto(props, container);
  await waitForSolid(() => expect(field.disabled).toBe(true));
  props.schemaLoading = false;
  failure.resolve({ ok: false, error: "Synthetic schema refresh unavailable" });
  renderConfigInto(props, container);
  await waitForSolid(() => {
    expect(field.disabled).toBe(false);
    expect(container.querySelector('.callout[role="alert"]')?.textContent).toContain(
      "Synthetic schema refresh unavailable",
    );
  });
  expect(container.querySelector(".config-content input")).toBe(field);
  expect(container.querySelector("#config-section-wizard")).toBe(setup);
  expect(setup.open).toBe(true);

  const first = deferred<{ ok: true; value: undefined }>();
  const initial = renderConfigView({
    schema: null,
    schemaLoading: true,
    schemaRead: first.promise,
  });
  await waitForSolid(() =>
    expect(initial.container.querySelector(".config-loading")).not.toBeNull(),
  );
  expect(initial.container.querySelector(".config-content input")).toBeNull();
  first.resolve({ ok: true, value: undefined });
});
