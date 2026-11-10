/* @vitest-environment jsdom */

import { beforeEach, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { mount, props, settingsRow, text } from "./view.test-support.tsx";

beforeEach(async () => {
  await i18n.setLocale("en");
});

it.each([undefined, true])(
  "offers Fast separately from Ultrafast when request support is %s",
  (supportsFastMode) => {
    const onFastModeChange = vi.fn();
    const container = mount(
      props({
        configuredModels: [
          {
            id: "gpt-5",
            provider: "openai",
            name: "GPT-5",
            available: true,
            supportsFastMode,
            serviceTiers: ["ultrafast"],
          },
        ],
        fastMode: "ultrafast",
        onFastModeChange,
      }),
    );
    const speed = settingsRow(container, "Speed");
    const fast = [...speed.querySelectorAll("label")].find((label) => text(label) === "Fast");
    expect(fast).toBeDefined();
    const ultrafast = speed.querySelector<HTMLInputElement>('[value="ultrafast"]')!;
    expect(ultrafast.checked).toBe(true);
    expect(ultrafast.disabled).toBe(false);
    speed.querySelector<HTMLInputElement>('[value="on"]')!.click();
    expect(onFastModeChange).toHaveBeenCalledExactlyOnceWith(true);
  },
);
