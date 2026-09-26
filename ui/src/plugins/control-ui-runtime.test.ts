import { describe, expect, it, vi } from "vitest";
import type { ApplicationContext } from "../app/context.ts";
import {
  createGatewayEvent,
  createGatewayStoreTestStore,
  GATEWAY_STORE_TEST_HELLO,
  stubGatewayStoreTestGlobals,
} from "../app/gateway-store.test-support.ts";
import { createControlUiPluginHost } from "./control-ui-host.ts";
import { initializeControlUiPlugin } from "./control-ui-loader.ts";
import { ControlUiPluginRuntime } from "./control-ui-runtime.ts";

vi.mock("./control-ui-loader.ts", () => ({ initializeControlUiPlugin: vi.fn() }));

describe("native plugin asset admission", () => {
  it.each([
    {
      scenario: "cross-origin native plugin",
      native: true,
      remote: true,
      error:
        "Native plugin UI requires the Control UI served by the connected Gateway. Open https://remote.example and reconnect there.",
    },
    { scenario: "ordinary remote connection", native: false, remote: true, error: null },
    {
      scenario: "missing native asset grant",
      native: true,
      remote: false,
      error: "Native plugin asset grant unavailable: review",
    },
    {
      scenario: "authenticated native plugin on plain HTTP",
      native: true,
      remote: false,
      secure: false,
      granted: true,
      error:
        "Native plugin UI requires HTTPS or localhost to authenticate its assets. Open this Gateway through HTTPS/Tailscale Serve, or use its loopback dashboard.",
    },
    {
      scenario: "native plugin without asset authentication on plain HTTP",
      native: true,
      remote: false,
      secure: false,
      requiresAuth: false,
      loads: true,
      error: null,
    },
    {
      scenario: "native plugin under a resource base path",
      native: true,
      remote: false,
      granted: true,
      loads: true,
      resourceBasePath: "/console",
      error: null,
    },
    {
      scenario: "activation error at a Unicode boundary",
      native: true,
      remote: false,
      requiresAuth: false,
      loads: true,
      activationError: `${"x".repeat(511)}😀tail`,
      error: `${"x".repeat(511)}😀tail`,
      reportedError: "x".repeat(511),
    },
  ])(
    "settles $scenario without leaving runtime state pending",
    async ({
      native,
      remote,
      error,
      secure = true,
      granted = false,
      requiresAuth = true,
      loads = false,
      resourceBasePath = "",
      activationError,
      reportedError = error,
    }) => {
      vi.stubGlobal("isSecureContext", secure);
      vi.mocked(initializeControlUiPlugin).mockReset();
      if (activationError) {
        vi.mocked(initializeControlUiPlugin).mockRejectedValue(new Error(activationError));
      }
      const request = vi.fn(async (method: string) =>
        method === "plugins.controlUi.list"
          ? {
              revision: "catalog-one",
              diagnostics: [],
              plugins: native
                ? [
                    {
                      pluginId: "review",
                      name: "Review",
                      revision: "one",
                      entryUrl: `${resourceBasePath}/__openclaw__/plugins/control-ui/review/one/index.js`,
                      styles: [],
                    },
                  ]
                : [],
            }
          : { ok: true },
      );
      const refresh = vi.fn(async () => ({
        pluginAssetsRequireAuth: requiresAuth,
        pluginFrameGrants: granted
          ? [
              {
                pluginId: "review",
                match: "prefix",
                path: `${resourceBasePath}/__openclaw__/plugins/control-ui/review/`,
              },
            ]
          : [],
      }));
      const context = {
        basePath: "/navigation-only",
        resourceBasePath,
        gateway: {
          snapshot: {
            phase: "connected",
            client: {
              gatewayUrl: remote
                ? "wss://remote.example/ws"
                : window.location.origin.replace(/^http/u, "ws"),
              request,
            },
            hello: {
              features: { methods: ["plugins.controlUi.list", "plugins.controlUi.report"] },
            },
          },
          subscribe: () => () => undefined,
          subscribeEvents: () => () => undefined,
        },
        config: { refresh },
      } as unknown as ApplicationContext;
      const runtime = new ControlUiPluginRuntime(() => context);
      try {
        runtime.start();
        await runtime.refresh();
        expect(runtime.errors).toEqual(error ? [{ pluginId: "review", message: error }] : []);
        expect(
          request.mock.calls.filter(([method]) => method === "plugins.controlUi.report"),
        ).toEqual(
          error
            ? [
                [
                  "plugins.controlUi.report",
                  {
                    pluginId: "review",
                    revision: "one",
                    status: "failed",
                    error: reportedError,
                  },
                ],
              ]
            : [],
        );
        expect(refresh).toHaveBeenCalledTimes(remote ? 0 : 1);
        expect(initializeControlUiPlugin).toHaveBeenCalledTimes(loads ? 1 : 0);
        expect(runtime.registrations("pages")).toEqual([]);
        expect(runtime.isLoading("review")).toBe(false);
      } finally {
        runtime.dispose();
        vi.unstubAllGlobals();
      }
    },
  );
});

it.each(["plugins.changed", "plugins.controlUi.changed"] as const)(
  "reconciles native UI on %s without retiring the unchanged connection",
  async (event) => {
    stubGatewayStoreTestGlobals();
    const { gateway, clients, current } = createGatewayStoreTestStore();
    gateway.connect({ gatewayUrl: window.location.origin.replace(/^http/u, "ws") });
    const client = current();
    let revision: string | null = "one";
    let generation = 0;
    const widgetKinds = () =>
      revision ? [{ pluginId: "review", kind: "review:summary", label: revision }] : [];
    const methods = ["plugins.uiDescriptors", "plugins.controlUi.list", "plugins.controlUi.report"];
    client.request.mockImplementation(async (method) => {
      if (method === "plugins.controlUi.list") {
        return {
          revision: String(generation),
          diagnostics: [],
          plugins: revision
            ? [
                {
                  pluginId: "review",
                  name: "Review",
                  revision,
                  entryUrl: `/__openclaw__/plugins/control-ui/review/${revision}/index.js`,
                  styles: [],
                  uiCapabilities: ["replacement", "widget"],
                },
              ]
            : [],
        };
      }
      if (method === "plugins.uiDescriptors") {
        return {
          ok: true,
          generation,
          descriptors: [],
          methods,
          controlUiTabs: [],
          controlUiWidgetKinds: widgetKinds(),
          pluginSurfaceUrls: {},
        };
      }
      if (method === "plugins.controlUi.report") {
        return { ok: true };
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    const context = {
      gateway,
      resourceBasePath: "",
      config: { refresh: async () => ({ pluginAssetsRequireAuth: false, pluginFrameGrants: [] }) },
    } as unknown as ApplicationContext;
    vi.mocked(initializeControlUiPlugin).mockImplementation(async (getContext, runtime, owner) => {
      const host = createControlUiPluginHost(getContext, runtime, owner);
      host.ui.registerReplacement({
        id: "composer",
        label: owner.descriptor.revision,
        surface: "composer",
        mount: () => undefined,
      });
      return Object.assign(owner, { host });
    });
    const runtime = new ControlUiPluginRuntime(() => context);
    const hello = {
      ...GATEWAY_STORE_TEST_HELLO,
      server: { connId: "native-connection-one" },
      features: { methods },
    };
    const changed = async (next: string | null) => {
      revision = next;
      if (event === "plugins.changed") {
        generation += 1;
      }
      client.opts.onEvent?.(
        createGatewayEvent(
          event,
          event === "plugins.changed" ? { generation } : { revision: next ?? "disabled" },
        ),
      );
      await vi.waitFor(() => {
        expect(gateway.snapshot.pluginCapabilities?.generation).toBe(generation);
        expect(gateway.snapshot.hello?.controlUiWidgetKinds).toEqual(widgetKinds());
        expect(runtime.isLoading("review")).toBe(false);
      });
    };
    try {
      runtime.start();
      client.opts.onHello?.(hello);
      await vi.waitFor(() => expect(runtime.registrations("replacements")).toHaveLength(1));
      runtime.selectReplacement("composer", "review/composer");
      const first = runtime.selectedReplacement("composer")!;

      // Optional contributions can be absent at activation or registered later.
      expect(runtime.errors).toEqual([]);
      first.host.ui.registerWidget({ id: "late", label: "Late widget", mount: () => undefined });
      expect(runtime.registrations("widgets")).toHaveLength(1);
      expect(runtime.errors).toEqual([]);
      const removePanel = first.host.ui.registerPanel({
        id: "undeclared",
        label: "Panel",
        mount: () => undefined,
      });
      expect(runtime.registrations("panels")).toHaveLength(1);
      const warning = {
        pluginId: "review",
        message:
          'Registered UI capability "panel" is missing from uiCapabilities in openclaw.plugin.json.',
      };
      expect(runtime.errors).toContainEqual(warning);
      runtime.reportError("review", "Activation receipt unavailable");
      expect(runtime.errors).toContainEqual(warning);
      expect(runtime.errors).toContainEqual({
        pluginId: "review",
        message: "Activation receipt unavailable",
      });

      await changed("one");
      expect(runtime.selectedReplacement("composer")?.signal).toBe(first.signal);
      expect(runtime.registrations("replacements")[0]?.host).toBe(first.host);
      expect(first.signal.aborted).toBe(false);
      expect(runtime.errors).toContainEqual(warning);
      removePanel();
      expect(runtime.errors).toEqual([]);

      await changed("two");
      const second = runtime.selectedReplacement("composer")!;
      expect(second.value.label).toBe("two");
      expect(first.signal.aborted).toBe(true);
      expect(second.signal.aborted).toBe(false);

      await changed(null);
      expect(runtime.registrations("replacements")).toEqual([]);
      expect(runtime.selectedReplacement("composer")).toBeUndefined();
      expect(second.signal.aborted).toBe(true);
      await expect(second.host.request("plugins.uiDescriptors", {})).rejects.toThrow(
        "This plugin UI activation has ended",
      );

      await changed("two");
      expect(runtime.registrations("replacements")).toHaveLength(1);
      expect(runtime.selectedReplacement("composer")).toBeUndefined();
      runtime.selectReplacement("composer", "review/composer");
      const reinstalled = runtime.selectedReplacement("composer")!;
      client.opts.onHello?.({ ...hello, server: { connId: "native-connection-two" } });
      await vi.waitFor(() => {
        expect(runtime.registrations("replacements")).toHaveLength(1);
        expect(runtime.isLoading("review")).toBe(false);
      });
      expect(reinstalled.signal.aborted).toBe(true);
      expect(runtime.selectedReplacement("composer")).toBeUndefined();
      expect(clients).toHaveLength(1);
      expect(client.stopped).toBe(0);
    } finally {
      runtime.dispose();
      gateway.stop();
      vi.mocked(initializeControlUiPlugin).mockReset();
      vi.unstubAllGlobals();
    }
  },
);
