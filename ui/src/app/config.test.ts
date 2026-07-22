// Config load tests cover bootstrap fetch behavior and timeouts.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ControlUiBootstrapConfig } from "../../../src/gateway/control-ui-contract.js";
import { createApplicationConfigCapability } from "./config.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function bootstrapResponse(serverVersion: string): Response {
  const payload: ControlUiBootstrapConfig = {
    basePath: "",
    assistantName: "Assistant",
    assistantAvatar: "A",
    assistantAgentId: "main",
    serverVersion,
    terminalEnabled: false,
    pluginFrameGrants: [],
  };
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("createApplicationConfigCapability", () => {
  it("returns null for a superseded bootstrap response", async () => {
    const firstResponse = deferred<Response>();
    const secondResponse = deferred<Response>();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(() => firstResponse.promise)
      .mockImplementationOnce(() => secondResponse.promise);
    vi.stubGlobal("fetch", fetchMock);
    const config = createApplicationConfigCapability({ basePath: "" });

    const firstRefresh = config.refresh();
    const secondRefresh = config.refresh();
    secondResponse.resolve(bootstrapResponse("new"));
    await expect(secondRefresh).resolves.toMatchObject({ serverVersion: "new" });
    firstResponse.resolve(bootstrapResponse("old"));

    await expect(firstRefresh).resolves.toBeNull();
    expect(config.current.serverVersion).toBe("new");
  });
});

describe("loadApplicationConfig", () => {
  it("passes an AbortSignal to the config fetch", async () => {
    const timeoutController = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutController.signal);

    const signalCapture = { signal: undefined as AbortSignal | undefined };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input, init) => {
        signalCapture.signal = init?.signal;
        return new Response(JSON.stringify({}), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    const capability = createApplicationConfigCapability({ basePath: "" });
    await capability.refresh();

    expect(signalCapture.signal).toBeDefined();
    expect(AbortSignal.timeout).toHaveBeenCalledWith(15_000);
  });

  it("aborts a stalled config fetch when the deadline fires", async () => {
    vi.useFakeTimers();
    const captured = { signal: undefined as AbortSignal | undefined };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input, init) => {
        captured.signal = init?.signal;
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        });
      }),
    );

    const capability = createApplicationConfigCapability({ basePath: "" });
    const refreshPromise = capability.refresh();
    await vi.advanceTimersByTimeAsync(0);
    expect(captured.signal?.aborted).toBe(false);

    // Just before the timeout — not yet aborted
    await vi.advanceTimersByTimeAsync(14_999);
    expect(captured.signal?.aborted).toBe(false);

    // Past the deadline — signal aborted, fetch rejects, refresh settles
    await vi.advanceTimersByTimeAsync(1);
    await expect(refreshPromise).resolves.toBeNull();
    expect(captured.signal?.aborted).toBe(true);

    // Config stays at defaults after the stalled fetch times out
    expect(capability.current.serverVersion).toBeNull();
  });
});
