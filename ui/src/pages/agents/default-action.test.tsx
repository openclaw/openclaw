/* @vitest-environment jsdom */

import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { mountSolid } from "../../test-helpers/solid-render.tsx";
import { createAgentViewTestProps as createProps } from "./agents-view.test-helpers.ts";
import { Agents } from "./view.tsx";

it("shows admitted default commands and follows confirmed roster state", async () => {
  const first = createDeferred();
  const retry = createDeferred();
  let retired = createDeferred();
  const onSetDefault = vi
    .fn()
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(retry.promise);
  const props = createProps({ onSetDefault, presentationRetired: () => retired.promise });
  const container = document.body.appendChild(document.createElement("div"));
  const mounted = mountSolid(Agents, props, container);
  const trigger = () =>
    mounted.container.querySelector<HTMLButtonElement>(".agents-page-menu__trigger")!;
  const control = () =>
    [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) =>
      /Set default|Saving|^Default$/.test(item.textContent?.trim() ?? ""),
    );
  const disabled = () =>
    control()?.getAttribute("aria-disabled") === "true" ||
    (control() as HTMLButtonElement | undefined)?.disabled === true;
  // Selecting an item closes the menu, so reopen it before reading the label.
  const reopen = () => {
    if (trigger().getAttribute("aria-expanded") !== "true") {
      trigger().click();
    }
  };
  try {
    await vi.waitFor(() => {
      reopen();
      expect(control()).toBeTruthy();
    });
    control()!.click();
    await vi.waitFor(() => {
      reopen();
      expect(control()?.textContent).toContain("Saving");
      expect(disabled()).toBe(true);
    });
    expect(props.readData().agentsList?.defaultId).toBe("alpha");
    retired.resolve();
    retired = createDeferred();
    mounted.update({
      ...props,
      selectedAgentId: "alpha",
      config: { ...props.config, configSaving: false },
    });
    await vi.waitFor(() => {
      reopen();
      expect(control()?.textContent?.trim()).toBe("Default");
    });
    mounted.update({ ...props, config: { ...props.config, configSaving: false } });
    await vi.waitFor(() => {
      reopen();
      expect(control()?.textContent).toContain("Set default");
      expect(disabled()).toBe(false);
    });
    first.resolve();
    mounted.update(props);
    await vi.waitFor(() => {
      reopen();
      expect(control()?.textContent).toContain("Set default");
      expect(disabled()).toBe(false);
    });
    control()!.click();
    await vi.waitFor(() => expect(onSetDefault).toHaveBeenNthCalledWith(2, "beta"));
    retry.resolve();
    const data = props.readData();
    mounted.update({
      ...props,
      readData: () => ({ ...data, agentsList: { ...data.agentsList!, defaultId: "beta" } }),
    });
    await vi.waitFor(() => {
      reopen();
      expect(control()?.textContent?.trim()).toBe("Default");
      expect(disabled()).toBe(true);
    });
  } finally {
    first.resolve();
    retry.resolve();
    mounted.dispose();
    container.remove();
  }
});
