/* @vitest-environment jsdom */

import { flush } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { i18n, t } from "../../i18n/index.ts";
import { mount, props, text } from "./view.test-support.tsx";

afterEach(() => i18n.setLocale("en"));

it("translates standard advertised and saved thinking levels while preserving provider labels and values", async () => {
  await i18n.setLocale("fr");
  const onThinkingChange = vi.fn();
  const model = {
    id: "gpt-5",
    provider: "openai",
    name: "GPT-5",
    thinkingLevels: [
      { id: "off", label: "Off" },
      { id: "low", label: "Low" },
      { id: "medium", label: "Medium" },
      { id: "high", label: "High" },
      { id: "max", label: "Max" },
      { id: "custom-effort", label: "Provider effort" },
    ],
  };
  const viewProps = props({
    configuredModels: [model],
    thinkingLevel: "high",
    onThinkingChange,
  });
  const container = mount(viewProps);
  const group = () =>
    container.querySelector<HTMLElement>(
      `[role="radiogroup"][aria-label="${t("quickSettings.model.thinking")}"]`,
    )!;
  const input = (value: string) =>
    group().querySelector<HTMLInputElement>(`input[value="${value}"]`)!;
  const label = (value: string) => text(input(value).closest("label"));

  expect(label("off")).toBe(t("quickSettings.model.thinkingLevels.off"));
  expect(label("low")).toBe("Faible");
  expect(label("medium")).toBe("Moyen");
  expect(label("high")).toBe("Élevé");
  expect(label("max")).toBe("Maximum");
  expect(label("custom-effort")).toBe("Provider effort");
  input("low").click();
  expect(onThinkingChange).toHaveBeenCalledExactlyOnceWith("low");

  await i18n.setLocale("en");
  flush();
  expect(label("low")).toBe("Low");
  expect(label("medium")).toBe("Medium");
  expect(label("high")).toBe("High");
  expect(label("custom-effort")).toBe("Provider effort");

  await i18n.setLocale("fr");
  mount({ ...viewProps, configuredModels: [{ ...model, thinkingLevels: [] }] }, container);
  expect(label("high")).toBe("Élevé");
  expect(input("high").checked).toBe(true);
  expect(input("high").disabled).toBe(true);
  expect(input("low")).toBeNull();
  expect(onThinkingChange).toHaveBeenCalledTimes(1);
});
