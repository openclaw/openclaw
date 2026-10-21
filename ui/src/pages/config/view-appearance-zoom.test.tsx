/* @vitest-environment jsdom */

import { expect, it } from "vitest";
import { renderAppearance, renderConfigInto } from "./config-view.test-support.tsx";

it("retires the desktop text-size control without clearing the touch preference", () => {
  const { container, props } = renderAppearance({ hostContentZoom: false, textScale: 125 });
  const buttons = () => [
    ...container.querySelectorAll<HTMLButtonElement>(".settings-text-scale__btn"),
  ];
  expect(buttons()).toHaveLength(5);
  expect(
    buttons()
      .find((button) => button.textContent?.includes("125%"))
      ?.getAttribute("aria-pressed"),
  ).toBe("true");

  props.hostContentZoom = true;
  renderConfigInto(props, container);
  expect(buttons()).toHaveLength(0);
  expect(props.setTextScale).not.toHaveBeenCalled();

  props.hostContentZoom = false;
  renderConfigInto(props, container);
  expect(buttons()).toHaveLength(5);
  expect(
    buttons()
      .find((button) => button.textContent?.includes("125%"))
      ?.getAttribute("aria-pressed"),
  ).toBe("true");
});
