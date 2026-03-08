import fs from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { InternalHookEvent } from "../../internal-hooks.js";

const logInfo = vi.fn();
const logDebug = vi.fn();
const logWarn = vi.fn();

vi.mock("../../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    info: logInfo,
    debug: logDebug,
    warn: logWarn,
  }),
}));

function makeEvent(overrides?: Partial<InternalHookEvent>): InternalHookEvent {
  return {
    type: "agent",
    action: "bootstrap",
    sessionKey: "test",
    context: {
      cfg: {
        gateway: {
          port: 18789,
          auth: { token: "test-token" },
        },
      },
    },
    timestamp: new Date(),
    messages: [],
    ...overrides,
  };
}

describe("auto-wake handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.spyOn(fs, "readFile").mockRejectedValue(new Error("ENOENT"));
    vi.spyOn(fs, "writeFile").mockResolvedValue();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok", { status: 200 }));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("schedules wake on first event and fires after delay", async () => {
    // Fresh module import so wakeScheduled resets
    vi.resetModules();
    const { default: handler } = await import("./handler.js");

    await handler(makeEvent());

    expect(logInfo).toHaveBeenCalledWith(expect.stringContaining("will speak in"));
    expect(globalThis.fetch).not.toHaveBeenCalled();

    // Advance past WAKE_DELAY_MS
    await vi.advanceTimersByTimeAsync(20_000);

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://localhost:18789/v1/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "x-openclaw-session-key": "agent:main:main",
        }),
      }),
    );
    expect(logInfo).toHaveBeenCalledWith(expect.stringContaining("wake complete"));
  });

  it("skips when no auth token in config", async () => {
    vi.resetModules();
    const { default: handler } = await import("./handler.js");

    await handler(
      makeEvent({
        context: { cfg: { gateway: { port: 18789, auth: {} } } },
      }),
    );

    expect(logDebug).toHaveBeenCalledWith(expect.stringContaining("no gateway auth token"));
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("skips when stamp is within dedup window", async () => {
    vi.resetModules();
    vi.spyOn(fs, "readFile").mockResolvedValue(String(Date.now()) as never);
    const { default: handler } = await import("./handler.js");

    await handler(makeEvent());

    expect(logDebug).toHaveBeenCalledWith(expect.stringContaining("fired within last 2 min"));
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("only fires once (wakeScheduled guard)", async () => {
    vi.resetModules();
    const { default: handler } = await import("./handler.js");

    await handler(makeEvent());
    await handler(makeEvent());

    // logInfo called once for "will speak in" — second call is a no-op
    expect(logInfo).toHaveBeenCalledTimes(1);
  });

  it("logs warning on HTTP error", async () => {
    vi.resetModules();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("unauthorized", { status: 401 }));
    const { default: handler } = await import("./handler.js");

    await handler(makeEvent());
    await vi.advanceTimersByTimeAsync(20_000);

    expect(logWarn).toHaveBeenCalledWith(expect.stringContaining("HTTP 401"));
  });

  it("logs warning on fetch failure", async () => {
    vi.resetModules();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("connection refused"));
    const { default: handler } = await import("./handler.js");

    await handler(makeEvent());
    await vi.advanceTimersByTimeAsync(20_000);

    expect(logWarn).toHaveBeenCalledWith(expect.stringContaining("connection refused"));
  });

  it("reads port from config", async () => {
    vi.resetModules();
    const { default: handler } = await import("./handler.js");

    await handler(
      makeEvent({
        context: {
          cfg: {
            gateway: { port: 9999, auth: { token: "test-token" } },
          },
        },
      }),
    );
    await vi.advanceTimersByTimeAsync(20_000);

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://localhost:9999/v1/chat/completions",
      expect.anything(),
    );
  });
});
