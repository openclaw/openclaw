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
  vi.unstubAllGlobals();
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

  it("sends the device token as a Bearer credential when it is the only candidate", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => bootstrapResponse("v1"));
    vi.stubGlobal("fetch", fetchMock);
    const config = createApplicationConfigCapability({ basePath: "" });

    await config.refresh({ auth: { deviceToken: "device-token" } });

    const init = fetchMock.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer device-token");
  });

  it("does not skip the fetch when only a device token authenticates the request", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => bootstrapResponse("v1"));
    vi.stubGlobal("fetch", fetchMock);
    const config = createApplicationConfigCapability({ basePath: "" });

    const result = await config.refresh({
      auth: { deviceToken: "device-token" },
      skipWithoutAuthCandidate: true,
    });

    expect(result).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps localMediaPreviewRootsLoaded false on a failed fetch and true after success", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(bootstrapResponse("v1"));
    vi.stubGlobal("fetch", fetchMock);
    const config = createApplicationConfigCapability({ basePath: "" });

    // 401 falls through to the default config; roots were never loaded.
    expect(config.current.localMediaPreviewRootsLoaded).toBe(false);
    await config.refresh({ auth: { deviceToken: "device-token" } });
    expect(config.current.localMediaPreviewRootsLoaded).toBe(false);

    await config.refresh({ auth: { deviceToken: "device-token" } });
    expect(config.current.localMediaPreviewRootsLoaded).toBe(true);
  });
});
