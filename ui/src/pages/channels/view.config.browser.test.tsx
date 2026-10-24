import { flush } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import "../../styles.css";
import { ChannelConfig } from "./view.config.tsx";
import {
  createChannelsViewProps,
  disposeChannelViews,
  renderChannelView,
} from "./view.test-support.ts";

afterEach(() => {
  disposeChannelViews();
  document.body.replaceChildren();
});

it("does not save another dirty field while a channel scalar draft is invalid", async () => {
  const onSave = vi.fn();
  const props = createChannelsViewProps(null, null, {
    showAdvancedSettings: true,
    config: {
      configSchema: {
        type: "object",
        properties: {
          channels: {
            type: "object",
            properties: {
              telegram: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  code: { type: "string", pattern: "^[a-z]+$" },
                },
              },
            },
          },
        },
      },
      configForm: { channels: { telegram: { name: "original", code: "valid" } } },
    },
    onConfigSave: onSave,
    onConfigPatch: (path, value) => {
      props.config.configForm = {
        channels: { telegram: { ...channelValue().telegram, [String(path.at(-1))]: value } },
      };
      props.config.configFormDirty = true;
      render();
    },
  });
  function channelValue() {
    // SAFETY: The synthetic fixture initializes and patches this channel shape.
    return props.config.configForm?.channels as { telegram: { name: string; code: string } };
  }
  const host = document.body.appendChild(document.createElement("div"));
  const render = () =>
    renderChannelView(
      ChannelConfig,
      { channelId: "telegram", props: { ...props, config: { ...props.config } } },
      host,
    );
  render();
  const name = host.querySelector<HTMLInputElement>('input[aria-label="Name"]')!;
  const code = host.querySelector<HTMLInputElement>('input[aria-label="Code"]')!;
  const save = host.querySelector<HTMLButtonElement>("button.primary")!;
  await userEvent.fill(name, "changed");
  expect(save.disabled).toBe(false);
  await userEvent.fill(code, "123");
  expect(code.validity.valid).toBe(false);
  await userEvent.click(save);
  expect(onSave).not.toHaveBeenCalled();
  expect(code.value).toBe("123");
  expect(document.activeElement).toBe(code);
  await userEvent.fill(code, "corrected");
  flush();
  await userEvent.click(save);
  expect(onSave).toHaveBeenCalledTimes(1);
  expect(props.config.configForm).toEqual({
    channels: { telegram: { name: "changed", code: "corrected" } },
  });
});
