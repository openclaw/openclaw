/* @vitest-environment jsdom */
import { afterEach, expect, it } from "vitest";
import type { SelectPicker } from "../../components/select-picker.ts";
import { cleanupSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { createTalkMutationHarness, realtimeProviderPicker } from "./talk.test-support.tsx";

afterEach(() => {
  cleanupSolid();
  document.body.replaceChildren();
});

it("blocks Voice provider choices the Gateway would reject", async () => {
  const { page, runtimeConfig } = createTalkMutationHarness();
  page.configObject = {
    talk: {
      realtime: { mode: "stt-tts" },
      provider: "a",
      providers: { a: {}, b: {} },
    },
  };
  const voice = () =>
    [...page.querySelectorAll<SelectPicker>("openclaw-select-picker")].find((candidate) =>
      candidate.params.options.some((option) => option.value === "tts-local-cli"),
    );
  await waitForSolid(() => expect(voice()).toBeDefined());
  const byValue = (value: string) =>
    voice()!.params.options.find((option) => option.value === value);
  // Two entries: unsetting the provider is invalid, and so is a provider outside the map.
  expect(byValue("")?.disabled).toBe(true);
  expect(byValue("tts-local-cli")?.disabled).not.toBe(true);
  voice()!.params.onChange("tts-local-cli");
  expect(runtimeConfig.patchForm).toHaveBeenCalledWith(["talk", "providers", "tts-local-cli"], {
    args: [],
  });
  expect(runtimeConfig.patchForm).toHaveBeenCalledWith(["talk", "provider"], "tts-local-cli");
  runtimeConfig.patchForm.mockClear();
  page.configObject = {
    talk: { realtime: { mode: "stt-tts" }, providers: { "tts-local-cli": { command: "speak" } } },
  };
  await waitForSolid(() => expect(byValue("a")).toBeUndefined());
  voice()!.params.onChange("tts-local-cli");
  expect(runtimeConfig.patchForm).toHaveBeenCalledTimes(1);
  page.configObject = { talk: { realtime: { mode: "stt-tts" }, providers: { a: {} } } };
  await waitForSolid(() => expect(byValue("")?.disabled).toBe(false));
  expect(byValue("")?.description).toBeUndefined();
});

it("edits an unlisted realtime provider with a populated catalog", async () => {
  const { page, runtimeConfig } = createTalkMutationHarness({ provider: "acme-voice" });
  await waitForSolid(() =>
    expect(realtimeProviderPicker(page)?.params.options.length).toBeGreaterThan(2),
  );
  const input = page.querySelector<HTMLInputElement>('input[aria-label="Provider"]');
  expect(input?.value).toBe("acme-voice");
  input!.value = "acme-next";
  input!.dispatchEvent(new Event("change", { bubbles: true }));
  expect(runtimeConfig.patchForm).toHaveBeenCalledWith(
    ["talk", "realtime", "provider"],
    "acme-next",
  );
});
