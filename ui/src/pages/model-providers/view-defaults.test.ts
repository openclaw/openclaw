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
  const row = settingsRow(container, "Utility fallback model");
  expect(row.textContent).toContain("1 more fallback after this one");
  const picker = row.querySelector<HTMLButtonElement>(".picker-select__trigger")!;
  expect(picker.textContent).toContain("Ready");
  expect(row.querySelector(optionSelector("blocked"))).toBeNull();
  await choosePickerValue(picker, "fixture/last");
  expect(onUtilityFallbackChange).toHaveBeenLastCalledWith("fixture/last");
});

it("chooses a harness for the primary or fallback without offering the primary again", async () => {
  const onPrimaryChange = vi.fn();
  const onFallbackChange = vi.fn();
  const container = mount(
    props({
      configuredModels: ["First", "Second"].map((name) => ({
        id: name.toLowerCase(),
        name,
        provider: "openai",
        available: true,
        agentRuntime: { id: "codex", source: "model" },
        runtimeChoices: [{ agentRuntime: { id: "agent-only", source: "model" }, available: true }],
        defaultModelRuntimes: {
          base: { agentRuntime: { id: "openclaw", source: "model" }, available: true },
          alternatives: [
            { agentRuntime: { id: "codex", source: "model" }, available: true },
            { agentRuntime: { id: "hidden", source: "model" }, manualSelectionAllowed: false },
            { agentRuntime: { id: "offline", source: "model" }, available: false },
          ],
        },
      })),
      defaultModels: {
        primary: "openai/first",
        fallbacks: ["openai/second"],
        utilityModel: null,
        runtimes: { "openai/first": { id: "codex" } },
      },
      onPrimaryChange,
      onFallbackChange,
    }),
  );
  await updatePickers(container);
  const primary = settingsRow(container, "Model").querySelector<HTMLButtonElement>(
    ".picker-select__trigger",
  )!;
  const fallback = settingsRow(container, "Fallback model").querySelector<HTMLButtonElement>(
    ".picker-select__trigger",
  )!;
  expect(primary.textContent).toContain("First · Codex");
  const menu = await openPicker(primary);
  const option = (parent: Element, label: string) =>
    [...parent.querySelectorAll<HTMLElement>('[role="option"]')].find((row) =>
      row.textContent?.includes(label),
    );
  expect(option(menu, "Hidden")).toBeUndefined();
  expect(option(menu, "Agent Only")).toBeUndefined();
  expect(option(menu, "First · Offline")?.getAttribute("aria-disabled")).toBe("true");
  option(menu, "First · OpenClaw")!.click();
  expect(onPrimaryChange).toHaveBeenCalledWith("openai/first", {
    id: "openclaw",
    base: "openclaw",
  });
  const backup = await openPicker(fallback);
  expect(option(backup, "First")).toBeUndefined();
  option(backup, "Second · Codex")!.click();
  expect(onFallbackChange).toHaveBeenCalledWith("openai/second", { id: "codex", base: "openclaw" });
});

it("can return a saved harness pin to the ordinary base when the defaults preview is omitted", async () => {
  const onPrimaryChange = vi.fn();
  const container = mount(
    props({
      configuredModels: [
        {
          provider: "openai",
          id: "current",
          name: "Current",
          available: true,
          agentRuntime: { id: "openclaw", source: "model" },
          runtimeChoices: [{ agentRuntime: { id: "agentsapi", source: "model" }, available: true }],
        },
      ],
      defaultModels: {
        primary: "openai/current",
        fallbacks: [],
        utilityModel: null,
        runtimes: { "openai/current": { id: "codex" } },
      },
      onPrimaryChange,
    }),
  );
  await updatePickers(container);
  const picker = settingsRow(container, "Model").querySelector<HTMLButtonElement>(
    ".picker-select__trigger",
  )!;
  expect(picker.textContent).toContain("Current · Codex");
  const menu = await openPicker(picker);
  expect(
    [...menu.querySelectorAll<HTMLElement>('[role="option"]')].map(({ dataset }) => dataset.value),
  ).not.toContain(JSON.stringify(["openai/current", "agentsapi"]));
  await choosePickerValue(picker, JSON.stringify(["openai/current", "openclaw"]));
  expect(onPrimaryChange).toHaveBeenCalledExactlyOnceWith("openai/current", {
    id: "openclaw",
    base: "openclaw",
  });
});

it("names agents with their own utility settings and opens their Overview", async () => {
  const onOpenAgent = vi.fn();
  const container = mount(
    props({
      utilityOverrides: [
        { agentId: "forge", label: "Forge", model: "fixture/small", fallbacks: ["fixture/backup"] },
        { agentId: "quiet", label: "Quiet", model: "", fallbacks: [] },
      ],
      onOpenAgent,
    }),
  );
  const row = settingsRow(container, "Utility model");
  expect(row.textContent).toContain("Forge: fixture/small · fallbacks: fixture/backup");
  expect(row.textContent).toContain("Quiet: Disabled");
  const link = row.querySelector<HTMLAnchorElement>('[data-agent-id="forge"] a')!;
  expect(link.getAttribute("href")).toBe("/settings/agents/forge");
  link.click();
  expect(onOpenAgent).toHaveBeenCalledWith("forge");
});
