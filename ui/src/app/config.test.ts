import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  CONTROL_UI_BOOTSTRAP_CONFIG_ATTRIBUTE,
  type ControlUiBootstrapConfig,
} from "../../../src/gateway/control-ui-contract.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createApplicationConfigCapability } from "./config.ts";

function bootstrapResponse(serverVersion: string, pluginAssetsRequireAuth?: boolean): Response {
  return Response.json({
    basePath: "",
    serverVersion,
    cliAgentsEnabled: true,
    pluginFrameGrants: [],
    ...(pluginAssetsRequireAuth === undefined ? {} : { pluginAssetsRequireAuth }),
  });
}

let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
beforeEach(() => {
  fetchMock = vi.fn<typeof fetch>();
  vi.stubGlobal("fetch", fetchMock);
});
function setup(options: Partial<Parameters<typeof createApplicationConfigCapability>[0]> = {}) {
  return createApplicationConfigCapability({ resourceBasePath: "", ...options });
}

function pendingResponse() {
  const response = createDeferred<Response>();
  fetchMock.mockImplementationOnce(() => response.promise);
  return (version: string) => response.resolve(bootstrapResponse(version));
}

function documentConfig(payload: ControlUiBootstrapConfig) {
  document.documentElement.setAttribute(
    CONTROL_UI_BOOTSTRAP_CONFIG_ATTRIBUTE,
    JSON.stringify(payload),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.documentElement.removeAttribute(CONTROL_UI_BOOTSTRAP_CONFIG_ATTRIBUTE);
});

it.each([
  ["chatBubblesEnabled", false],
  ["uploadsEnabled", true],
] as const)("publishes %s changes from its default %s", async (field, initial) => {
  fetchMock
    .mockResolvedValueOnce(Response.json({ [field]: !initial }))
    .mockResolvedValueOnce(Response.json({ [field]: initial }));
  const config = setup();
  const listener = vi.fn();
  config.subscribe(listener);
  expect(config.current[field]).toBe(initial);
  await config.refresh();
  expect(config.current[field]).toBe(!initial);
  await config.refresh();
  expect(config.current[field]).toBe(initial);
  expect(listener.mock.calls.map(([value]) => value[field])).toEqual([!initial, initial]);
});

it("keeps capabilities available when development plugin grants contain invalid URLs", async () => {
  vi.stubGlobal("OPENCLAW_UI_DEV_GATEWAY", {
    gatewayUrl: "ws://gateway.example/mount",
    proxyPath: "/dev-gateway",
  });
  fetchMock.mockImplementation(async () =>
    Response.json({
      terminalEnabled: true,
      cliAgentsEnabled: true,
      pluginFrameGrants: [
        {
          pluginId: "fixture",
          path: "/mount/plugins/fixture/",
          match: "prefix",
          unrecognized: "discard",
        },
        { pluginId: "malformed", path: "http://[", match: "prefix" },
        { pluginId: "foreign", path: "https://other.example/panel", match: "exact" },
        { path: "/missing-owner", match: "prefix" },
      ],
    }),
  );
  const config = setup({ resourceBasePath: "/dev-gateway/mount" });
  await expect(config.refresh()).resolves.toMatchObject({
    terminalEnabled: true,
    cliAgentsEnabled: true,
    pluginFrameGrants: [
      { pluginId: "fixture", path: "/dev-gateway/mount/plugins/fixture/", match: "prefix" },
      { pluginId: "malformed", path: "http://[", match: "prefix" },
      { pluginId: "foreign", path: "https://other.example/panel", match: "exact" },
    ],
  });
  expect(config.current.pluginFrameGrants[0]).not.toHaveProperty("unrecognized");
  expect(fetchMock).toHaveBeenCalledOnce();
});

it.each([undefined, false])(
  "requires native asset grants unless bootstrap explicitly disables auth: %s",
  async (pluginAssetsRequireAuth) => {
    fetchMock.mockImplementation(async () => bootstrapResponse("test", pluginAssetsRequireAuth));
    const config = setup();
    expect(config.current.pluginAssetsRequireAuth).toBe(true);
    await expect(config.refresh()).resolves.toMatchObject({
      pluginAssetsRequireAuth: pluginAssetsRequireAuth !== false,
      pluginFrameGrants: [],
    });
  },
);

it("returns an unavailable result for invalid bootstrap data", async () => {
  fetchMock.mockImplementation(async () => Response.json({ pluginFrameGrants: {} }));
  const config = setup();
  await expect(config.refresh()).resolves.toBeNull();
  expect(config.current.serverVersion).toBeNull();
});

it("publishes document config before requests and reuses it until invalidated", async () => {
  const payload: ControlUiBootstrapConfig = {
    basePath: "",
    assistantName: "Observatory",
    assistantAvatar: "🔭",
    preferences: { profileId: "synthetic-viewer", entries: { "ui.themeMode": "light" } },
    pluginFrameGrants: [{ pluginId: "fixture", path: "/panel", match: "exact" }],
  };
  documentConfig(payload);
  fetchMock.mockImplementation(async () => bootstrapResponse("updated"));
  const config = setup();
  expect(config.current.assistantIdentity).toMatchObject({ name: "Observatory", avatar: "🔭" });
  expect(config.current.pluginFrameGrants).toEqual(payload.pluginFrameGrants);
  expect(config.preferences).toEqual(payload.preferences);
  await config.refresh({ ifNeeded: true });
  expect(fetchMock).not.toHaveBeenCalled();
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 24 * 60 * 60 * 1_000);
  await config.refresh({ ifNeeded: true });
  expect(fetchMock).toHaveBeenCalledOnce();
  await config.refresh();
  expect(config.current.serverVersion).toBe("updated");
  expect(fetchMock).toHaveBeenCalledTimes(2);
});

it("revalidates document grants before reusing them with a startup bearer", async () => {
  documentConfig({
    basePath: "",
    preferences: { profileId: "browser-profile", entries: { "ui.themeMode": "light" } },
    assistantName: "Browser identity",
    assistantAvatar: "",
    pluginFrameGrants: [{ pluginId: "browser-only", path: "/browser", match: "prefix" }],
  });
  fetchMock.mockImplementation(async () => bootstrapResponse("bearer"));
  const config = setup({
    getAuth: () => ({ settings: { token: "test-other-identity" } }),
  });
  expect(config.current.assistantIdentity.name).toBe("Browser identity");
  expect(config.preferences).toBeUndefined();
  const result = await config.refresh({ ifNeeded: true });
  expect(fetchMock).toHaveBeenCalledOnce();
  expect(result).toMatchObject({ serverVersion: "bearer", pluginFrameGrants: [] });
});

it.each(["/other", "https://other.example"])(
  "does not adopt another resource owner's document config: %s",
  (resourceBasePath) => {
    documentConfig({ basePath: "", assistantName: "Observatory", assistantAvatar: "" });
    const config = createApplicationConfigCapability({ resourceBasePath });
    expect(config.current.assistantIdentity.name).toBe("Assistant");
  },
);

it("shares concurrent bootstrap loads with equivalent credentials", async () => {
  const respond = pendingResponse();
  let token = "fixture-token";
  const config = setup({ getAuth: () => ({ settings: { token } }) });

  const first = config.refresh();
  token = " fixture-token ";
  const second = config.refresh({ ifNeeded: true });
  respond("ready");

  await expect(first).resolves.toMatchObject({ serverVersion: "ready" });
  await expect(second).resolves.toMatchObject({ serverVersion: "ready" });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("refreshes without a bearer candidate at boot and after credentials change", async () => {
  const oldResponse = pendingResponse();
  fetchMock.mockResolvedValueOnce(bootstrapResponse("cookie"));
  let token = "fixture-token";
  const config = setup({ getAuth: () => ({ settings: { token } }) });
  const loading = config.refresh({ ifNeeded: true });
  token = "";
  await expect(config.refresh({ ifNeeded: true })).resolves.toMatchObject({
    serverVersion: "cookie",
  });
  oldResponse("retired");
  await expect(loading).resolves.toBeNull();
  expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
    credentials: "same-origin",
    headers: { Accept: "application/json" },
  });
  expect(fetchMock.mock.calls[1]?.[1]?.headers).not.toHaveProperty("Authorization");
  expect(config.current.serverVersion).toBe("cookie");
});

it.each([false, true])("rejects retired credentials (replacement refresh: %s)", async (replace) => {
  const old = pendingResponse();
  const replacement = pendingResponse();
  let token = "fixture-token";
  const config = setup({ getAuth: () => ({ settings: { token } }) });
  const loading = config.refresh();
  token = "replacement-fixture-token";
  if (replace) {
    const next = config.refresh();
    replacement("new");
    await expect(next).resolves.toMatchObject({ serverVersion: "new" });
  }
  old("retired");
  await expect(loading).resolves.toBeNull();
  expect(config.current.serverVersion).toBe(replace ? "new" : null);
  expect(fetchMock).toHaveBeenCalledTimes(replace ? 2 : 1);
  if (replace) {
    expect(config.current.cliAgentsEnabled).toBe(true);
  }
});

it.each([false, true])(
  "keeps independent callers valid and publishes the newest successful response (aborted: %s)",
  async (aborted) => {
    const firstResponse = pendingResponse();
    const secondResponse = pendingResponse();
    const config = setup();
    const abort = new AbortController();
    const first = config.refresh();
    const second = config.refresh({ signal: abort.signal });
    if (aborted) {
      abort.abort();
    }
    secondResponse("new");
    expect(await second).toEqual(
      aborted ? null : expect.objectContaining({ serverVersion: "new" }),
    );
    firstResponse("old");

    await expect(first).resolves.toMatchObject({ serverVersion: "old" });
    expect(config.current.serverVersion).toBe(aborted ? "old" : "new");
  },
);
