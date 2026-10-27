import { afterEach, expect, it, vi } from "vitest";
import type { PluginsControlUiCatalog } from "../../../packages/gateway-protocol/src/schema/plugins.js";
import { CONTROL_UI_BOOTSTRAP_CONFIG_ATTRIBUTE } from "../../../src/gateway/control-ui-bootstrap-contract.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import { GatewayRequestError } from "../api/gateway-connect-errors.ts";
import { createApplicationConfigCapability } from "../app/config.ts";
import type { ApplicationContext } from "../app/context.ts";
import { createGatewayEvent } from "../app/gateway-store.test-support.ts";
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
  configuration:
    | ReturnType<typeof configForRuntime>
    | ApplicationContext["config"] = configForRuntime(),
  resourceBasePath = "",
  advertised = ["plugins.controlUi.list"],
) {
  // SAFETY: the runtime reads only these gateway and config services.
  return {
    resourceBasePath,
    config: configuration,
    gateway: {
      snapshot: client
        ? {
            phase: "connected",
            client,
            hello: {
              features: { methods: advertised },
              auth: { role: "operator", scopes: ["operator.admin"] },
            },
          }
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
const diagnostic = (message: string, pluginId = "review") => ({ pluginId, message });
const activationReport = (pluginId: string, error?: string) => ({
  pluginId,
  revision: "one",
  status: error ? "failed" : "activated",
  ...(error ? { error } : {}),
});
const navigation = (label = "Page") => ({ id: "page", label, page: { id: "page" } });
const mount = () => undefined;
const view = (id: string, label = id) => ({ id, label, mount });
const clientFor = (
  request: (method: string, params: unknown) => unknown,
  gatewayUrl = localGateway(),
) => ({ gatewayUrl, request });
const runtimeForRequest = (request: (method: string, params: unknown) => unknown) =>
  runtimeFor(connectedContext(clientFor(request)));
function initializeWith(
  register: (
    host: ReturnType<typeof createControlUiPluginHost>,
    owner: Parameters<typeof controlUiLoader.initializeControlUiPlugin>[2],
  ) => void | Promise<void>,
) {
  vi.mocked(controlUiLoader.initializeControlUiPlugin).mockImplementation(
    async (getContext, runtime, owner) => {
      const host = createControlUiPluginHost(getContext, runtime, owner);
      await register(host, owner);
      return Object.assign(owner, { host });
    },
  );
}

it("completes an unavailable catalog without requests or diagnostics for a limited connection", async () => {
  const request = vi.fn();
  const context = connectedContext(clientFor(request));
  context.gateway.snapshot.hello!.auth!.scopes = ["operator.sessions.read"];
  const runtime = runtimeFor(context);
  runtime.start();
  await runtime.refresh();
  expect(request).not.toHaveBeenCalled();
  expect(runtime).toMatchObject({ registryStatus: "complete", errors: [], hasPlugins: false });
});

it("dispatches only explicitly advertised inline versions and restores saved version eligibility", async () => {
  const first = { pluginId: "review", id: "incident", version: 1, label: "Incident" };
  let inlineViews = [first, { ...first, version: 2 }];
  const runtime = runtimeForRequest(async () => ({
    ...catalog([pluginDescriptor()]),
    inlineViews,
  }));
  initializeWith((host) => {
    const register = (version: number) =>
      host.ui.registerInlineView({ id: "incident", version, mount });
    register(1);
    register(2);
    expect(() => register(1)).toThrow("duplicate");
    expect(() => register(0)).toThrow("version");
  });
  runtime.start();
  await runtime.refresh();
  const keys = () => runtime.registrations("inlineViews").map((entry) => entry.key);
  expect(keys()).toEqual(["review/incident@1", "review/incident@2"]);
  inlineViews = [{ ...first, version: 3 }];
  await runtime.refresh();
  expect(keys()).toEqual([]);
  inlineViews = [first];
  await runtime.refresh();
  expect(keys()).toEqual(["review/incident@1"]);
});

it.each([false, true])(
  "reports one completed catalog without delaying healthy plugins (superseded: %s)",
  async (superseded) => {
    const pending = createDeferred();
    const started = createDeferred();
    const descriptors = [pluginDescriptor(), { ...pluginDescriptor(), pluginId: "peer" }];
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
    const runtime = runtimeForRequest(request);
    initializeWith(async (host, owner) => {
      if (owner.descriptor.pluginId === "peer" && attempts++ === 0) {
        started.resolve();
        await pending.promise;
      }
      host.ui.registerNavigation(navigation());
    });
    const reports = () =>
      request.mock.calls
        .filter(([method]) => method === "plugins.controlUi.report")
        .map(([, params]) => params);
    try {
      runtime.start();
      const initialRefresh = runtime.refresh();
      await started.promise;
      await vi.waitFor(() => expect(runtime.registrations("navigation")).toHaveLength(1));
      const healthy = runtime.registrations("navigation")[0]!;
      expect(runtime.isLoading("review")).toBe(false);
      expect(runtime.isLoading("peer")).toBe(true);
      expect(runtime.registryStatus).toBe("pending");
      expect(reports()).toEqual([]);
      if (superseded) {
        await runtime.refresh();
      } else {
        pending.resolve();
        await initialRefresh;
      }
      expect(runtime.registrations("navigation")).toHaveLength(2);
      expect(runtime.registryStatus).toBe("complete");
      expect(healthy.signal.aborted).toBe(false);
      expect(reports()).toEqual([
        { reports: ["review", "peer"].map((id) => activationReport(id)) },
      ]);
      reportFailure = new Error("Activation receipt unavailable");
      await runtime.refresh();
      expect(runtime.errors).toEqual(
        ["review", "peer"].map((id) => diagnostic("Activation receipt unavailable", id)),
      );
      expect(healthy.signal.aborted).toBe(false);
      reportFailure = new GatewayRequestError({
        code: "INVALID_REQUEST",
        message: "Activation report is for an inactive browser revision",
        details: { rejectedPluginIds: ["peer"] },
      });
      await runtime.refresh();
      expect(runtime.errors).toEqual([
        diagnostic("Activation report is for an inactive browser revision", "peer"),
      ]);
    } finally {
      pending.resolve();
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
      expect(runtime.errors).toContainEqual(
        diagnostic("Native plugin assets must be served by this Control UI Gateway."),
      );
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

it.each(["catalog-failed", "activation-failed"] as const)(
  "publishes registry completion only after the %s catalog settles",
  async (outcome) => {
    let response = createDeferred<PluginsControlUiCatalog>();
    const activationStarted = createDeferred();
    const activation = createDeferred();
    const request = (method: string) =>
      method === "plugins.controlUi.list" ? response.promise : Promise.resolve({ ok: true });
    const runtime = runtimeForRequest(request);
    initializeWith(async () => {
      activationStarted.resolve();
      await activation.promise;
      if (outcome === "activation-failed") {
        throw new Error("Plugin activation failed");
      }
    });
    try {
      runtime.start();
      const completion = runtime.refresh();
      expect(runtime.registryStatus).toBe("pending");
      if (outcome === "catalog-failed") {
        response.reject(new Error("Catalog unavailable"));
      } else {
        response.resolve(catalog([pluginDescriptor()], "one"));
      }
      if (outcome === "activation-failed") {
        await activationStarted.promise;
        expect(runtime.registryStatus).toBe("pending");
        activation.resolve();
      }
      await completion;
      expect(runtime.registryStatus).toBe(outcome === "catalog-failed" ? "failed" : "complete");
      if (outcome === "catalog-failed") {
        expect(runtime.errors).toEqual([diagnostic("Catalog unavailable", "host")]);
        expect(controlUiLoader.initializeControlUiPlugin).not.toHaveBeenCalled();
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

it.each([
  "cross-origin",
  "remote empty",
  "no grant",
  "authenticated HTTP",
  "public HTTP",
  "base path",
])("settles %s without loading protected modules", async (scenario) => {
  const remote = scenario === "cross-origin" || scenario === "remote empty";
  const resourceBasePath = scenario === "base path" ? "/console" : "";
  const granted = scenario === "base path" || scenario === "authenticated HTTP";
  const secure = !scenario.endsWith("HTTP");
  const requiresAuth = scenario !== "public HTTP";
  const loads = scenario === "base path" || scenario === "public HTTP";
  const error =
    scenario === "cross-origin"
      ? "Native plugin UI requires the Control UI served by the connected Gateway. Open https://remote.example and reconnect there."
      : scenario === "no grant"
        ? "Native plugin asset grant unavailable: review"
        : scenario === "authenticated HTTP"
          ? "Native plugin UI requires HTTPS or localhost to authenticate its assets. Open this Gateway through HTTPS/Tailscale Serve, or use its loopback dashboard."
          : null;
  vi.stubGlobal("isSecureContext", secure);
  const request = vi.fn(async (method: string, _params: unknown) =>
    method === "plugins.controlUi.list"
      ? catalog(
          scenario !== "remote empty"
            ? [pluginDescriptor("one", `${assetPath("one", resourceBasePath)}index.js`)]
            : [],
        )
      : { ok: true },
  );
  const refresh = vi.fn(async () => ({
    pluginAssetsRequireAuth: requiresAuth,
    pluginFrameGrants: granted ? grants(resourceBasePath) : [],
  }));
  const context = connectedContext(
    clientFor(request, remote ? "wss://remote.example/ws" : localGateway()),
    configForRuntime(refresh, resourceBasePath),
    resourceBasePath,
    catalogMethods,
  );
  Object.assign(context, { basePath: "/navigation-only" });
  const runtime = runtimeFor(context);
  runtime.start();
  await runtime.refresh();
  expect(runtime.errors).toEqual(error ? [diagnostic(error)] : []);
  const reports = request.mock.calls
    .filter(([method]) => method === "plugins.controlUi.report")
    .map(([, params]) => params);
  expect(reports).toEqual(error ? [{ reports: [activationReport("review", error)] }] : []);
  if (remote) {
    expect(refresh).not.toHaveBeenCalled();
  }
  expect(controlUiLoader.initializeControlUiPlugin).toHaveBeenCalledTimes(loads ? 1 : 0);
  expect(runtime.isLoading("review")).toBe(false);
  expect(runtime.registryStatus).toBe("complete");
});

it.each(["plugins.changed", "plugins.controlUi.changed"] as const)(
  "reconciles native UI on %s without retiring the unchanged connection",
  async (event) => {
    let revision: string | null = "one";
    const descriptor = (version: string): PluginsControlUiCatalog["plugins"][number] => ({
      ...pluginDescriptor(version),
      uiCapabilities: ["replacement", "widget", "navigation"],
    });
    const context = connectedContext(
      clientFor(async (method) => {
        if (method === "plugins.controlUi.list") {
          return catalog(revision ? [descriptor(revision)] : []);
        }
        if (method === "plugins.controlUi.report") {
          return { ok: true };
        }
        throw new Error(`Unexpected request: ${method}`);
      }),
    );
    let onConnection: Parameters<ApplicationContext["gateway"]["subscribe"]>[0] = () => {};
    let onEvent: Parameters<ApplicationContext["gateway"]["subscribeEvents"]>[0] = () => {};
    context.gateway.subscribe = (listener) => {
      onConnection = listener;
      return () => {};
    };
    context.gateway.subscribeEvents = (listener) => {
      onEvent = listener;
      return () => {};
    };
    const page = navigation();
    initializeWith((host, owner) => {
      host.ui.registerNavigation(page);
      host.ui.registerReplacement({
        ...view("composer", owner.descriptor.revision),
        surface: "composer",
      });
    });
    const runtime = runtimeFor(context);
    expect(runtime.revision).toBe(0);
    const changed = async (next: string | null) => {
      revision = next;
      onEvent(createGatewayEvent(event, {}));
      await vi.waitFor(() => expect(runtime.isLoading("review")).toBe(false));
    };
    try {
      runtime.start();
      await vi.waitFor(() => expect(runtime.registrations("replacements")).toHaveLength(1));
      runtime.selectReplacement("composer", "review/composer");
      const first = runtime.selectedReplacement("composer")!;
      const revisionBeforeMutation = runtime.revision;
      const observed: [number, string | undefined][] = [];
      const stopObserving = runtime.subscribe(() => {
        observed.push([runtime.revision, runtime.registrations("navigation")[0]?.value.label]);
      });
      page.label = "Updated board";
      first.host.ui.invalidate();
      stopObserving();
      expect(runtime.registrations("navigation")[0]?.value).toBe(page);
      expect(observed).toEqual([[revisionBeforeMutation + 1, "Updated board"]]);

      expect(runtime.errors).toEqual([]);
      first.host.ui.registerWidget(view("late"));
      expect(runtime.registrations("widgets")).toHaveLength(1);
      expect(runtime.errors).toEqual([]);
      const removePanel = first.host.ui.registerPanel(view("undeclared"));
      expect(runtime.registrations("panels")).toHaveLength(1);
      const warning = diagnostic(
        'Registered UI capability "panel" is missing from uiCapabilities in openclaw.plugin.json.',
      );
      expect(runtime.errors).toContainEqual(warning);
      runtime.reportError("review", "Activation receipt unavailable");
      expect(runtime.errors).toContainEqual(warning);
      expect(runtime.errors).toContainEqual(diagnostic("Activation receipt unavailable"));

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
      Object.assign(context.gateway.snapshot.hello!, { server: { connId: "new-connection" } });
      onConnection(context.gateway.snapshot);
      await vi.waitFor(() => {
        expect(runtime.registrations("replacements")).toHaveLength(1);
        expect(runtime.isLoading("review")).toBe(false);
      });
      expect(reinstalled.signal.aborted).toBe(true);
      expect(runtime.selectedReplacement("composer")).toBeUndefined();
    } finally {
      runtime.dispose();
    }
  },
);
