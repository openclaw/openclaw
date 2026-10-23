import { afterEach, expect, it, vi } from "vitest";
import type { PluginsControlUiCatalog } from "../../../packages/gateway-protocol/src/schema/plugins.js";
import { CONTROL_UI_BOOTSTRAP_CONFIG_ATTRIBUTE } from "../../../src/gateway/control-ui-bootstrap-contract.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { GatewayRequestError } from "../api/gateway.ts";
import { createApplicationConfigCapability } from "../app/config.ts";
import type { ApplicationContext } from "../app/context.ts";
import {
  createGatewayEvent,
  createGatewayStoreTestStore,
  GATEWAY_STORE_TEST_HELLO,
  stubGatewayStoreTestGlobals,
} from "../app/gateway-store.test-support.ts";
import { controlUiPluginAssetUrls } from "./control-ui-assets.ts";
import type { ControlUiPluginDistribution } from "./control-ui-distribution.ts";
import { createControlUiPluginHost } from "./control-ui-host.ts";
import * as controlUiLoader from "./control-ui-loader.ts";
import { ControlUiPluginRuntime } from "./control-ui-runtime.ts";

vi.spyOn(controlUiLoader, "initializeControlUiPlugin").mockResolvedValue(undefined);
const packaged = vi.hoisted(() => [] as ControlUiPluginDistribution[]);
vi.mock("./control-ui-distribution.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./control-ui-distribution.ts")>()),
  controlUiPluginDistributions: packaged,
}));

const catalogMethods = ["plugins.controlUi.list", "plugins.controlUi.report"];
const localGateway = () => location.origin.replace(/^http/u, "ws");
const assetPath = (revision = "one", base = "") =>
  `${base}/__openclaw__/plugins/control-ui/review/${revision}/`;
const grants = (base = "") => [
  {
    pluginId: "review",
    match: "prefix" as const,
    path: `${base}/__openclaw__/plugins/control-ui/review/`,
  },
];
const catalog = (plugins: PluginsControlUiCatalog["plugins"], revision = "catalog") => ({
  plugins,
  revision,
  diagnostics: [],
});
const runtimes: ControlUiPluginRuntime[] = [];
const runtimeFor = (context: ApplicationContext) => {
  const runtime = new ControlUiPluginRuntime(() => context);
  runtimes.push(runtime);
  return runtime;
};
afterEach(() => {
  for (const runtime of runtimes.splice(0)) {
    runtime.dispose();
  }
  packaged.length = 0;
  vi.mocked(controlUiLoader.initializeControlUiPlugin).mockReset().mockResolvedValue(undefined);
  vi.unstubAllGlobals();
});
const configForRuntime = (
  refresh: () => Promise<
    Pick<ApplicationContext["config"]["current"], "pluginAssetsRequireAuth" | "pluginFrameGrants">
  > = async () => ({
    pluginAssetsRequireAuth: false,
    pluginFrameGrants: [],
  }),
  resourceBasePath = "",
) => ({ ...createApplicationConfigCapability({ resourceBasePath }), refresh });
function connectedContext(
  client: { gatewayUrl: string; request: (method: string, params: unknown) => unknown } | undefined,
  configuration: ReturnType<typeof configForRuntime> | ApplicationContext["config"],
  resourceBasePath = "",
  advertised = ["plugins.controlUi.list"],
) {
  // SAFETY: the runtime reads only these gateway and config services.
  return {
    resourceBasePath,
    config: configuration,
    gateway: {
      snapshot: client
        ? { phase: "connected", client, hello: { features: { methods: advertised } } }
        : { phase: "connecting" },
      subscribe: () => () => undefined,
      subscribeEvents: () => () => undefined,
    },
  } as unknown as ApplicationContext;
}
const pluginDescriptor = (revision = "one", entryUrl = "/review.js") => ({
  pluginId: "review",
  name: "Review",
  revision,
  entryUrl,
  styles: [],
});

it("dispatches only explicitly advertised inline versions and restores saved version eligibility", async () => {
  const first = { pluginId: "review", id: "incident", version: 1, label: "Incident" };
  let inlineViews = [first, { ...first, version: 2 }];
  const mounts = [vi.fn(() => undefined), vi.fn(() => undefined)];
  const client = {
    gatewayUrl: localGateway(),
    request: async () => ({ ...catalog([pluginDescriptor()]), inlineViews }),
  };
  const context = connectedContext(client, configForRuntime());
  vi.mocked(controlUiLoader.initializeControlUiPlugin).mockImplementation(
    async (getContext, runtime, owner) => {
      const host = createControlUiPluginHost(getContext, runtime, owner);
      host.ui.registerInlineView({ id: "incident", version: 1, mount: mounts[0]! });
      host.ui.registerInlineView({ id: "incident", version: 2, mount: mounts[1]! });
      expect(() =>
        host.ui.registerInlineView({ id: "incident", version: 1, mount: mounts[0]! }),
      ).toThrow("duplicate");
      expect(() =>
        host.ui.registerInlineView({ id: "invalid", version: 0, mount: mounts[0]! }),
      ).toThrow("version");
      return Object.assign(owner, { host });
    },
  );
  const runtime = runtimeFor(context);
  runtime.start();
  await runtime.refresh();
  expect(
    runtime.registrations("inlineViews").map((entry) => [entry.key, entry.value.mount]),
  ).toEqual([
    ["review/incident@1", mounts[0]],
    ["review/incident@2", mounts[1]],
  ]);
  inlineViews = [{ ...first, version: 3 }];
  await runtime.refresh();
  expect(runtime.registrations("inlineViews")).toEqual([]);
  inlineViews = [first];
  await runtime.refresh();
  expect(runtime.registrations("inlineViews").map((entry) => entry.key)).toEqual([
    "review/incident@1",
  ]);
});

it.each([false, true])(
  "reports one completed catalog without delaying healthy plugins (superseded: %s)",
  async (superseded) => {
    const pending = [createDeferred(), createDeferred()];
    const started = [createDeferred(), createDeferred()];
    const ready = createDeferred();
    const descriptors = [
      pluginDescriptor("one", `${assetPath()}index.js`),
      {
        ...pluginDescriptor(),
        pluginId: "peer",
        entryUrl: "/__openclaw__/plugins/control-ui/peer/one/index.js",
      },
    ];
    let attempts = 0;
    let reportFailure: Error | undefined;
    const request = vi.fn(async (method: string, _params: unknown) => {
      if (method === "plugins.controlUi.list") {
        return catalog(descriptors);
      }
      if (reportFailure) {
        throw reportFailure;
      }
      return { ok: true };
    });
    const context = connectedContext({ gatewayUrl: localGateway(), request }, configForRuntime());
    vi.mocked(controlUiLoader.initializeControlUiPlugin).mockImplementation(
      async (getContext, runtime, owner) => {
        if (owner.descriptor.pluginId === "peer") {
          const attempt = attempts++;
          started[attempt]!.resolve();
          await pending[attempt]!.promise;
        }
        const host = createControlUiPluginHost(getContext, runtime, owner);
        host.ui.registerNavigation({ id: "page", label: "Page", page: { id: "page" } });
        return Object.assign(owner, { host });
      },
    );
    const runtime = runtimeFor(context);
    runtime.subscribe(() => {
      if (runtime.registrations("navigation").some((entry) => entry.pluginId === "review")) {
        ready.resolve();
      }
    });
    const reports = () =>
      request.mock.calls.filter(([method]) => method === "plugins.controlUi.report");
    try {
      runtime.start();
      const initialRefresh = runtime.refresh();
      await Promise.race([
        Promise.all([ready.promise, started[0]!.promise]),
        initialRefresh.then(() => {
          throw new Error(
            `Activation settled before peers started: ${JSON.stringify(runtime.errors)}`,
          );
        }),
      ]);
      const healthy = runtime.registrations("navigation")[0]!;
      expect(runtime.isLoading("review")).toBe(false);
      expect(runtime.isLoading("peer")).toBe(true);
      expect(reports()).toEqual([]);
      if (superseded) {
        const refresh = runtime.refresh();
        await started[1]!.promise;
        pending[1]!.resolve();
        await refresh;
      } else {
        pending[0]!.resolve();
        await initialRefresh;
      }
      expect(runtime.registrations("navigation")).toHaveLength(2);
      expect(healthy.signal.aborted).toBe(false);
      expect(reports()).toEqual([
        [
          "plugins.controlUi.report",
          {
            reports: [
              { pluginId: "review", revision: "one", status: "activated" },
              { pluginId: "peer", revision: "one", status: "activated" },
            ],
          },
        ],
      ]);
      reportFailure = new Error("Activation receipt unavailable");
      await runtime.refresh();
      expect(runtime.errors).toEqual([
        { pluginId: "review", message: "Activation receipt unavailable" },
        { pluginId: "peer", message: "Activation receipt unavailable" },
      ]);
      expect(healthy.signal.aborted).toBe(false);
      reportFailure = new GatewayRequestError({
        code: "INVALID_REQUEST",
        message: "Activation report is for an inactive browser revision",
        details: { rejectedPluginIds: ["peer"] },
      });
      await runtime.refresh();
      expect(runtime.errors).toEqual([
        { pluginId: "peer", message: "Activation report is for an inactive browser revision" },
      ]);
    } finally {
      pending.forEach((activation) => activation.resolve());
    }
  },
);

it.each(["cross-origin", "authenticated HTTP", "pending import"])(
  "loads only the matching distribution and retires same-revision eligibility loss: %s",
  async (scenario) => {
    const distribution = {
      pluginId: "workboard",
      revision: "same-bytes",
      bundledDistribution: { packageName: "@openclaw/workboard", packageVersion: "1.0.0" },
      entry: new URL("/assets/plugins/workboard/same-bytes/index.js", location.href).href,
      styles: [new URL("/assets/plugins/workboard/same-bytes/index.css", location.href).href],
      imports: [],
    };
    packaged.push(distribution);
    let descriptor: PluginsControlUiCatalog["plugins"][number] = {
      ...distribution,
      name: "Workboard",
      entryUrl: "/untrusted-gateway-path.js",
    };
    const pending = createDeferred();
    const started = createDeferred();
    const owners: Parameters<typeof controlUiLoader.initializeControlUiPlugin>[2][] = [];
    const reports: unknown[] = [];
    const refresh = vi.fn(async () => ({ pluginAssetsRequireAuth: true, pluginFrameGrants: [] }));
    const client = {
      gatewayUrl: scenario === "authenticated HTTP" ? localGateway() : "ws://gateway.example",
      request: async (method: string, params: unknown) => {
        if (method === "plugins.controlUi.list") {
          return catalog([descriptor]);
        }
        reports.push(params);
        return { ok: true };
      },
    };
    const context = connectedContext(client, configForRuntime(refresh));
    vi.stubGlobal("isSecureContext", false);
    vi.mocked(controlUiLoader.initializeControlUiPlugin).mockImplementation(
      async (getContext, runtime, owner) => {
        owners.push(owner);
        expect(controlUiPluginAssetUrls(owner.descriptor, "")).toEqual(distribution);
        started.resolve();
        if (scenario === "pending import") {
          await pending.promise;
          if (!runtime.isCurrent(owner)) {
            return undefined;
          }
        }
        const host = createControlUiPluginHost(getContext, runtime, owner);
        host.ui.registerNavigation({ id: "board", label: "Workboard", page: { id: "board" } });
        return Object.assign(owner, { host });
      },
    );
    const runtime = runtimeFor(context);
    try {
      runtime.start();
      await started.promise;
      if (scenario !== "pending import") {
        await vi.waitFor(() => expect(runtime.registrations("navigation")).toHaveLength(1));
      }
      // Same revision, package fields and code; only the loaded owner lost eligibility.
      descriptor = { ...descriptor, bundledDistribution: undefined };
      await runtime.refresh();
      pending.resolve();
      expect(owners[0]?.abort.signal.aborted).toBe(true);
      expect(runtime.registrations("navigation")).toEqual([]);
      expect(owners).toHaveLength(1);
      expect(reports).toContainEqual({
        reports: [expect.objectContaining({ status: "failed", pluginId: "workboard" })],
      });
      if (scenario !== "authenticated HTTP") {
        expect(refresh).not.toHaveBeenCalled();
      }
    } finally {
      pending.resolve();
    }
  },
);

it.each(["document", "published", "listener"] as const)(
  "preloads authorized config assets before connection from %s config",
  async (source) => {
    const prefix = assetPath();
    const descriptor = {
      ...pluginDescriptor("one", `${prefix}index.js`),
      styles: [`${prefix}index.css`],
      imports: [`${prefix}chunk.js`],
    };
    let modules = [descriptor];
    let granted = true;
    vi.stubGlobal("isSecureContext", true);
    const bootstrap = () => ({
      basePath: "",
      pluginControlUiModules: modules,
      pluginAssetsRequireAuth: true,
      pluginFrameGrants: granted ? grants() : [],
    });
    const fetchMock = vi.fn(async () => Response.json(bootstrap()));
    vi.stubGlobal("fetch", fetchMock);
    if (source === "document") {
      document.documentElement.setAttribute(
        CONTROL_UI_BOOTSTRAP_CONFIG_ATTRIBUTE,
        JSON.stringify(bootstrap()),
      );
    }
    const config = createApplicationConfigCapability({ resourceBasePath: "" });
    const runtime = runtimeFor(connectedContext(undefined, config));
    const links = () => [
      ...document.head.querySelectorAll<HTMLLinkElement>(`link[href*="${prefix}"]`),
    ];
    try {
      if (source === "published") {
        await config.refresh();
      }
      runtime.start();
      if (source === "listener") {
        await config.refresh();
      }
      if (source === "document") {
        expect(fetchMock).not.toHaveBeenCalled();
      }
      const first = links();
      expect(first.map((link) => [new URL(link.href).pathname, link.rel])).toEqual([
        [descriptor.entryUrl, "modulepreload"],
        [descriptor.imports[0], "modulepreload"],
        [descriptor.styles[0], "preload"],
      ]);
      expect(first.find((link) => link.rel === "preload")?.as).toBe("style");
      expect(runtime.registrations("navigation")).toEqual([]);
      await config.refresh();
      expect(links()).toEqual(first);
      granted = false;
      await config.refresh();
      expect(links()).toEqual([]);
      granted = true;
      await config.refresh();
      expect(links()).toHaveLength(3);
      modules = [{ ...descriptor, imports: ["https://foreign.example/chunk.js"] }];
      await config.refresh();
      expect(links()).toEqual([]);
      expect(runtime.errors).toContainEqual({
        pluginId: "review",
        message: "Native plugin assets must be served by this Control UI Gateway.",
      });
      modules = [];
      await config.refresh();
      expect(links()).toEqual([]);
      modules = [descriptor];
      await config.refresh();
    } finally {
      runtime.dispose();
      document.documentElement.removeAttribute(CONTROL_UI_BOOTSTRAP_CONFIG_ATTRIBUTE);
    }
    expect(links()).toEqual([]);
  },
);

it.each(["empty", "catalog-failed", "activation-failed", "activated"] as const)(
  "publishes registry completion only after the %s catalog settles",
  async (outcome) => {
    let response = createDeferred<PluginsControlUiCatalog>();
    const activationStarted = createDeferred();
    const activation = createDeferred();
    const completed = createDeferred();
    const request = vi.fn((method: string) =>
      method === "plugins.controlUi.list" ? response.promise : Promise.resolve({ ok: true }),
    );
    const context = connectedContext({ gatewayUrl: localGateway(), request }, configForRuntime());
    vi.mocked(controlUiLoader.initializeControlUiPlugin).mockImplementation(
      async (getContext, runtime, owner) => {
        activationStarted.resolve();
        await activation.promise;
        if (outcome === "activation-failed") {
          throw new Error("Plugin activation failed");
        }
        return Object.assign(owner, {
          host: createControlUiPluginHost(getContext, runtime, owner),
        });
      },
    );
    const runtime = runtimeFor(context);
    runtime.subscribe(() => {
      if (runtime.registryStatus !== "pending") {
        completed.resolve();
      }
    });
    try {
      expect(runtime.registryStatus).toBe("pending");
      runtime.start();
      expect(runtime.registryStatus).toBe("pending");
      if (outcome === "catalog-failed") {
        response.reject(new Error("Catalog unavailable"));
      } else {
        response.resolve(catalog(outcome === "empty" ? [] : [pluginDescriptor()], "one"));
      }
      if (outcome === "activated" || outcome === "activation-failed") {
        await activationStarted.promise;
        expect(runtime.registryStatus).toBe("pending");
        activation.resolve();
      }
      await completed.promise;
      expect(runtime.registryStatus).toBe(outcome === "catalog-failed" ? "failed" : "complete");
      if (outcome === "catalog-failed") {
        expect(runtime.errors).toEqual([{ pluginId: "host", message: "Catalog unavailable" }]);
        expect(controlUiLoader.initializeControlUiPlugin).not.toHaveBeenCalled();
        expect(request.mock.calls).toEqual([["plugins.controlUi.list", {}]]);
        expect(runtime.isLoading("review")).toBe(false);
        response = createDeferred<PluginsControlUiCatalog>();
        const retry = runtime.refresh();
        expect(runtime.registryStatus).toBe("pending");
        response.resolve(catalog([], "recovered"));
        await retry;
        expect(runtime.registryStatus).toBe("complete");
      }
    } finally {
      activation.resolve();
    }
  },
);

it("publishes a new revision for plugin-owned navigation mutations before notifying readers", async () => {
  const navigation = { id: "board", label: "Workboard", page: { id: "board" } };
  const completed = createDeferred();
  const context = connectedContext(
    {
      gatewayUrl: localGateway(),
      request: async (method) =>
        method === "plugins.controlUi.list" ? catalog([pluginDescriptor()]) : { ok: true },
    },
    configForRuntime(),
  );
  vi.mocked(controlUiLoader.initializeControlUiPlugin).mockImplementation(
    async (getContext, runtime, owner) => {
      const host = createControlUiPluginHost(getContext, runtime, owner);
      host.ui.registerNavigation(navigation);
      return Object.assign(owner, { host });
    },
  );
  const runtime = runtimeFor(context);
  expect(runtime.revision).toBe(0);
  runtime.subscribe(() => {
    if (runtime.registryStatus === "complete") {
      completed.resolve();
    }
  });
  runtime.start();
  await completed.promise;
  const registration = runtime.registrations("navigation")[0]!;
  const previousRevision = runtime.revision;
  const observed: { revision: number; label: string | undefined }[] = [];
  runtime.subscribe(() =>
    observed.push({
      revision: runtime.revision,
      label: runtime.registrations("navigation")[0]?.value.label,
    }),
  );

  navigation.label = "Updated board";
  registration.host.ui.invalidate();

  expect(runtime.registrations("navigation")[0]?.value).toBe(navigation);
  expect(observed).toEqual([{ revision: previousRevision + 1, label: "Updated board" }]);
});

it.each([
  {
    scenario: "cross-origin native plugin",
    remote: true,
    error:
      "Native plugin UI requires the Control UI served by the connected Gateway. Open https://remote.example and reconnect there.",
  },
  { scenario: "ordinary remote connection", native: false, remote: true },
  {
    scenario: "missing native asset grant",
    error: "Native plugin asset grant unavailable: review",
  },
  {
    scenario: "authenticated native plugin on plain HTTP",
    secure: false,
    granted: true,
    error:
      "Native plugin UI requires HTTPS or localhost to authenticate its assets. Open this Gateway through HTTPS/Tailscale Serve, or use its loopback dashboard.",
  },
  { scenario: "unauthenticated native HTTP", secure: false, requiresAuth: false, loads: true },
  {
    scenario: "native resource base path",
    granted: true,
    loads: true,
    resourceBasePath: "/console",
  },
])(
  "settles $scenario without loading protected modules",
  async ({
    native = true,
    remote = false,
    secure = true,
    granted = false,
    requiresAuth = true,
    loads = false,
    resourceBasePath = "",
    error = null,
  }) => {
    vi.stubGlobal("isSecureContext", secure);
    const request = vi.fn(async (method: string, _params: unknown) => {
      return method === "plugins.controlUi.list"
        ? catalog(
            native
              ? [pluginDescriptor("one", `${assetPath("one", resourceBasePath)}index.js`)]
              : [],
          )
        : { ok: true };
    });
    const refresh = vi.fn(async () => ({
      pluginAssetsRequireAuth: requiresAuth,
      pluginFrameGrants: granted ? grants(resourceBasePath) : [],
    }));
    const context = connectedContext(
      {
        gatewayUrl: remote ? "wss://remote.example/ws" : localGateway(),
        request,
      },
      configForRuntime(refresh, resourceBasePath),
      resourceBasePath,
      catalogMethods,
    );
    Object.assign(context, { basePath: "/navigation-only" });
    const runtime = runtimeFor(context);
    runtime.start();
    expect(refresh).toHaveBeenCalledTimes(remote ? 0 : 1);
    await runtime.refresh();
    expect(runtime.errors).toEqual(error ? [{ pluginId: "review", message: error }] : []);
    const reports = request.mock.calls
      .filter(([method]) => method === "plugins.controlUi.report")
      .map(([, params]) => params);
    expect(reports).toEqual(
      error
        ? [{ reports: [{ pluginId: "review", revision: "one", status: "failed", error }] }]
        : [],
    );
    expect(refresh).toHaveBeenCalledTimes(remote ? 0 : 2);
    expect(controlUiLoader.initializeControlUiPlugin).toHaveBeenCalledTimes(loads ? 1 : 0);
    expect(runtime.registrations("pages")).toEqual([]);
    expect(runtime.isLoading("review")).toBe(false);
    expect(runtime.registryStatus).toBe("complete");
  },
);

it.each(["plugins.changed", "plugins.controlUi.changed"] as const)(
  "reconciles native UI on %s without retiring the unchanged connection",
  async (event) => {
    stubGatewayStoreTestGlobals();
    const { gateway, clients, current } = createGatewayStoreTestStore();
    gateway.connect({ gatewayUrl: localGateway() });
    const client = current();
    let revision: string | null = "one";
    let generation = 0;
    const widgetKinds = () =>
      revision ? [{ pluginId: "review", kind: "review:summary", label: revision }] : [];
    const methods = ["plugins.uiDescriptors", "plugins.controlUi.list", "plugins.controlUi.report"];
    client.request.mockImplementation(async (method) => {
      if (method === "plugins.controlUi.list") {
        return catalog(
          revision
            ? [
                {
                  ...pluginDescriptor(revision, `${assetPath(revision)}index.js`),
                  uiCapabilities: ["replacement", "widget"],
                },
              ]
            : [],
          String(generation),
        );
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
      config: configForRuntime(),
    } as unknown as ApplicationContext;
    vi.mocked(controlUiLoader.initializeControlUiPlugin).mockImplementation(
      async (getContext, runtime, owner) => {
        const host = createControlUiPluginHost(getContext, runtime, owner);
        host.ui.registerReplacement({
          id: "composer",
          label: owner.descriptor.revision,
          surface: "composer",
          mount: () => undefined,
        });
        return Object.assign(owner, { host });
      },
    );
    const runtime = runtimeFor(context);
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
      client.testOptions.onEvent?.(
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
      client.testOptions.onHello?.(hello);
      await vi.waitFor(() => expect(runtime.registrations("replacements")).toHaveLength(1));
      runtime.selectReplacement("composer", "review/composer");
      const first = runtime.selectedReplacement("composer")!;

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
      expect(second).toMatchObject({ value: { label: "two" }, signal: { aborted: false } });
      expect(first.signal.aborted).toBe(true);

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
      client.testOptions.onHello?.({ ...hello, server: { connId: "native-connection-two" } });
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
    }
  },
);
