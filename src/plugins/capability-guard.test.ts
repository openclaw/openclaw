import { describe, expect, it, vi } from "vitest";
import { createGuardedRuntime } from "./capability-guard.js";
import type { PluginRuntime } from "./runtime/types.js";

function createMockRuntime(): PluginRuntime {
  return {
    version: "1.0.0",
    config: {
      loadConfig: vi.fn().mockReturnValue({}),
      writeConfigFile: vi.fn(),
    },
    system: {
      enqueueSystemEvent: vi.fn(),
      runCommandWithTimeout: vi.fn().mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 }),
      formatNativeDependencyHint: vi.fn().mockReturnValue(""),
    },
    media: {
      loadWebMedia: vi.fn(),
      detectMime: vi.fn(),
      mediaKindFromMime: vi.fn(),
      isVoiceCompatibleAudio: vi.fn(),
      getImageMetadata: vi.fn(),
      resizeToJpeg: vi.fn(),
    },
    tts: { textToSpeechTelephony: vi.fn() },
    tools: {
      createMemoryGetTool: vi.fn(),
      createMemorySearchTool: vi.fn(),
      registerMemoryCli: vi.fn(),
    },
    channel: {} as PluginRuntime["channel"],
    logging: {
      shouldLogVerbose: vi.fn().mockReturnValue(false),
      getChildLogger: vi.fn().mockReturnValue({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      }),
    },
    state: { resolveStateDir: vi.fn().mockReturnValue("/tmp/state") },
  } as unknown as PluginRuntime;
}

describe("createGuardedRuntime", () => {
  it("returns full runtime for bundled plugins", () => {
    const runtime = createMockRuntime();
    const guarded = createGuardedRuntime(runtime, "bundled");

    // Should be the exact same object
    expect(guarded).toBe(runtime);
  });

  it("blocks writeConfigFile for workspace plugins", () => {
    const runtime = createMockRuntime();
    const guarded = createGuardedRuntime(runtime, "workspace");

    expect(() => guarded.config.writeConfigFile({} as never, {} as never)).toThrow(
      "[plugin-sandbox] config.writeConfigFile is not available",
    );
  });

  it("blocks runCommandWithTimeout for workspace plugins", () => {
    const runtime = createMockRuntime();
    const guarded = createGuardedRuntime(runtime, "workspace");

    expect(() => guarded.system.runCommandWithTimeout(["echo", "hello"], 1000)).toThrow(
      "[plugin-sandbox] system.runCommandWithTimeout is not available",
    );
  });

  it("allows loadConfig for workspace plugins", () => {
    const runtime = createMockRuntime();
    const guarded = createGuardedRuntime(runtime, "workspace");

    // Should not throw
    guarded.config.loadConfig();
    expect(runtime.config.loadConfig).toHaveBeenCalled();
  });

  it("allows enqueueSystemEvent for workspace plugins", () => {
    const runtime = createMockRuntime();
    const guarded = createGuardedRuntime(runtime, "workspace");

    guarded.system.enqueueSystemEvent("test", {} as never);
    expect(runtime.system.enqueueSystemEvent).toHaveBeenCalled();
  });

  it("blocks dangerous operations for global origin", () => {
    const runtime = createMockRuntime();
    const guarded = createGuardedRuntime(runtime, "global");

    expect(() => guarded.config.writeConfigFile({} as never, {} as never)).toThrow(
      "[plugin-sandbox]",
    );
    expect(() => guarded.system.runCommandWithTimeout(["rm", "-rf", "/"], 1000)).toThrow(
      "[plugin-sandbox]",
    );
  });

  it("blocks dangerous operations for config origin", () => {
    const runtime = createMockRuntime();
    const guarded = createGuardedRuntime(runtime, "config");

    expect(() => guarded.config.writeConfigFile({} as never, {} as never)).toThrow(
      "[plugin-sandbox]",
    );
  });

  it("preserves media, tts, tools, logging, and state access", () => {
    const runtime = createMockRuntime();
    const guarded = createGuardedRuntime(runtime, "workspace");

    // These should be the same references
    expect(guarded.media).toBe(runtime.media);
    expect(guarded.tts).toBe(runtime.tts);
    expect(guarded.tools).toBe(runtime.tools);
    expect(guarded.logging).toBe(runtime.logging);
    expect(guarded.state).toBe(runtime.state);
    expect(guarded.channel).toBe(runtime.channel);
    expect(guarded.version).toBe(runtime.version);
  });
});
