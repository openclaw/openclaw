import { afterEach, describe, expect, it, vi } from "vitest";
import { createPluginRegistry } from "./registry.js";
import type { PluginRuntime } from "./runtime/types.js";
import { createPluginRecord } from "./status.test-helpers.js";
import type { OpenClawPluginApi, PluginResetSessionResult } from "./types.js";

const mockLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};

const mockPerformGatewaySessionReset = vi.fn();

vi.mock("../gateway/session-reset-service.js", () => ({
  performGatewaySessionReset: (...args: unknown[]) => mockPerformGatewaySessionReset(...args),
}));

function createRegistryWithSessionReset() {
  return createPluginRegistry({
    logger: mockLogger,
    runtime: {} as PluginRuntime,
    coreGatewayHandlers: {
      "sessions.reset": () => {},
    } as never,
  });
}

function createRegistryWithoutSessionReset() {
  return createPluginRegistry({
    logger: mockLogger,
    runtime: {} as PluginRuntime,
  });
}

function registerAndCapture(
  reg: ReturnType<typeof createPluginRegistry>,
  opts?: { registrationMode?: OpenClawPluginApi["registrationMode"] },
): OpenClawPluginApi {
  const record = createPluginRecord({ id: "test-plugin", name: "Test Plugin" });
  reg.registry.plugins.push(record);
  return reg.createApi(record, {
    config: {} as OpenClawPluginApi["config"],
    registrationMode: opts?.registrationMode,
  });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("api.resetSession presence", () => {
  it("is absent outside full mode (setup-only)", () => {
    const reg = createRegistryWithSessionReset();
    const api = registerAndCapture(reg, { registrationMode: "setup-only" });
    expect(api.resetSession).toBeUndefined();
  });

  it("is absent outside full mode (setup-runtime)", () => {
    const reg = createRegistryWithSessionReset();
    const api = registerAndCapture(reg, { registrationMode: "setup-runtime" });
    expect(api.resetSession).toBeUndefined();
  });

  it("is absent when sessions.reset capability is not present", () => {
    const reg = createRegistryWithoutSessionReset();
    const api = registerAndCapture(reg);
    expect(api.resetSession).toBeUndefined();
  });

  it("is present in full mode when sessions.reset capability exists", () => {
    const reg = createRegistryWithSessionReset();
    const api = registerAndCapture(reg);
    expect(api.resetSession).toBeTypeOf("function");
  });
});

describe("api.resetSession validation", () => {
  it("returns structured failure for non-string key", async () => {
    const reg = createRegistryWithSessionReset();
    const api = registerAndCapture(reg);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await api.resetSession!(42 as any);
    expect(result).toEqual({
      ok: false,
      key: "",
      code: "INVALID_KEY",
      message: "session key must be a non-empty string",
    });
    expect(mockPerformGatewaySessionReset).not.toHaveBeenCalled();
  });

  it("returns structured failure for blank key", async () => {
    const reg = createRegistryWithSessionReset();
    const api = registerAndCapture(reg);
    const result = await api.resetSession!("   ");
    expect(result).toEqual({
      ok: false,
      key: "",
      code: "INVALID_KEY",
      message: "session key must be a non-empty string",
    });
  });

  it("returns structured failure for empty string key", async () => {
    const reg = createRegistryWithSessionReset();
    const api = registerAndCapture(reg);
    const result = await api.resetSession!("");
    expect(result).toEqual({
      ok: false,
      key: "",
      code: "INVALID_KEY",
      message: "session key must be a non-empty string",
    });
  });
});

describe("api.resetSession key and reason handling", () => {
  it("trims whitespace from key", async () => {
    mockPerformGatewaySessionReset.mockResolvedValue({
      ok: true,
      key: "work",
      entry: { sessionId: "sid-1" },
    });
    const reg = createRegistryWithSessionReset();
    const api = registerAndCapture(reg);
    await api.resetSession!("  work  ");
    expect(mockPerformGatewaySessionReset).toHaveBeenCalledWith(
      expect.objectContaining({ key: "work" }),
    );
  });

  it("normalizes default reason to new", async () => {
    mockPerformGatewaySessionReset.mockResolvedValue({
      ok: true,
      key: "work",
      entry: { sessionId: "sid-1" },
    });
    const reg = createRegistryWithSessionReset();
    const api = registerAndCapture(reg);
    await api.resetSession!("work");
    expect(mockPerformGatewaySessionReset).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "new" }),
    );
  });

  it("preserves explicit reset reason", async () => {
    mockPerformGatewaySessionReset.mockResolvedValue({
      ok: true,
      key: "work",
      entry: { sessionId: "sid-1" },
    });
    const reg = createRegistryWithSessionReset();
    const api = registerAndCapture(reg);
    await api.resetSession!("work", "reset");
    expect(mockPerformGatewaySessionReset).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "reset" }),
    );
  });

  it("normalizes unrecognized reason to new", async () => {
    mockPerformGatewaySessionReset.mockResolvedValue({
      ok: true,
      key: "work",
      entry: { sessionId: "sid-1" },
    });
    const reg = createRegistryWithSessionReset();
    const api = registerAndCapture(reg);
    await api.resetSession!("work", "something-else");
    expect(mockPerformGatewaySessionReset).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "new" }),
    );
  });

  it("passes plugin id as commandSource", async () => {
    mockPerformGatewaySessionReset.mockResolvedValue({
      ok: true,
      key: "work",
      entry: { sessionId: "sid-1" },
    });
    const reg = createRegistryWithSessionReset();
    const api = registerAndCapture(reg);
    await api.resetSession!("work");
    expect(mockPerformGatewaySessionReset).toHaveBeenCalledWith(
      expect.objectContaining({ commandSource: "plugin:test-plugin" }),
    );
  });
});

describe("api.resetSession success and failure normalization", () => {
  it("returns structured success with canonical key and sessionId", async () => {
    mockPerformGatewaySessionReset.mockResolvedValue({
      ok: true,
      key: "agent:default:work",
      entry: { sessionId: "abc-123" },
    });
    const reg = createRegistryWithSessionReset();
    const api = registerAndCapture(reg);
    const result = await api.resetSession!("work");
    expect(result).toEqual({
      ok: true,
      key: "agent:default:work",
      sessionId: "abc-123",
    } satisfies PluginResetSessionResult);
  });

  it("normalizes gateway error shape to plugin result", async () => {
    mockPerformGatewaySessionReset.mockResolvedValue({
      ok: false,
      error: { code: "UNAVAILABLE", message: "gateway down" },
    });
    const reg = createRegistryWithSessionReset();
    const api = registerAndCapture(reg);
    const result = await api.resetSession!("work");
    expect(result).toEqual({
      ok: false,
      key: "work",
      code: "UNAVAILABLE",
      message: "gateway down",
    });
  });

  it("normalizes thrown Error to structured result", async () => {
    mockPerformGatewaySessionReset.mockRejectedValue(new Error("connection lost"));
    const reg = createRegistryWithSessionReset();
    const api = registerAndCapture(reg);
    const result = await api.resetSession!("work");
    expect(result).toEqual({
      ok: false,
      key: "work",
      code: "RESET_ERROR",
      message: "connection lost",
    });
  });

  it("normalizes thrown string to structured result", async () => {
    mockPerformGatewaySessionReset.mockRejectedValue("something broke");
    const reg = createRegistryWithSessionReset();
    const api = registerAndCapture(reg);
    const result = await api.resetSession!("work");
    expect(result).toEqual({
      ok: false,
      key: "work",
      code: "RESET_ERROR",
      message: "something broke",
    });
  });

  it("normalizes unknown thrown value to structured result", async () => {
    mockPerformGatewaySessionReset.mockRejectedValue(12345);
    const reg = createRegistryWithSessionReset();
    const api = registerAndCapture(reg);
    const result = await api.resetSession!("work");
    expect(result).toEqual({
      ok: false,
      key: "work",
      code: "RESET_ERROR",
      message: "unknown error during session reset",
    });
  });
});
