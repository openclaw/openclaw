import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getRuntimeConfig,
  clearConfigCache,
  clearRuntimeConfigSnapshot,
  getRuntimeConfigSnapshot,
} from "./config.js";
import { withTempHomeConfig } from "./test-helpers.js";

describe("talk config validation fail-closed behavior", () => {
  beforeEach(() => {
    clearRuntimeConfigSnapshot();
    clearConfigCache();
    vi.restoreAllMocks();
  });

  it("can load an unpinned runtime config without replacing the process snapshot", async () => {
    await withTempHomeConfig({ gateway: { port: 19002 } }, async () => {
      const unpinned = getRuntimeConfig({ skipPluginValidation: true, pin: false });
      expect(unpinned.gateway?.port).toBe(19002);
      expect(getRuntimeConfigSnapshot()).toBeNull();
      const pinned = getRuntimeConfig();
      expect(pinned.gateway?.port).toBe(19002);
      expect(getRuntimeConfigSnapshot()).toBe(pinned);
    });
  });

  it.each([true, false])("loads shell read-only classification opt-in %s", async (value) => {
    await withTempHomeConfig(
      { agents: { entries: { main: {} } }, talk: { shellReadOnlyClassification: value } },
      async () => {
        expect(getRuntimeConfig().talk?.shellReadOnlyClassification).toBe(value);
      },
    );
  });

  it("loads a configured shell read-only probability", async () => {
    await withTempHomeConfig(
      { agents: { entries: { main: {} } }, talk: { shellReadOnlyMinProbability: 0.95 } },
      async () => {
        expect(getRuntimeConfig().talk?.shellReadOnlyMinProbability).toBe(0.95);
      },
    );
  });

  it.each([
    {
      name: "invalid silence timeout",
      talk: { silenceTimeoutMs: true },
      message: /silenceTimeoutMs|talk/i,
    },
    {
      name: "non-boolean shell read-only classification",
      talk: { shellReadOnlyClassification: "true" },
      message: /shellReadOnlyClassification/,
    },
    {
      name: "zero shell read-only probability",
      talk: { shellReadOnlyMinProbability: 0 },
      message: /shellReadOnlyMinProbability/,
    },
    {
      name: "shell read-only probability above one",
      talk: { shellReadOnlyMinProbability: 1.01 },
      message: /shellReadOnlyMinProbability/,
    },
    {
      name: "provider absent from providers",
      talk: { provider: "acme", providers: { elevenlabs: { voiceId: "voice-123" } } },
      message: /talk\.provider|talk\.providers|acme/i,
    },
    {
      name: "ambiguous provider selection",
      talk: {
        providers: { acme: { voiceId: "voice-acme" }, elevenlabs: { voiceId: "voice-eleven" } },
      },
      message: /talk\.provider|required/i,
    },
  ])("rejects $name during config load", async ({ talk, message }) => {
    await withTempHomeConfig({ agents: { entries: { main: {} } }, talk }, async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      let thrown: unknown;
      try {
        getRuntimeConfig();
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(Error);
      expect(thrown).toMatchObject({
        code: "INVALID_CONFIG",
        message: expect.stringMatching(message),
      });
      expect(consoleSpy).toHaveBeenCalled();
    });
  });
});
