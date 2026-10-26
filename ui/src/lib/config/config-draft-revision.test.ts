// @vitest-environment node
import { expect, it, vi } from "vitest";
import type { ConfigSnapshot } from "../../api/types.ts";
import { createPatchServer, expectCalls, loadedConfig } from "./config-suite.test-support.ts";
import {
  createConfigServerMock,
  createDeferredSetServerMock,
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

it("replays own map keys after an acknowledgement without losing canonical siblings", async () => {
  vi.useFakeTimers();
  const keys = ["constructor", "prototype", "__proto__"];
  const aliases = Object.fromEntries(keys.map((key) => [key, "before"]));
  const { request, submissions, firstSet } = createDeferredSetServerMock({
    count: 1,
    aliases,
    canonical: "retained",
  });
  const { runtimeConfig } = await loadedConfig(request);
  runtimeConfig.patchForm(["aliases"], aliases);
  await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
  expect(submissions).toHaveLength(1);
  for (const key of keys) {
    runtimeConfig.patchForm(["aliases", key], "edited");
  }
  await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
  expect(submissions).toHaveLength(1);
  firstSet.resolve({});
  await vi.advanceTimersByTimeAsync(0);
  expect(submissions).toHaveLength(2);
  expect(submissions[1]?.baseHash).toBe("hash-2");
  expect(JSON.parse(submissions[1]!.raw)).toEqual({
    count: 1,
    aliases: Object.fromEntries(keys.map((key) => [key, "edited"])),
    canonical: "retained",
  });
  expect(runtimeConfig.state.configFormDirty).toBe(false);
});

it.each(["raw", "form"] as const)(
  "keeps a newer %s edit when discard waits for a pending autosave",
  async (mode) => {
    vi.useFakeTimers();
    const { request, submissions, firstSet } = createDeferredSetServerMock();
    const { runtimeConfig } = await loadedConfig(request, true);
    runtimeConfig.patchForm(["count"], 2);
    await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
    runtimeConfig.setRaw('{"count":3}');
    const discard = runtimeConfig.discardDraft();
    if (mode === "raw") {
      runtimeConfig.setRaw('{"count":4}');
    } else {
      runtimeConfig.patchForm(["count"], 4);
      // The newer form debounce expires while discard still holds autosave.
      await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
    }
    firstSet.resolve({});
    await discard;

    expect(JSON.parse(runtimeConfig.state.configRaw)).toEqual({ count: 4 });
    expect(runtimeConfig.state.configFormDirty).toBe(true);
    expect(runtimeConfig.state.configFormMode).toBe(mode);
    expect(submissions).toHaveLength(1);
    if (mode === "raw") {
      await expect(runtimeConfig.save()).resolves.toBe(true);
    } else {
      await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
      expect(runtimeConfig.state.configFormDirty).toBe(false);
    }
    const saved = submissions[1];
    if (!saved) {
      throw new Error("The newer draft was not saved");
    }
    expect(JSON.parse(saved.raw)).toEqual({ count: 4 });
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
