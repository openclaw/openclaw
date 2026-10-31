/* @vitest-environment jsdom */

import { expect, it, vi } from "vitest";
import { choosePickerValue, openPicker, updatePickers } from "../../test-helpers/select-picker.ts";
import { mount, props, settingsRow } from "./view.test-support.tsx";

const trigger = (container: Element, setting: string) =>
  container.querySelector<HTMLButtonElement>(`#model-providers-${setting}-model`)!;
const optionSelector = (id: string) => `[role="option"][data-value="fixture/${id}"]`;

it("offers only decision models, even without a chat provider, and retains an unavailable selection", async () => {
  const onDecisionChange = vi.fn();
  const viewProps = props({
    configuredModels: [],
    decisionModels: [{ provider: "typesafe", id: "jev-latest", name: "Jev", pluginId: "typesafe" }],
    defaultModels: {
      primary: "",
      fallbacks: [],
      utilityModel: null,
      decisionModel: "typesafe/retired",
    },
    onDecisionChange,
  });
  const container = mount(viewProps);
  await updatePickers(container);
  const picker = trigger(container, "decision");
  expect(picker.disabled).toBe(false);
  expect(picker.textContent).toContain("typesafe/retired");
  await openPicker(picker);
  expect(
    container.querySelectorAll('[role="option"][data-value="typesafe/jev-latest"]'),
  ).toHaveLength(1);
  await choosePickerValue(picker, "typesafe/retired");
  expect(onDecisionChange).not.toHaveBeenCalled();
  await choosePickerValue(picker, "typesafe/jev-latest");
  expect(onDecisionChange).toHaveBeenLastCalledWith("typesafe/jev-latest");
  await choosePickerValue(picker, "");
  expect(onDecisionChange).toHaveBeenLastCalledWith(null);

  mount({ ...viewProps, defaultsMutationBlockedReason: "Read only" }, container);
  await updatePickers(container);
  expect(trigger(container, "decision").disabled).toBe(true);
});

it("retains a saved unavailable model without offering it for another default setting", async () => {
  const onUtilityChange = vi.fn();
  const onUtilityFallbackChange = vi.fn();
  const container = mount(
    props({
      configuredModels: [
        { provider: "fixture", id: "ready", name: "Ready", available: true },
        { provider: "fixture", id: "blocked", name: "Blocked", available: false },
        { provider: "fixture", id: "last", name: "Last", available: true },
      ],
      defaultModels: {
        primary: "fixture/ready",
        fallbacks: ["fixture/blocked"],
        utilityModel: { primary: "fixture/blocked", fallbacks: ["fixture/ready", "fixture/last"] },
      },
      onUtilityChange,
      onUtilityFallbackChange,
    }),
  );
  await updatePickers(container);
  const blocked: Element[] = [];
  const ready: Element[] = [];
  for (const picker of container.querySelectorAll<HTMLElement>("openclaw-select-picker")) {
    await openPicker(picker);
    blocked.push(...picker.querySelectorAll(optionSelector("blocked")));
    ready.push(...picker.querySelectorAll(optionSelector("ready")));
  }
  expect(blocked).toHaveLength(3);
  expect(blocked.every((option) => option.getAttribute("aria-disabled") === "true")).toBe(true);
  expect(ready.every((option) => option.getAttribute("aria-disabled") === "false")).toBe(true);
  const utility = trigger(container, "utility");
  expect(utility.textContent).toContain("Blocked");
  await choosePickerValue(utility, "fixture/blocked");
  expect(onUtilityChange).not.toHaveBeenCalled();
  await choosePickerValue(utility, "__openclaw_automatic_utility__");
  expect(onUtilityChange).toHaveBeenCalledExactlyOnceWith(null);
  const row = settingsRow(container, "Utility Fallback Model");
  expect(row.textContent).toContain("1 more fallback after this one");
  const picker = row.querySelector<HTMLButtonElement>(".picker-select__trigger")!;
  expect(picker.textContent).toContain("Ready");
  expect(row.querySelector(optionSelector("blocked"))).toBeNull();
  await choosePickerValue(picker, "fixture/last");
  expect(onUtilityFallbackChange).toHaveBeenLastCalledWith("fixture/last");
});
