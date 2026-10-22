/* @vitest-environment jsdom */

import type { Result } from "@openclaw/normalization-core/result";
import { createSignal, flush, type Setter } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../../../src/shared/deferred.ts";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { PluginSettingsEditor } from "./settings-editor.tsx";
import type { PluginSettingsEditorModel } from "./settings-model.ts";
import { PluginSettingsReadStatus } from "./settings-read-status.tsx";

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
      configRead: undefined,
      configSchemaRead: undefined,
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

it("shows a later write failure after a caught configuration read failure", async () => {
  const readRetry = vi.fn();
  const writeRetry = vi.fn();
  const read = createDeferredCore<Result<void, string>>();
  read.resolve({ ok: false, error: "Schema unavailable" });
  let setError!: Setter<string | null>;
  const { container } = mountSolid(() => {
    const [error, updateError] = createSignal<string | null>("Schema unavailable");
    setError = updateError;
    return (
      <PluginSettingsReadStatus
        model={{
          get configError() {
            return error();
          },
          configValue: {},
          configSchema: { type: "object", properties: {} },
          configRead: undefined,
          configSchemaRead: read.promise,
          onConfigReadRetry: readRetry,
          onConfigWriteRetry: writeRetry,
        }}
        loading={false}
        rows={2}
        renderError={(message, retry) => (
          <div role="alert">
            {message}
            <button onClick={() => retry()}>Retry</button>
          </div>
        )}
      />
    );
  });
  // Let the async read reach its error boundary before the later write completes.
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
  await waitForSolid(() => expect(container.textContent).toContain("Schema unavailable"));
  setError("Autosave failed");
  await waitForSolid(() => expect(container.textContent).toContain("Autosave failed"));
  expect(container.textContent).not.toContain("Schema unavailable");
  container.querySelector<HTMLButtonElement>("button")!.click();
  expect(writeRetry).toHaveBeenCalledOnce();
  expect(readRetry).not.toHaveBeenCalled();
});
