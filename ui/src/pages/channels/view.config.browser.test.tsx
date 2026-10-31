import { expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import "../../styles.css";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { ChannelConfig } from "./view.config.tsx";
import { createChannelsViewProps } from "./view.test-support.ts";

it("refuses invalid native channel fields and saves a corrected value", async () => {
  const onConfigSave = vi.fn();
  const onConfigReload = vi.fn();
  const props = createChannelsViewProps(null, null, {
    config: {
      configFormDirty: true,
      configForm: { channels: { telegram: { count: 2 } } },
      configSchema: {
        type: "object",
        properties: {
          channels: {
            type: "object",
            properties: {
              telegram: { type: "object", properties: { count: { type: "integer", minimum: 1 } } },
            },
          },
        },
      },
    },
    showAdvancedSettings: true,
    onConfigSave,
    onConfigReload,
  });
  const view = mountSolid(() => <ChannelConfig channelId="telegram" props={props} />);
  try {
    const input = view.container.querySelector<HTMLInputElement>("input[type=number]")!;
    expect(input).not.toBeNull();
    input.value = "0";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(input.validity.valid).toBe(false);
    await userEvent.click(view.container.querySelector<HTMLButtonElement>("button.primary")!);
    expect(onConfigSave).not.toHaveBeenCalled();
    input.value = "2";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await userEvent.click(view.container.querySelector<HTMLButtonElement>("button.primary")!);
    expect(onConfigSave).toHaveBeenCalledOnce();
    await userEvent.click(
      [...view.container.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
        button.textContent?.includes("Reload"),
      )!,
    );
    expect(onConfigReload).toHaveBeenCalledOnce();
    expect(onConfigSave).toHaveBeenCalledOnce();
  } finally {
    view.unmount();
  }
});
