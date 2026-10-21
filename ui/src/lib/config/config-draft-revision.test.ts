// @vitest-environment node
import { expect, it, vi } from "vitest";
import type { ConfigSnapshot } from "../../api/types.ts";
import { createPatchServer, expectCalls, loadedConfig } from "./config-suite.test-support.ts";
import {
  createConfigServerMock,
  CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS,
} from "./config-test-harness.ts";

it.each([
  { start: "raw", revert: "raw", next: "form", saved: true },
  { start: "raw", revert: "raw", next: "raw", saved: true },
  { start: "form", revert: "raw", next: "form", saved: true },
  { start: "raw", revert: "discard", next: "form", saved: true },
  { start: "raw", revert: "raw", next: "none", saved: true },
  { start: "raw", revert: "none", next: "form", saved: false },
  { start: "form", revert: "form", next: "form", saved: false },
] as const)(
  "config.set preserves external changes after $start editing, $revert revert and $next editing",
  async ({ start, revert, next, saved }) => {
    vi.useFakeTimers();
    const { store, request } = createPatchServer();
    const setNote = (note: string, baseHash: string) =>
      store.request("config.set", { raw: JSON.stringify({ count: 1, note }) + "\n", baseHash });
    await setNote("original", "hash-1");
    const { runtimeConfig, publish, state } = await loadedConfig(request, true);
    const originalRaw = runtimeConfig.state.configRaw;
    if (start === "raw") {
      runtimeConfig.setRaw(originalRaw.replace('"count":1', '"count":2'));
    } else {
      runtimeConfig.patchForm(["count"], 2);
    }
    await setNote("external", "hash-2");
    publish(false);
    publish(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(state).toMatchObject({
      configSnapshot: { hash: "hash-3" },
      configDraftBaseHash: "hash-2",
    });

    if (revert === "raw") {
      runtimeConfig.setRaw(originalRaw);
    } else if (revert === "form") {
      runtimeConfig.patchForm(["count"], 1);
    } else if (revert === "discard") {
      await runtimeConfig.discardDraft();
    }
    if (next === "form") {
      runtimeConfig.patchForm(["count"], 3);
    } else if (next === "raw") {
      runtimeConfig.setRaw(runtimeConfig.state.configRaw.replace('"count":1', '"count":3'));
    }

    await expect(runtimeConfig.save()).resolves.toBe(saved);
    const { config } = (await store.request("config.get")) as ConfigSnapshot;
    expect(config).toEqual({
      count: saved && next !== "none" ? 3 : 1,
      note: "external",
    });
    expect(runtimeConfig.state.configAutoSaveStatus).toBe(saved ? "saved" : "conflict");
    expectCalls(request, "config.set", 1);
  },
);

it("keeps the restart-needed banner when reverting an acknowledged autosave draft", async () => {
  vi.useFakeTimers();
  const server = createConfigServerMock();
  const { runtimeConfig, state } = await loadedConfig(server.request);
  runtimeConfig.patchForm(["count"], 2);
  await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
  expect(runtimeConfig.state.configNeedsApply).toBe(true);
  runtimeConfig.setRaw('{"count":3}');
  runtimeConfig.setRaw(runtimeConfig.state.configRawOriginal);
  expect(state).toMatchObject({ configNeedsApply: true, configFormDirty: false });
  expect(state.configForm).toEqual({ count: 2 });
});

it("keeps a failed first load retryable after a raw draft is reverted", async () => {
  const server = createConfigServerMock();
  server.request.mockRejectedValueOnce(new Error("unavailable"));
  const { runtimeConfig, state } = await loadedConfig(server.request);
  runtimeConfig.setRaw('{"count":9}');
  runtimeConfig.setRaw(runtimeConfig.state.configRawOriginal);
  expect(state).toMatchObject({ configSnapshot: null, configFormDirty: false });
  await runtimeConfig.ensureLoaded();
  expect(runtimeConfig.state.configForm).toEqual({ count: 1 });
});
