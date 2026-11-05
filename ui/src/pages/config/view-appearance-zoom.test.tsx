/* @vitest-environment jsdom */

import { expect, it } from "vitest";
import { renderAppearance, renderConfigInto } from "./config-view.test-support.tsx";

it("retires the desktop text-size control without clearing the touch preference", () => {
  const { container, props } = renderAppearance({ hostContentZoom: false, textScale: 125 });
  const choices = () => [
    ...container.querySelectorAll<HTMLInputElement>(
      '#settings-appearance-text-size input[type="radio"]',
    ),
  ];
  expect(choices()).toHaveLength(5);
  expect(choices().find((choice) => choice.value === "125")?.checked).toBe(true);

  props.hostContentZoom = true;
  renderConfigInto(props, container);
  expect(container.querySelector("#settings-appearance-text-size")).toBeNull();
  expect(props.setTextScale).not.toHaveBeenCalled();

  props.hostContentZoom = false;
  renderConfigInto(props, container);
  expect(choices()).toHaveLength(5);
  expect(choices().find((choice) => choice.value === "125")?.checked).toBe(true);
});
