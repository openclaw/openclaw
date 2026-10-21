/* @vitest-environment jsdom */

import { createSignal, flush, type Setter } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import { PluginSettingsEditor } from "./settings-editor.tsx";
import type { PluginSettingsEditorModel } from "./settings-model.ts";

afterEach(cleanupSolid);

it("dispatches retained retry controls to the current settings operation", () => {
  const initialRead = vi.fn();
  const currentRead = vi.fn();
  const currentWrite = vi.fn();
  let setModel!: Setter<PluginSettingsEditorModel>;
  const { container } = mountSolid(() => {
    const [model, updateModel] = createSignal<PluginSettingsEditorModel>({
      pluginId: "fixture",
      result: null,
      connected: true,
      configValue: null,
      configSchema: null,
      configHints: {},
      configUnsupportedPaths: [],
      canEditConfig: true,
      configBusy: false,
      configSchemaLoading: false,
      configError: "Request failed",
      onConfigPatch: vi.fn(),
      onConfigRemove: vi.fn(),
      onConfigReadRetry: initialRead,
      onConfigWriteRetry: vi.fn(),
      backHref: "/settings/plugins/fixture",
      onBack: vi.fn(),
    });
    setModel = updateModel;
    return <PluginSettingsEditor model={model()} />;
  });
  flush();
  const retry = container.querySelector<HTMLButtonElement>('[role="alert"] button')!;
  retry.click();
  expect(initialRead).toHaveBeenCalledOnce();

  setModel((previous) => ({ ...previous, onConfigReadRetry: currentRead }));
  flush();
  expect(container.querySelector('[role="alert"] button')).toBe(retry);
  retry.click();
  expect(currentRead).toHaveBeenCalledOnce();
  expect(initialRead).toHaveBeenCalledOnce();

  setModel((previous) => ({
    ...previous,
    configValue: {},
    configSchema: { type: "object", properties: {} },
    onConfigWriteRetry: currentWrite,
  }));
  flush();
  expect(container.querySelector('[role="alert"] button')).toBe(retry);
  retry.click();
  expect(currentWrite).toHaveBeenCalledOnce();
  expect(currentRead).toHaveBeenCalledOnce();
});
