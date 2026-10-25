/* @vitest-environment jsdom */

import { expect, it, vi } from "vitest";
import { choosePickerValue, openPicker, updatePickers } from "../../test-helpers/select-picker.ts";
import { mount, props, settingsRow } from "./view.test-support.tsx";

it("offers only decision models, even without a chat provider, and retains an unavailable selection", async () => {
  const onDecisionChange = vi.fn();
  const container = document.createElement("div");
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
  mount(viewProps, container);
  await updatePickers(container);
  const picker = container.querySelector<HTMLButtonElement>("#model-providers-decision-model")!;
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
  expect(
    container.querySelector<HTMLButtonElement>("#model-providers-decision-model")!.disabled,
  ).toBe(true);
});

it("retains a saved unavailable model without offering it for another default setting", async () => {
  const onUtilityChange = vi.fn();
  const container = document.createElement("div");
  mount(
    props({
      configuredModels: [
        { provider: "fixture", id: "ready", name: "Ready", available: true },
        { provider: "fixture", id: "blocked", name: "Blocked", available: false },
      ],
      defaultModels: {
        primary: "fixture/ready",
        fallbacks: ["fixture/blocked"],
        utilityModel: "fixture/blocked",
      },
      onUtilityChange,
    }),
    container,
  );

  await updatePickers(container);
  const blocked: Element[] = [];
  const ready: Element[] = [];
  for (const picker of container.querySelectorAll<HTMLElement>("openclaw-select-picker")) {
    await openPicker(picker);
    blocked.push(...picker.querySelectorAll('[role="option"][data-value="fixture/blocked"]'));
    ready.push(...picker.querySelectorAll('[role="option"][data-value="fixture/ready"]'));
  }
  expect(blocked).toHaveLength(3);
  expect(blocked.every((option) => option.getAttribute("aria-disabled") === "true")).toBe(true);
  expect(ready.every((option) => option.getAttribute("aria-disabled") === "false")).toBe(true);
  const utility = container.querySelector<HTMLButtonElement>("#model-providers-utility-model")!;
  expect(utility.textContent).toContain("Blocked");
  await choosePickerValue(utility, "fixture/blocked");
  expect(onUtilityChange).not.toHaveBeenCalled();
  await choosePickerValue(utility, "__openclaw_automatic_utility__");
  expect(onUtilityChange).toHaveBeenCalledExactlyOnceWith(null);
});

it("shows utility chain selections and edits their fallback independently", async () => {
  const onUtilityFallbackChange = vi.fn();
  const container = document.createElement("div");
  mount(
    props({
      configuredModels: [
        { provider: "fixture", id: "utility", name: "Utility" },
        { provider: "fixture", id: "backup", name: "Backup" },
        { provider: "fixture", id: "last", name: "Last" },
      ],
      defaultModels: {
        primary: "fixture/chat",
        fallbacks: [],
        utilityModel: { primary: "fixture/utility", fallbacks: ["fixture/backup", "fixture/last"] },
      },
      onUtilityFallbackChange,
    }),
    container,
  );
  await updatePickers(container);
  expect(container.querySelector("#model-providers-utility-model")?.textContent).toContain(
    "Utility",
  );
  const row = settingsRow(container, "Utility Fallback Model");
  expect(row.textContent).toContain("1 more fallback after this one");
  const picker = row.querySelector<HTMLButtonElement>(".picker-select__trigger")!;
  expect(picker.textContent).toContain("Backup");
  expect(row.querySelector('[role="option"][data-value="fixture/utility"]')).toBeNull();
  await choosePickerValue(picker, "fixture/last");
  expect(onUtilityFallbackChange).toHaveBeenLastCalledWith("fixture/last");
});

/** Connected rows start collapsed; their accounts and actions live in the detail. */
