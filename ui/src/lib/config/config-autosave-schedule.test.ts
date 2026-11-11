// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import {
  CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS,
  createConfigServerMock,
} from "./config-test-harness.ts";
import { loadHarness, pendingAutoSave } from "./config-write.test-support.ts";

afterEach(() => {
  vi.useRealTimers();
});

it("reports a save coming while its debounce waits and while it queues behind a write", async () => {
  const { runtimeConfig, state, firstSet } = await pendingAutoSave();
  // The running write reports itself through the save status.
  expect(state.configAutoSaveScheduled).toBe(false);

  runtimeConfig.patchForm(["count"], 3);
  expect(state.configAutoSaveScheduled).toBe(true);
  await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
  expect(state.configAutoSaveScheduled).toBe(true);

  firstSet.resolve({});
  await vi.advanceTimersByTimeAsync(0);
  expect(state.configAutoSaveScheduled).toBe(false);
  runtimeConfig.dispose();
});

it("never reports a save coming for an edit whose autosave is blocked", async () => {
  vi.useFakeTimers();
  const server = createConfigServerMock();
  const { runtimeConfig, state } = await loadHarness(server.request);
  state.configAutoSaveStatus = "conflict";

  runtimeConfig.patchForm(["count"], 2);
  expect(state.configFormDirty).toBe(true);
  expect(state.configAutoSaveScheduled).toBe(false);
  await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
  expect(state.configAutoSaveScheduled).toBe(false);
  expect(server.submissions).toHaveLength(0);
  runtimeConfig.dispose();
});
