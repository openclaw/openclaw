import { describe, expect, it, vi } from "vitest";
import type { PluginRuntime } from "../runtime/types.js";
import { gateRegistration, gateRuntime, type CapabilityDiagnostic } from "./enforce.js";
import { resolveCapabilities } from "./resolve.js";

function createMockRuntime(): PluginRuntime {
  return {
    version: "1.0.0",
    config: {} as PluginRuntime["config"],
    agent: {} as PluginRuntime["agent"],
    subagent: {} as PluginRuntime["subagent"],
    system: {} as PluginRuntime["system"],
    media: {} as PluginRuntime["media"],
    tts: {} as PluginRuntime["tts"],
    stt: {} as PluginRuntime["stt"],
    tools: {} as PluginRuntime["tools"],
    channel: {} as PluginRuntime["channel"],
    events: {} as PluginRuntime["events"],
    logging: {} as PluginRuntime["logging"],
    state: {} as PluginRuntime["state"],
    modelAuth: {} as PluginRuntime["modelAuth"],
  } as PluginRuntime;
}

describe("gateRegistration", () => {
  it("passes through when capability is allowed", () => {
    const caps = resolveCapabilities({ register: ["channel"], runtime: ["*"] });
    const original = vi.fn();
    const gated = gateRegistration("test-plugin", "registerChannel", original, caps);

    gated({ id: "test" });
    expect(original).toHaveBeenCalledWith({ id: "test" });
  });

  it("passes through when capabilities are unrestricted", () => {
    const caps = resolveCapabilities(undefined);
    const original = vi.fn();
    const gated = gateRegistration("test-plugin", "registerTool", original, caps);

    gated({ name: "test-tool" });
    expect(original).toHaveBeenCalled();
  });

  it("warns but calls through in warn mode", () => {
    const caps = resolveCapabilities({ register: ["provider"], runtime: ["*"] });
    const original = vi.fn();
    const diagnostics: CapabilityDiagnostic[] = [];
    const gated = gateRegistration("test-plugin", "registerChannel", original, caps, {
      mode: "warn",
      onDiagnostic: (d) => diagnostics.push(d),
    });

    gated({ id: "test" });
    expect(original).toHaveBeenCalled();
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].action).toBe("warned");
    expect(diagnostics[0].capability).toBe("channel");
  });

  it("blocks in enforce mode", () => {
    const caps = resolveCapabilities({ register: ["provider"], runtime: ["*"] });
    const original = vi.fn();
    const diagnostics: CapabilityDiagnostic[] = [];
    const gated = gateRegistration("test-plugin", "registerChannel", original, caps, {
      mode: "enforce",
      onDiagnostic: (d) => diagnostics.push(d),
    });

    gated({ id: "test" });
    expect(original).not.toHaveBeenCalled();
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].action).toBe("blocked");
  });

  it("does not gate unknown method names", () => {
    const caps = resolveCapabilities({ register: [], runtime: ["*"] });
    const original = vi.fn();
    const gated = gateRegistration("test-plugin", "unknownMethod", original, caps);

    gated();
    expect(original).toHaveBeenCalled();
  });
});

describe("gateRuntime", () => {
  it("allows access when capability is present", () => {
    const caps = resolveCapabilities({ register: ["*"], runtime: ["logging", "config.read"] });
    const runtime = createMockRuntime();
    const gated = gateRuntime("test-plugin", runtime, caps);

    expect(gated.logging).toBeDefined();
    expect(gated.config).toBeDefined();
  });

  it("allows all access when unrestricted", () => {
    const caps = resolveCapabilities(undefined);
    const runtime = createMockRuntime();
    const gated = gateRuntime("test-plugin", runtime, caps);

    // Should return the original runtime (no proxy).
    expect(gated).toBe(runtime);
  });

  it("warns but allows access in warn mode", () => {
    const caps = resolveCapabilities({ register: ["*"], runtime: ["logging"] });
    const runtime = createMockRuntime();
    const diagnostics: CapabilityDiagnostic[] = [];
    const gated = gateRuntime("test-plugin", runtime, caps, {
      mode: "warn",
      onDiagnostic: (d) => diagnostics.push(d),
    });

    const system = gated.system;
    expect(system).toBeDefined();
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].capability).toBe("system");
    expect(diagnostics[0].action).toBe("warned");
  });

  it("blocks access in enforce mode", () => {
    const caps = resolveCapabilities({ register: ["*"], runtime: ["logging"] });
    const runtime = createMockRuntime();
    const diagnostics: CapabilityDiagnostic[] = [];
    const gated = gateRuntime("test-plugin", runtime, caps, {
      mode: "enforce",
      onDiagnostic: (d) => diagnostics.push(d),
    });

    expect(gated.system).toBeUndefined();
    expect(gated.agent).toBeUndefined();
    expect(gated.logging).toBeDefined();
    expect(diagnostics).toHaveLength(2);
  });

  it("allows non-gated properties through", () => {
    const caps = resolveCapabilities({ register: ["*"], runtime: ["logging"] });
    const runtime = createMockRuntime();
    const gated = gateRuntime("test-plugin", runtime, caps, { mode: "enforce" });

    // "version" is not in the capability map, should always be accessible.
    expect(gated.version).toBe("1.0.0");
  });
});
