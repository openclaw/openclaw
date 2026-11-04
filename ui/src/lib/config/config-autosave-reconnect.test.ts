// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS,
  createConfigCapabilityHarness,
  createConfigServerMock,
  createDeferredSetServerMock,
} from "./config-test-harness.ts";

describe("config autosave reconnect", () => {
  it.each([false, true])(
    "resumes an unsent draft only when its refreshed revision is unchanged (changed: %s)",
    async (changed) => {
      vi.useFakeTimers();
      const server = createConfigServerMock();
      const { runtimeConfig, publish } = createConfigCapabilityHarness(server.request);
      try {
        await runtimeConfig.ensureLoaded();
        runtimeConfig.patchForm(["count"], 2);
        publish(false);
        await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS * 2);
        expect(server.submissions).toHaveLength(0);
        expect(runtimeConfig.state.configForm).toEqual({ count: 2 });
        if (changed) {
          await server.request("config.set", { raw: '{"count":9}', baseHash: "hash-1" });
        }
        publish(true);
        await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS * 2);
        if (changed) {
          expect(server.submissions).toHaveLength(1);
          expect(runtimeConfig.state.configForm).toEqual({ count: 2 });
          expect(runtimeConfig.state.configFormDirty).toBe(true);
          expect(runtimeConfig.state.configAutoSaveStatus).toBe("paused");
        } else {
          expect(server.submissions).toEqual([
            { method: "config.set", raw: '{\n  "count": 2\n}\n', baseHash: "hash-1" },
          ]);
          expect(runtimeConfig.state.configFormDirty).toBe(false);
          expect(runtimeConfig.state.configAutoSaveStatus).toBe("saved");
        }
      } finally {
        runtimeConfig.dispose();
      }
    },
  );

  it("resumes newer unsent edits against the base acknowledged by an earlier save", async () => {
    vi.useFakeTimers();
    const server = createDeferredSetServerMock();
    const { runtimeConfig, publish } = createConfigCapabilityHarness(server.request);
    try {
      await runtimeConfig.ensureLoaded();
      runtimeConfig.patchForm(["count"], 2);
      const save = runtimeConfig.save();
      runtimeConfig.patchForm(["count"], 3);
      server.firstSet.resolve({});
      await expect(save).resolves.toBe(true);
      publish(false);
      publish(true);
      await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS * 2);
      expect(server.submissions).toEqual([
        { raw: '{\n  "count": 2\n}\n', baseHash: "hash-1" },
        { raw: '{\n  "count": 3\n}\n', baseHash: "hash-2" },
      ]);
      expect(runtimeConfig.state.configFormDirty).toBe(false);
    } finally {
      runtimeConfig.dispose();
    }
  });

  it("does not resume a newer draft after a submission loses its acknowledgement", async () => {
    vi.useFakeTimers();
    const server = createDeferredSetServerMock();
    const { runtimeConfig, publish } = createConfigCapabilityHarness(server.request);
    try {
      await runtimeConfig.ensureLoaded();
      runtimeConfig.patchForm(["count"], 2);
      await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
      runtimeConfig.patchForm(["count"], 3);
      publish(false);
      publish(true);
      await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS * 2);
      expect(server.submissions).toHaveLength(1);
      expect(runtimeConfig.state.configForm).toEqual({ count: 3 });
      expect(runtimeConfig.state.configFormDirty).toBe(true);
      expect(runtimeConfig.state.configAutoSaveStatus).toBe("paused");
      server.firstSet.resolve({});
      await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS * 2);
      expect(server.submissions).toHaveLength(1);
    } finally {
      runtimeConfig.dispose();
    }
  });
});
