import { describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "./types.js";
import {
  resolveEffectiveCapabilities,
  createCapabilityScopedApi,
  type PluginCapability,
} from "./capabilities.js";

// Mock the logging subsystem so emitSecurityEvent doesn't try to log
vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import * as eventLogger from "../security/event-logger.js";
const emitSpy = vi.spyOn(eventLogger, "emitSecurityEvent");

function createMockApi(overrides?: Partial<OpenClawPluginApi>): OpenClawPluginApi {
  return {
    id: "test-plugin",
    name: "Test Plugin",
    version: "1.0.0",
    description: "A test plugin",
    source: "/path/to/plugin",
    config: { someConfig: true } as unknown as OpenClawPluginApi["config"],
    pluginConfig: { key: "value" },
    runtime: {
      version: "1.0.0",
      config: { loadConfig: vi.fn(), writeConfigFile: vi.fn() },
      system: {
        enqueueSystemEvent: vi.fn(),
        runCommandWithTimeout: vi.fn(),
        formatNativeDependencyHint: vi.fn(),
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
      channel: {} as OpenClawPluginApi["runtime"]["channel"],
      logging: { shouldLogVerbose: vi.fn(), getChildLogger: vi.fn() },
      state: { resolveStateDir: vi.fn() },
    } as unknown as OpenClawPluginApi["runtime"],
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    registerTool: vi.fn(),
    registerHook: vi.fn(),
    registerHttpHandler: vi.fn(),
    registerHttpRoute: vi.fn(),
    registerChannel: vi.fn(),
    registerGatewayMethod: vi.fn(),
    registerCli: vi.fn(),
    registerService: vi.fn(),
    registerProvider: vi.fn(),
    registerCommand: vi.fn(),
    resolvePath: vi.fn((input: string) => input),
    on: vi.fn(),
    ...overrides,
  };
}

describe("resolveEffectiveCapabilities", () => {
  it("returns Set with declared capabilities", () => {
    const result = resolveEffectiveCapabilities({
      capabilities: ["tools", "cli"],
    });
    expect(result).toEqual(new Set(["tools", "cli"]));
  });

  it("auto-infers channels capability when manifest has channels", () => {
    const result = resolveEffectiveCapabilities({
      capabilities: ["tools"],
      channels: ["telegram"],
    });
    expect(result).toEqual(new Set(["tools", "channels"]));
  });

  it("auto-infers providers capability when manifest has providers", () => {
    const result = resolveEffectiveCapabilities({
      capabilities: ["tools"],
      providers: ["openai"],
    });
    expect(result).toEqual(new Set(["tools", "providers"]));
  });

  it("returns null for manifest with no capabilities field (legacy mode)", () => {
    const result = resolveEffectiveCapabilities({});
    expect(result).toBeNull();
  });

  it("deduplicates when capabilities includes channels and channels field is present", () => {
    const result = resolveEffectiveCapabilities({
      capabilities: ["channels"],
      channels: ["telegram"],
    });
    expect(result).toEqual(new Set(["channels"]));
    expect(result!.size).toBe(1);
  });
});

describe("createCapabilityScopedApi", () => {
  it("always allows access to id, name, logger, pluginConfig, resolvePath", () => {
    const api = createMockApi();
    const capabilities = new Set<PluginCapability>(["tools"]);
    const scoped = createCapabilityScopedApi(api, capabilities, "test-plugin");

    expect(scoped.id).toBe("test-plugin");
    expect(scoped.name).toBe("Test Plugin");
    expect(scoped.logger).toBe(api.logger);
    expect(scoped.pluginConfig).toEqual({ key: "value" });
    expect(scoped.resolvePath).toBe(api.resolvePath);
  });

  it("allows registerTool when tools capability is declared", () => {
    const api = createMockApi();
    const capabilities = new Set<PluginCapability>(["tools"]);
    const scoped = createCapabilityScopedApi(api, capabilities, "test-plugin");

    expect(() => scoped.registerTool({} as never)).not.toThrow();
  });

  it("throws when registerTool is called without tools capability", () => {
    const api = createMockApi();
    const capabilities = new Set<PluginCapability>(["hooks"]);
    const scoped = createCapabilityScopedApi(api, capabilities, "test-plugin");

    expect(() => scoped.registerTool({} as never)).toThrow(/test-plugin/);
  });

  it("allows config access when config_read capability is declared", () => {
    const api = createMockApi();
    const capabilities = new Set<PluginCapability>(["config_read"]);
    const scoped = createCapabilityScopedApi(api, capabilities, "test-plugin");

    expect(scoped.config).toBe(api.config);
  });

  it("returns undefined for config when config_read capability is NOT declared", () => {
    const api = createMockApi();
    const capabilities = new Set<PluginCapability>(["tools"]);
    const scoped = createCapabilityScopedApi(api, capabilities, "test-plugin");

    expect(scoped.config).toBeUndefined();
  });

  it("allows runtime.media when media capability is declared", () => {
    const api = createMockApi();
    const capabilities = new Set<PluginCapability>(["media"]);
    const scoped = createCapabilityScopedApi(api, capabilities, "test-plugin");

    expect(scoped.runtime.media).toBe(api.runtime.media);
  });

  it("returns undefined for runtime.media when media capability is NOT declared", () => {
    const api = createMockApi();
    const capabilities = new Set<PluginCapability>(["tools"]);
    const scoped = createCapabilityScopedApi(api, capabilities, "test-plugin");

    expect(scoped.runtime.media).toBeUndefined();
  });

  it("allows runtime.channel when runtime_channel capability is declared", () => {
    const api = createMockApi();
    const capabilities = new Set<PluginCapability>(["runtime_channel"]);
    const scoped = createCapabilityScopedApi(api, capabilities, "test-plugin");

    expect(scoped.runtime.channel).toBe(api.runtime.channel);
  });

  it("emits security event when undeclared method is called", () => {
    emitSpy.mockClear();
    const api = createMockApi();
    const capabilities = new Set<PluginCapability>(["hooks"]);
    const scoped = createCapabilityScopedApi(api, capabilities, "test-plugin");

    expect(() => scoped.registerTool({} as never)).toThrow();
    expect(emitSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "plugin.capability.denied",
        meta: expect.objectContaining({ pluginId: "test-plugin" }),
      }),
    );
  });

  it("emits security event when undeclared property is accessed", () => {
    emitSpy.mockClear();
    const api = createMockApi();
    const capabilities = new Set<PluginCapability>(["tools"]);
    const scoped = createCapabilityScopedApi(api, capabilities, "test-plugin");

    // Access undeclared config property
    const _result = scoped.config;
    expect(emitSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "plugin.capability.denied",
        meta: expect.objectContaining({ pluginId: "test-plugin" }),
      }),
    );
  });
});
