/* @vitest-environment jsdom */

import type { Result } from "@openclaw/normalization-core/result";
import { createSignal, flush, type Setter } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../../../src/shared/deferred.ts";
import {
  beginConfigRead,
  createInitialConfigState,
  currentConfigRead,
  type ConfigRead,
} from "../../lib/config/config-state-model.ts";
import { collectGarbageForTest } from "../../test-helpers/garbage-collection.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { PluginSettingsEditor } from "./settings-editor.tsx";
import type { PluginSettingsEditorModel } from "./settings-model.ts";
import { PluginSettingsReadStatus } from "./settings-read-status.tsx";

afterEach(cleanupSolid);

async function retireSettingsReadView(read: ConfigRead) {
  const payload = { label: "retired settings view" };
  const view = mountSolid(() => (
    <PluginSettingsReadStatus
      model={{
        configRead: read,
        configSchemaRead: undefined,
        configError: null,
        configValue: {},
        configSchema: {},
        onConfigReadRetry: () => payload.label,
        onConfigWriteRetry: () => payload.label,
      }}
      loading={false}
      rows={2}
      renderError={(message) => <span>{message}</span>}
    />
  ));
  // Let the completed read leave Loading before retiring its rendering owner.
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
  flush();
  view.unmount();
  flush();
  return new WeakRef(payload);
}

it("releases retired settings views while the completed config read remains current", async () => {
  const client = createTestGatewayClient(vi.fn());
  const state = createInitialConfigState({ client, phase: "connected" });
  const read = beginConfigRead(state, client);
  read.completion.resolve({ ok: true, value: undefined });
  const retired = [await retireSettingsReadView(read), await retireSettingsReadView(read)];
  const control = new WeakRef({ unowned: true });

  await collectGarbageForTest();

  expect(control.deref()).toBeUndefined();
  expect(retired.map((reference) => reference.deref())).toEqual([undefined, undefined]);
  expect(currentConfigRead(state)).toBe(read);
});

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
