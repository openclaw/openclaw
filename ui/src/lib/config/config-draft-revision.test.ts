// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import {
  createConfigCapabilityHarness,
  createConfigServerMock,
  createDeferredSetServerMock,
  CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS,
} from "./config-test-harness.ts";

describe("config draft revision ownership", () => {
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
      let storedRaw = '{"count":1,"note":"original"}\n';
      let hash = "revision-original";
      const request = vi.fn(async (method: string, params?: unknown) => {
        if (method === "config.get") {
          return { config: JSON.parse(storedRaw), raw: storedRaw, hash, valid: true, issues: [] };
        }
        if (method === "config.set") {
          const submission = params as { raw: string; baseHash: string };
          if (submission.baseHash !== hash) {
            throw new Error("config changed since last load; re-run config.get and retry");
          }
          storedRaw = submission.raw;
          hash = "revision-saved";
          return { config: JSON.parse(storedRaw), hash };
        }
        return {};
      });
      const { runtimeConfig, publish } = createConfigCapabilityHarness(
        request as GatewayBrowserClient["request"],
      );
      try {
        await runtimeConfig.ensureLoaded();
        const originalRaw = runtimeConfig.state.configRaw;
        if (start === "raw") {
          runtimeConfig.setRaw(originalRaw.replace('"count":1', '"count":2'));
        } else {
          runtimeConfig.patchForm(["count"], 2);
        }
        storedRaw = '{"count":1,"note":"external"}\n';
        hash = "revision-external";
        publish(false);
        publish(true);
        await vi.advanceTimersByTimeAsync(0);
        expect(runtimeConfig.state.configSnapshot?.hash).toBe("revision-external");
        expect(runtimeConfig.state.configDraftBaseHash).toBe("revision-original");

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
        expect(JSON.parse(storedRaw)).toEqual({
          count: saved && next !== "none" ? 3 : 1,
          note: "external",
        });
        expect(runtimeConfig.state.configAutoSaveStatus).toBe(saved ? "saved" : "conflict");
        expect(request.mock.calls.filter(([method]) => method === "config.set")).toHaveLength(1);
      } finally {
        runtimeConfig.setWritesSuspended(true);
        runtimeConfig.dispose();
      }
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
    const { runtimeConfig } = createConfigCapabilityHarness(
      request as GatewayBrowserClient["request"],
    );
    try {
      await runtimeConfig.ensureLoaded();
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
    } finally {
      runtimeConfig.dispose();
    }
  });

  it("keeps the restart-needed banner when reverting an acknowledged autosave draft", async () => {
    vi.useFakeTimers();
    const server = createConfigServerMock();
    const { runtimeConfig } = createConfigCapabilityHarness(
      server.request as GatewayBrowserClient["request"],
    );
    try {
      await runtimeConfig.ensureLoaded();
      runtimeConfig.patchForm(["count"], 2);
      await vi.advanceTimersByTimeAsync(CONFIG_FORM_AUTO_SAVE_DEBOUNCE_MS);
      expect(runtimeConfig.state.configNeedsApply).toBe(true);
      runtimeConfig.setRaw('{"count":3}');
      runtimeConfig.setRaw(runtimeConfig.state.configRawOriginal);
      expect(runtimeConfig.state.configNeedsApply).toBe(true);
      expect(runtimeConfig.state.configForm).toEqual({ count: 2 });
      expect(runtimeConfig.state.configFormDirty).toBe(false);
    } finally {
      runtimeConfig.dispose();
    }
  });

  it("keeps a failed first load retryable after a raw draft is reverted", async () => {
    const server = createConfigServerMock();
    server.request.mockRejectedValueOnce(new Error("unavailable"));
    const { runtimeConfig } = createConfigCapabilityHarness(
      server.request as GatewayBrowserClient["request"],
    );
    try {
      await runtimeConfig.ensureLoaded();
      runtimeConfig.setRaw('{"count":9}');
      runtimeConfig.setRaw(runtimeConfig.state.configRawOriginal);
      expect(runtimeConfig.state.configSnapshot).toBeNull();
      expect(runtimeConfig.state.configFormDirty).toBe(false);
      await runtimeConfig.ensureLoaded();
      expect(runtimeConfig.state.configForm).toEqual({ count: 1 });
    } finally {
      runtimeConfig.dispose();
    }
  });
});
