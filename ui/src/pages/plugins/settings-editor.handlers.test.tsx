/* @vitest-environment jsdom */

import { setTimeout as nextTask } from "node:timers/promises";
import type { Result } from "@openclaw/normalization-core/result";
import { createSignal, flush } from "solid-js";
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
import { createPluginSettingsDetailProps, createResult } from "./plugins-page.test-support.ts";
import { PluginSettingsEditor } from "./settings-editor.tsx";
import type { PluginSettingsEditorModel } from "./settings-model.ts";
import { PluginSettingsReadStatus } from "./settings-read-status.tsx";

afterEach(cleanupSolid);

function ReadStatus(props: { model: Partial<PluginSettingsEditorModel> }) {
  const defaults = createPluginSettingsDetailProps(createResult(), { configSchema: {} });
  return (
    <PluginSettingsReadStatus
      model={{ ...defaults, ...props.model }}
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
}

async function retireSettingsReadView(read: ConfigRead) {
  const payload = { label: "retired settings view" };
  const view = mountSolid(() => (
    <ReadStatus
      model={{
        configRead: read,
        onConfigReadRetry: () => payload.label,
        onConfigWriteRetry: () => payload.label,
      }}
    />
  ));
  // Let the completed read leave Loading before retiring its rendering owner.
  await nextTask(0);
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
  const [model, setModel] = createSignal<PluginSettingsEditorModel>(
    createPluginSettingsDetailProps(createResult(), {
      pluginId: "fixture",
      result: null,
      backHref: "/settings/plugins/fixture",
      configValue: null,
      configError: "Request failed",
      onConfigReadRetry: initialRead,
    }),
  );
  const { container } = mountSolid(() => <PluginSettingsEditor model={model()} />);
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
  expect(initialRead).toHaveBeenCalledOnce();
  expect(currentRead).toHaveBeenCalledOnce();
});

it("shows a later write failure after a caught configuration read failure", async () => {
  const readRetry = vi.fn();
  const writeRetry = vi.fn();
  const read = createDeferredCore<Result<void, string>>();
  read.resolve({ ok: false, error: "Schema unavailable" });
  const [error, setError] = createSignal<string | null>("Schema unavailable");
  const { container } = mountSolid(() => (
    <ReadStatus
      model={{
        get configError() {
          return error();
        },
        configSchema: { type: "object", properties: {} },
        configSchemaRead: read.promise,
        onConfigReadRetry: readRetry,
        onConfigWriteRetry: writeRetry,
      }}
    />
  ));
  // Let the async read reach its error boundary before the later write completes.
  await nextTask(0);
  await waitForSolid(() => expect(container.textContent).toContain("Schema unavailable"));
  setError("Autosave failed");
  await waitForSolid(() => expect(container.textContent).toContain("Autosave failed"));
  expect(container.textContent).not.toContain("Schema unavailable");
  container.querySelector<HTMLButtonElement>("button")!.click();
  expect(writeRetry).toHaveBeenCalledOnce();
  expect(readRetry).not.toHaveBeenCalled();
});
