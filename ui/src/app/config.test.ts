import { afterEach, describe, expect, it, vi } from "vitest";
import { CONTROL_UI_TERMINAL_ENABLED_ATTRIBUTE } from "../../../src/gateway/control-ui-bootstrap-contract.js";
import {
  CONTROL_UI_BOOTSTRAP_CONFIG_ATTRIBUTE,
  type ControlUiBootstrapConfig,
} from "../../../src/gateway/control-ui-contract.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createApplicationConfigCapability } from "./config.ts";
import { registerControlUiReloadGuard } from "./document-reload-guard.ts";

function bootstrapResponse(
  serverVersion: string,
  automaticallyFetchFavicons = false,
  pluginAssetsRequireAuth?: boolean,
  communityInvite = true,
  remoteImageOrigins?: string[],
  terminalEnabled = false,
): Response {
  const payload: ControlUiBootstrapConfig = {
    basePath: "",
    assistantName: "Assistant",
    assistantAvatar: "A",
    assistantAgentId: "main",
    serverVersion,
    terminalEnabled,
    cliAgentsEnabled: true,
    automaticallyFetchFavicons,
    communityInvite,
    ...(remoteImageOrigins ? { remoteImageOrigins } : {}),
    ...(pluginAssetsRequireAuth === undefined ? {} : { pluginAssetsRequireAuth }),
    pluginFrameGrants: [],
  };
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.documentElement.removeAttribute(CONTROL_UI_BOOTSTRAP_CONFIG_ATTRIBUTE);
  document.documentElement.removeAttribute(CONTROL_UI_TERMINAL_ENABLED_ATTRIBUTE);
});

describe("createApplicationConfigCapability", () => {
  it("publishes upload policy changes and keeps the default enabled", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ uploadsEnabled: false }))
      .mockResolvedValueOnce(Response.json({ uploadsEnabled: true }));
    vi.stubGlobal("fetch", fetchMock);
    const config = createApplicationConfigCapability({ resourceBasePath: "" });
    const listener = vi.fn();
    config.subscribe(listener);
    expect(config.current.uploadsEnabled).toBe(true);
    await config.refresh();
    expect(config.current.uploadsEnabled).toBe(false);
    await config.refresh();
    expect(config.current.uploadsEnabled).toBe(true);
    expect(listener.mock.calls.map(([value]) => value.uploadsEnabled)).toEqual([false, true]);
  });

  it.each([undefined, "configured", "last-used"] as const)(
    "loads fresh-session model defaults %s",
    async (policy) => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(Response.json({ newSessionModelDefaults: policy })),
      );
      const config = createApplicationConfigCapability({ resourceBasePath: "" });
      await config.refresh();
      expect(config.current.newSessionModelDefaults).toBe(policy ?? "last-used");
    },
  );
  it("keeps capabilities available when development plugin grants contain invalid URLs", async () => {
    vi.stubGlobal("OPENCLAW_UI_DEV_GATEWAY", {
      gatewayUrl: "ws://gateway.example/mount",
      proxyPath: "/dev-gateway",
    });
    const fetchMock = vi.fn<typeof fetch>(async () =>
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
    vi.stubGlobal("fetch", fetchMock);
    const config = createApplicationConfigCapability({ resourceBasePath: "/dev-gateway/mount" });
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

  it("keeps invitations hidden until bootstrap enables them and accepts later opt-outs", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(bootstrapResponse("test"))
      .mockResolvedValueOnce(bootstrapResponse("test", false, undefined, false));
    vi.stubGlobal("fetch", fetchMock);
    const config = createApplicationConfigCapability({ resourceBasePath: "" });
    const listener = vi.fn();
    const unsubscribe = config.subscribe(listener);

    expect(config.current.communityInvite).toBe(false);
    await expect(config.refresh()).resolves.toMatchObject({ communityInvite: true });
    await expect(config.refresh()).resolves.toMatchObject({ communityInvite: false });
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ communityInvite: false }));
    unsubscribe();
  });

  it.each([undefined, true, false])(
    "requires native asset grants unless bootstrap explicitly disables auth: %s",
    async (pluginAssetsRequireAuth) => {
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(async () => bootstrapResponse("test", false, pluginAssetsRequireAuth)),
      );
      const config = createApplicationConfigCapability({ resourceBasePath: "" });
      expect(config.current.pluginAssetsRequireAuth).toBe(true);
      await expect(config.refresh()).resolves.toMatchObject({
        pluginAssetsRequireAuth: pluginAssetsRequireAuth !== false,
        pluginFrameGrants: [],
      });
    },
  );

  it("stays fail closed before bootstrap and accepts the Gateway favicon setting", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => bootstrapResponse("test", true));
    vi.stubGlobal("fetch", fetchMock);
    const config = createApplicationConfigCapability({ resourceBasePath: "/openclaw" });

    expect(config.current.automaticallyFetchFavicons).toBe(false);
    await expect(config.refresh()).resolves.toMatchObject({ automaticallyFetchFavicons: true });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/openclaw/control-ui-config.json");
    expect(config.current.automaticallyFetchFavicons).toBe(true);
  });

  it("accepts the Gateway's canonical remote image origins", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () =>
        bootstrapResponse("test", false, undefined, true, ["https://images.example.test"]),
      ),
    );
    const config = createApplicationConfigCapability({ resourceBasePath: "" });

    expect(config.current.remoteImageOrigins).toEqual([]);
    await expect(config.refresh()).resolves.toMatchObject({
      remoteImageOrigins: ["https://images.example.test"],
    });
  });

  it.each([
    [[], ["https://images.example.test"]],
    [["https://images.example.test"], []],
  ])("publishes image policy changes without reloading %j -> %j", async (initial, next) => {
    const reload = vi.fn();
    vi.stubGlobal("window", { location: { origin: "https://ui.example.test", reload } });
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(bootstrapResponse("test", false, undefined, true, initial))
        .mockResolvedValueOnce(bootstrapResponse("test", false, undefined, true, next)),
    );
    const config = createApplicationConfigCapability({ resourceBasePath: "" });
    await config.refresh();
    expect(config.current.remoteImageOrigins).toEqual(initial);
    const listener = vi.fn();
    config.subscribe(listener);
    await config.refresh();
    expect(reload).not.toHaveBeenCalled();
    expect(listener).toHaveBeenCalledOnce();
    expect(config.current.remoteImageOrigins).toEqual(next);
  });

  it("revokes remote image origins when a guarded terminal-policy reload is blocked", async () => {
    document.documentElement.setAttribute(CONTROL_UI_TERMINAL_ENABLED_ATTRIBUTE, "true");
    const reload = vi.fn();
    vi.stubGlobal("window", { location: { origin: "https://ui.example.test", reload } });
    const unregisterReloadGuard = registerControlUiReloadGuard(() => false, vi.fn());
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          bootstrapResponse(
            "initial",
            false,
            undefined,
            true,
            ["https://images.example.test"],
            true,
          ),
        )
        .mockResolvedValueOnce(bootstrapResponse("updated", false, undefined, true, [], false)),
    );
    const config = createApplicationConfigCapability({ resourceBasePath: "" });
    try {
      await config.refresh();
      expect(config.current.terminalEnabled).toBe(true);
      expect(config.current.remoteImageOrigins).toEqual(["https://images.example.test"]);
      const listener = vi.fn();
      config.subscribe(listener);

      await config.refresh();

      expect(reload).not.toHaveBeenCalled();
      expect(config.current.terminalEnabled).toBe(true);
      expect(config.current.remoteImageOrigins).toEqual([]);
      expect(listener).toHaveBeenCalledOnce();
      expect(listener).toHaveBeenLastCalledWith(
        expect.objectContaining({
          terminalEnabled: true,
          remoteImageOrigins: [],
        }),
      );
    } finally {
      unregisterReloadGuard();
      document.documentElement.removeAttribute(CONTROL_UI_TERMINAL_ENABLED_ATTRIBUTE);
    }
  });

  it.each([null, { pluginFrameGrants: {} }])(
    "returns an unavailable result for invalid bootstrap data: %j",
    async (payload) => {
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(async () => new Response(JSON.stringify(payload))),
      );
      const config = createApplicationConfigCapability({ resourceBasePath: "" });

      await expect(config.refresh()).resolves.toBeNull();
      expect(config.current.serverVersion).toBeNull();
    },
  );

  it("publishes document config before requests and reuses it until invalidated", async () => {
    const payload: ControlUiBootstrapConfig = {
      basePath: "",
      assistantName: "Observatory",
      assistantAvatar: "🔭",
      assistantAgentId: "main",
      terminalEnabled: false,
      pluginFrameGrants: [{ pluginId: "fixture", path: "/panel", match: "exact" }],
    };
    document.documentElement.setAttribute(
      CONTROL_UI_BOOTSTRAP_CONFIG_ATTRIBUTE,
      JSON.stringify(payload),
    );
    const fetchMock = vi.fn<typeof fetch>(async () => bootstrapResponse("updated"));
    vi.stubGlobal("fetch", fetchMock);
    const config = createApplicationConfigCapability({ resourceBasePath: "" });
    expect(config.current.assistantIdentity).toMatchObject({ name: "Observatory", avatar: "🔭" });
    expect(config.current.pluginFrameGrants).toEqual(payload.pluginFrameGrants);
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
    document.documentElement.setAttribute(
      CONTROL_UI_BOOTSTRAP_CONFIG_ATTRIBUTE,
      JSON.stringify({
        basePath: "",
        assistantName: "Browser identity",
        assistantAvatar: "B",
        pluginFrameGrants: [{ pluginId: "browser-only", path: "/browser", match: "prefix" }],
      }),
    );
    const fetchMock = vi.fn<typeof fetch>(async () => bootstrapResponse("bearer"));
    vi.stubGlobal("fetch", fetchMock);
    const config = createApplicationConfigCapability({
      resourceBasePath: "",
      getAuth: () => ({ settings: { token: "test-other-identity" } }),
    });
    expect(config.current.assistantIdentity.name).toBe("Browser identity");
    const result = await config.refresh({ ifNeeded: true });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ serverVersion: "bearer", pluginFrameGrants: [] });
  });

  it.each(["/other", "https://other.example"])(
    "does not adopt another resource owner's document config: %s",
    (resourceBasePath) => {
      document.documentElement.setAttribute(
        CONTROL_UI_BOOTSTRAP_CONFIG_ATTRIBUTE,
        JSON.stringify({
          basePath: "",
          assistantName: "Observatory",
          assistantAvatar: "O",
        }),
      );
      const config = createApplicationConfigCapability({ resourceBasePath });
      expect(config.current.assistantIdentity.name).toBe("Assistant");
    },
  );

  it("shares concurrent bootstrap loads with equivalent credentials", async () => {
    const response = createDeferred<Response>();
    const fetchMock = vi.fn<typeof fetch>(() => response.promise);
    vi.stubGlobal("fetch", fetchMock);
    let token = "fixture-token";
    const config = createApplicationConfigCapability({
      resourceBasePath: "",
      getAuth: () => ({ settings: { token } }),
    });

    const first = config.refresh();
    token = " fixture-token ";
    const second = config.refresh({ ifNeeded: true });
    response.resolve(bootstrapResponse("ready"));

    await expect(first).resolves.toMatchObject({ serverVersion: "ready" });
    await expect(second).resolves.toMatchObject({ serverVersion: "ready" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refreshes without a bearer candidate at boot and after credentials change", async () => {
    const oldResponse = createDeferred<Response>();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(() => oldResponse.promise)
      .mockResolvedValueOnce(bootstrapResponse("cookie"));
    vi.stubGlobal("fetch", fetchMock);
    let token = "fixture-token";
    const config = createApplicationConfigCapability({
      resourceBasePath: "",
      getAuth: () => ({ settings: { token } }),
    });
    const loading = config.refresh({ ifNeeded: true });
    token = "";
    await expect(config.refresh({ ifNeeded: true })).resolves.toMatchObject({
      serverVersion: "cookie",
    });
    oldResponse.resolve(bootstrapResponse("retired"));
    await expect(loading).resolves.toBeNull();
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    expect(fetchMock.mock.calls[1]?.[1]?.headers).not.toHaveProperty("Authorization");
    expect(config.current.serverVersion).toBe("cookie");
  });

  it.each(["", "replacement-fixture-token"])(
    "rejects an authenticated response when live credentials change without another refresh: %s",
    async (nextToken) => {
      const response = createDeferred<Response>();
      const fetchMock = vi.fn<typeof fetch>(() => response.promise);
      vi.stubGlobal("fetch", fetchMock);
      let token = "fixture-token";
      const config = createApplicationConfigCapability({
        resourceBasePath: "",
        getAuth: () => ({ settings: { token } }),
      });

      const loading = config.refresh();
      token = nextToken;
      response.resolve(bootstrapResponse("retired"));

      await expect(loading).resolves.toBeNull();
      expect(config.current.serverVersion).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it.each([false, true])(
    "keeps independent callers valid and publishes the newest successful response (aborted: %s)",
    async (aborted) => {
      const firstResponse = createDeferred<Response>();
      const secondResponse = createDeferred<Response>();
      vi.stubGlobal(
        "fetch",
        vi
          .fn<typeof fetch>()
          .mockImplementationOnce(() => firstResponse.promise)
          .mockImplementationOnce(() => secondResponse.promise),
      );
      const config = createApplicationConfigCapability({ resourceBasePath: "" });
      const abort = new AbortController();
      const first = config.refresh();
      const second = config.refresh({ signal: abort.signal });
      if (aborted) {
        abort.abort();
      }
      secondResponse.resolve(bootstrapResponse("new"));
      expect(await second).toEqual(
        aborted ? null : expect.objectContaining({ serverVersion: "new" }),
      );
      firstResponse.resolve(bootstrapResponse("old"));

      await expect(first).resolves.toMatchObject({ serverVersion: "old" });
      expect(config.current.serverVersion).toBe(aborted ? "old" : "new");
    },
  );

  it("returns null for a bootstrap response superseded by different credentials", async () => {
    const firstResponse = createDeferred<Response>();
    const secondResponse = createDeferred<Response>();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(() => firstResponse.promise)
      .mockImplementationOnce(() => secondResponse.promise);
    vi.stubGlobal("fetch", fetchMock);
    let token = "old-fixture-token";
    const config = createApplicationConfigCapability({
      resourceBasePath: "",
      getAuth: () => ({ settings: { token } }),
    });

    const firstRefresh = config.refresh();
    token = "new-fixture-token";
    const secondRefresh = config.refresh();
    secondResponse.resolve(bootstrapResponse("new"));
    await expect(secondRefresh).resolves.toMatchObject({ serverVersion: "new" });
    firstResponse.resolve(bootstrapResponse("old"));

    await expect(firstRefresh).resolves.toBeNull();
    expect(config.current.serverVersion).toBe("new");
    expect(config.current.cliAgentsEnabled).toBe(true);
  });
});
