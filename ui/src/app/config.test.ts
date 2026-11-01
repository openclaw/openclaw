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
const documentPayload: ControlUiBootstrapConfig = {
  basePath: "",
  assistantName: "Observatory",
  assistantAvatar: "🔭",
  preferences: { profileId: "synthetic-viewer", entries: { "ui.themeMode": "light" } },
  pluginFrameGrants: [{ pluginId: "fixture", path: "/panel", match: "exact" }],
};

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
  const grants = [
    { pluginId: "fixture", path: "/mount/plugins/fixture/", match: "prefix" },
    { pluginId: "malformed", path: "http://[", match: "prefix" },
    { pluginId: "foreign", path: "https://other.example/panel", match: "exact" },
  ];
  fetchMock.mockImplementation(async () =>
    Response.json({
      terminalEnabled: true,
      cliAgentsEnabled: true,
      pluginFrameGrants: [
        ...grants.map((grant) => ({ ...grant, unrecognized: "discard" })),
        { path: "/missing-owner", match: "prefix" },
      ],
    }),
  );
  const config = setup({ resourceBasePath: "/dev-gateway/mount" });
  await expect(config.refresh()).resolves.toMatchObject({
    terminalEnabled: true,
    cliAgentsEnabled: true,
    pluginFrameGrants: [
      { ...grants[0], path: "/dev-gateway/mount/plugins/fixture/" },
      ...grants.slice(1),
    ],
  });
  expect(config.current.pluginFrameGrants[0]).not.toHaveProperty("unrecognized");
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
  documentConfig(documentPayload);
  fetchMock.mockImplementation(async () => bootstrapResponse("updated"));
  const config = setup();
  expect(config.current.assistantIdentity).toMatchObject({ name: "Observatory", avatar: "🔭" });
  expect(config.current.pluginFrameGrants).toEqual(documentPayload.pluginFrameGrants);
  expect(config.preferences).toEqual(documentPayload.preferences);
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
  documentConfig(documentPayload);
  fetchMock.mockImplementation(async () => bootstrapResponse("bearer"));
  const config = setup({
    getAuth: () => ({ settings: { token: "test-other-identity" } }),
  });
  expect(config.current.assistantIdentity.name).toBe("Observatory");
  expect(config.preferences).toBeUndefined();
  const result = await config.refresh({ ifNeeded: true });
  expect(result).toMatchObject({ serverVersion: "bearer", pluginFrameGrants: [] });
});

it.each(["/other", "https://other.example"])(
  "does not adopt another resource owner's document config: %s",
  (resourceBasePath) => {
    documentConfig(documentPayload);
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

it.each(["cookie", "retired", "replacement", "newer", "aborted"] as const)(
  "settles concurrent bootstrap reads after %s",
  async (mode) => {
    const old = pendingResponse();
    const replacement = pendingResponse();
    let token = "fixture-token";
    const config = setup({ getAuth: () => ({ settings: { token } }) });
    const loading = config.refresh();
    const changesAuth = ["cookie", "retired", "replacement"].includes(mode);
    if (changesAuth) {
      token = mode === "cookie" ? "" : "replacement-fixture-token";
    }
    if (mode !== "retired") {
      const abort = new AbortController();
      const next = config.refresh({ ifNeeded: true, signal: abort.signal });
      if (mode === "aborted") {
        abort.abort();
      }
      replacement("new");
      expect(await next).toEqual(
        mode === "aborted" ? null : expect.objectContaining({ serverVersion: "new" }),
      );
    }
    old("retired");
    expect(await loading).toEqual(
      changesAuth ? null : expect.objectContaining({ serverVersion: "retired" }),
    );
    expect(config.current.serverVersion).toBe(
      mode === "retired" ? null : mode === "aborted" ? "retired" : "new",
    );
    expect(fetchMock).toHaveBeenCalledTimes(mode === "retired" ? 1 : 2);
    if (mode === "replacement") {
      expect(config.current.cliAgentsEnabled).toBe(true);
    }
    if (mode === "cookie") {
      expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      });
      expect(fetchMock.mock.calls[1]?.[1]?.headers).not.toHaveProperty("Authorization");
    }
  },
);
