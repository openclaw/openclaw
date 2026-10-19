import fs from "node:fs";
import path from "node:path";
import { TLSSocket } from "node:tls";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { getRuntimeConfig } from "../config/io.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import type { PluginRecord } from "../plugins/registry.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import * as userProfileCatalog from "../state/user-profile-list.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  handleControlUiPluginAssetRequest,
  listControlUiPluginCatalog,
  listControlUiPluginActivations,
  reportControlUiPluginActivation,
  reloadControlUiPluginCatalog,
} from "./control-ui-plugin-assets.js";
import { setControlUiPluginAuthCookie } from "./control-ui-plugin-auth-cookie.js";
import {
  listControlUiPluginTabAuthGrants,
  listControlUiPluginWidgetKinds,
} from "./control-ui-plugin-tabs.js";
import { resolveControlUiPluginAuthCookieGeneration } from "./http-auth-plugin-cookie.js";
import { setControlUiPluginAuthCookieForRequest } from "./http-auth-utils.js";
import { authorizeOperatorScopesForMethod } from "./method-scopes.js";
import {
  AUTH_NONE,
  AUTH_TOKEN,
  createRequest,
  createResponse,
  createTestGatewayServer,
  dispatchRequest,
  sendRequest,
  withGatewayServer,
} from "./server-http.test-harness.js";
import { resolveSharedGatewaySessionGeneration } from "./server/ws-shared-generation.js";
import { makeMockHttpResponse } from "./test-http-response.js";
import { withTempConfig } from "./test-temp-config.js";

const tempDirs = createTempDirTracker();
const firstSource = 'export default { id: "native-ui" };';
const immutableCache = "private, max-age=31536000, immutable";
type Response = ReturnType<typeof createResponse>;
type Server = Parameters<typeof sendRequest>[0];
type RequestOptions = Omit<Parameters<typeof sendRequest>[1], "path">;

function fetchAsset(server: Server, requestPath: string, options: RequestOptions = {}) {
  return sendRequest(server, { path: requestPath, ...options });
}

async function expectStatus(response: Response | Promise<Response>, statusCode: number) {
  expect((await response).res.statusCode).toBe(statusCode);
}

function cookies(response: Response) {
  return response.setHeader.mock.calls
    .filter(([name]) => name === "Set-Cookie")
    .flatMap(([, value]) => (Array.isArray(value) ? value : [value]));
}

function expectBody(response: Response, source: string) {
  expect(response.res.statusCode).toBe(200);
  expect(response.end.mock.calls[0]?.[0]?.toString()).toBe(source);
}

function expectCatalogFailure(
  catalog: Awaited<ReturnType<typeof listControlUiPluginCatalog>>,
  plugins: typeof catalog.plugins,
  message = "Build the plugin",
) {
  expect(catalog.plugins).toEqual(plugins);
  expect(catalog.diagnostics).toEqual([
    { pluginId: "native-ui", message: expect.stringContaining(message) },
  ]);
}

function assetServer(basePath = "", resolvedAuth = AUTH_TOKEN) {
  return createTestGatewayServer({
    resolvedAuth,
    overrides: { controlUiEnabled: true, controlUiBasePath: basePath },
  });
}

function withAssetServer(run: Parameters<typeof withGatewayServer>[0]["run"]) {
  return withGatewayServer({
    prefix: "native-ui-http-",
    resolvedAuth: AUTH_TOKEN,
    overrides: { controlUiEnabled: true, controlUiBasePath: "" },
    run,
  });
}

function withConfig(run: () => Promise<void>, cfg: unknown = {}) {
  return withTempConfig({ cfg, run });
}

function customPlugins(enabled: boolean) {
  return { gateway: { controlUi: { experimental: { customPlugins: enabled } } } };
}

function activation(revision: string, status: "activated" | "failed" = "activated") {
  return { pluginId: "native-ui", revision, status };
}

function responseHeader(response: ReturnType<typeof createResponse>, name: string) {
  return response.setHeader.mock.calls.findLast(([header]) => header.toLowerCase() === name)?.[1];
}

function activateFixture(origin: PluginRecord["origin"] = "bundled") {
  const rootDir = tempDirs.make("native-ui-");
  const directory = path.join(rootDir, "dist/control-ui");
  fs.mkdirSync(directory, { recursive: true });
  const write = (name: string, source: string) =>
    fs.writeFileSync(path.join(directory, name), source);
  const link = (source: string, target: string) =>
    fs.linkSync(path.join(rootDir, source), path.join(rootDir, target));
  const unlink = (name: string) => fs.unlinkSync(path.join(directory, name));
  write("index.js", firstSource);
  write("theme.css", "body { color: red; }");
  const registry = createEmptyPluginRegistry();
  const record = createPluginRecord({
    id: "native-ui",
    origin,
    rootDir,
    controlUi: { entry: "dist/control-ui/index.js", styles: ["dist/control-ui/theme.css"] },
    uiCapabilities: ["page", "widget"],
  });
  const manifest = (uiCapabilities: PluginRecord["uiCapabilities"], initial = false) =>
    fs.writeFileSync(
      path.join(rootDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: record.id,
        configSchema: { type: "object", ...(initial ? { additionalProperties: false } : {}) },
        controlUi: record.controlUi,
        uiCapabilities,
      }),
    );
  manifest(record.uiCapabilities, true);
  registry.plugins.push(record);
  registry.controlUiDescriptors.push({
    pluginId: record.id,
    source: record.source,
    descriptor: { id: "summary", surface: "widget", label: "Native summary" },
  });
  setActivePluginRegistry(registry);
  return { rootDir, directory, registry, record, write, link, unlink, manifest };
}

function cookieForGrant(
  overrides: { pluginId?: string; generation?: string; profileId?: string } = {},
): string {
  const response = createResponse();
  const [grant] = listControlUiPluginTabAuthGrants(["operator.read"]);
  if (!grant) {
    throw new Error("Expected scoped Control UI grant");
  }
  setControlUiPluginAuthCookie(
    response.res,
    [{ ...grant, pluginId: overrides.pluginId ?? grant.pluginId }],
    {
      profileId: overrides.profileId,
      generation:
        overrides.generation ??
        resolveControlUiPluginAuthCookieGeneration(
          resolveSharedGatewaySessionGeneration(AUTH_TOKEN),
          getRuntimeConfig(),
        ),
    },
  );
  const value = response.setHeader.mock.calls.find(([name]) => name === "Set-Cookie")?.[1];
  const header = Array.isArray(value) ? value[0] : value;
  const [cookie] = typeof header === "string" ? header.split(";", 1) : [];
  if (!cookie) {
    throw new Error("Expected scoped Control UI cookie");
  }
  return cookie;
}

afterEach(() => {
  resetPluginRuntimeStateForTest();
  tempDirs.cleanup();
});

beforeAll(async () => {
  // Compile the real Control UI owner during setup, before the HTTP request deadline starts.
  await import("./control-ui.js");
});

it("omits settings-only presentations from activation while keeping ordinary plugins", async () => {
  const fixture = activateFixture();
  expect((await listControlUiPluginCatalog()).plugins.map((plugin) => plugin.pluginId)).toEqual([
    "native-ui",
  ]);
  fixture.record.controlUi = {
    ...fixture.record.controlUi!,
    activation: "settings-only",
    settingsViews: [{ section: "memory", panel: "overview" }],
  };
  expect((await listControlUiPluginCatalog()).plugins).toEqual([]);
  expect(listControlUiPluginActivations({})).toEqual([]);
});

it("hot-applies Custom plugin UI admission without replacing the backend plugin", async () => {
  await withConfig(async () => {
    const fixture = activateFixture("workspace");
    fixture.record.trustedOfficialInstall = true;
    const catalog = await listControlUiPluginCatalog();
    expect(catalog.plugins).toEqual([]);
    expect(catalog.diagnostics).toEqual([
      {
        pluginId: fixture.record.id,
        code: "custom-plugin-ui-disabled",
        message: expect.stringContaining("Settings > Labs"),
      },
    ]);
    expect(listControlUiPluginTabAuthGrants(["operator.read"])).toEqual([]);

    setRuntimeConfigSnapshot(customPlugins(true));
    const entry = (await listControlUiPluginCatalog()).plugins[0]!;
    const matchingPlugin = expect.objectContaining({ pluginId: entry.pluginId });
    expect(listControlUiPluginWidgetKinds(["operator.read"])).toContainEqual(matchingPlugin);
    const browser = {};
    const report = activation(entry.revision);
    expect(reportControlUiPluginActivation(browser, report)).toBe(true);
    const cookie = cookieForGrant();
    const server = assetServer();
    await expectStatus(fetchAsset(server, entry.entryUrl, { headers: { cookie } }), 200);

    setRuntimeConfigSnapshot(customPlugins(false));

    expect(listControlUiPluginTabAuthGrants(["operator.read"])).toEqual([]);
    expect(listControlUiPluginWidgetKinds(["operator.read"])).not.toContainEqual(matchingPlugin);
    expect(reportControlUiPluginActivation(browser, report)).toBe(false);
    expect(listControlUiPluginActivations(browser)).toEqual([]);
    const credentials: Record<string, string>[] = [
      { cookie },
      { authorization: "Bearer test-token" },
    ];
    for (const headers of credentials) {
      for (const asset of [entry.entryUrl, ...entry.styles]) {
        await expectStatus(fetchAsset(server, asset, { headers }), 404);
      }
    }
    expect((await listControlUiPluginCatalog()).plugins).toEqual([]);

    setRuntimeConfigSnapshot(customPlugins(true));
    expect((await listControlUiPluginCatalog()).plugins).toEqual([entry]);
    expect(listControlUiPluginTabAuthGrants(["operator.read"])).toContainEqual(matchingPlugin);
    expect(listControlUiPluginWidgetKinds(["operator.read"])).toContainEqual(matchingPlugin);
    expect(listControlUiPluginActivations(browser)).toEqual([]);
    expect(reportControlUiPluginActivation(browser, report)).toBe(true);
    expect(listControlUiPluginActivations(browser)).toEqual([report]);
    for (const asset of [entry.entryUrl, ...entry.styles]) {
      await expectStatus(fetchAsset(server, asset, { headers: { cookie } }), 200);
    }
  });
});

it.each([
  { auth: AUTH_NONE, basePath: "" },
  { auth: AUTH_TOKEN, basePath: "/openclaw" },
])(
  "reports and enforces native asset authentication for $auth.mode Gateways at '$basePath'",
  async ({ auth, basePath }) => {
    const requiresAuth = auth.mode !== "none";
    await withConfig(
      async () => {
        activateFixture();
        const entry = (await listControlUiPluginCatalog()).plugins[0]!;
        const assetPath = `${basePath}/__openclaw__/plugins/control-ui/native-ui/`;
        expect(entry.entryUrl).toBe(`${assetPath}${entry.revision}/index.js`);
        expect(entry.styles).toEqual([`${assetPath}${entry.revision}/theme.css`]);
        const server = assetServer(basePath, auth);
        const bootstrap = await fetchAsset(
          server,
          `${basePath}/control-ui-config.json`,
          requiresAuth ? { authorization: "Bearer test-token" } : {},
        );
        expect(bootstrap.res.statusCode).toBe(200);
        expect(JSON.parse(bootstrap.getBody())).toMatchObject({
          pluginControlUiModules: [entry],
          basePath,
          pluginAssetsRequireAuth: requiresAuth,
          pluginFrameGrants: requiresAuth
            ? [{ pluginId: "native-ui", path: assetPath, match: "prefix" }]
            : [],
        });
        const cookieHeaders = cookies(bootstrap);
        expect(cookieHeaders).toHaveLength(requiresAuth ? 1 : 0);
        for (const header of cookieHeaders) {
          expect(header).toContain(`Path=${assetPath};`);
          expect(header).toContain("HttpOnly;");
          expect(header).toContain("SameSite=Strict;");
          expect(header).not.toContain("; Secure;");
        }
        const cookie = cookieHeaders.map((value) => String(value).split(";")[0]).join("; ");
        for (const { assetUrl, source } of [
          { assetUrl: entry.entryUrl, source: firstSource },
          { assetUrl: entry.styles[0]!, source: "body { color: red; }" },
        ]) {
          await expectStatus(fetchAsset(server, assetUrl), requiresAuth ? 401 : 200);
          const asset = await fetchAsset(server, assetUrl, { headers: { cookie } });
          expect(responseHeader(asset, "cache-control")).toBe(immutableCache);
          expect(String(responseHeader(asset, "vary")).toLowerCase().split(/,\s*/)).not.toContain(
            "cookie",
          );
          expectBody(asset, source);
          if (basePath) {
            await expectStatus(
              fetchAsset(server, assetUrl.slice(basePath.length), { headers: { cookie } }),
              404,
            );
          }
        }
      },
      { gateway: { controlUi: { basePath } } },
    );
  },
);

it("limits native asset HTTP cookies to direct loopback origins", async () => {
  await withTempConfig({
    cfg: {
      gateway: {
        controlUi: { basePath: "/openclaw" },
        trustedProxies: ["127.0.0.1", "::1"],
      },
    },
    run: async () => {
      activateFixture();
      const server = assetServer("/openclaw");
      const cases = [
        { host: "127.0.0.1:18789", remoteAddress: "127.0.0.1", secure: false },
        { host: "[::1]:18789", remoteAddress: "::1", secure: false },
        { host: "localhost:18789", remoteAddress: "127.0.0.1", tls: true, secure: true },
        { host: "localhost:18789", remoteAddress: "192.0.2.1", secure: true },
        { host: "gateway.example:18789", remoteAddress: "127.0.0.1", secure: true },
        {
          host: "localhost:18789",
          remoteAddress: "127.0.0.1",
          headers: {
            "x-forwarded-for": "192.0.2.2",
            "x-forwarded-proto": "https",
            "x-forwarded-host": "gateway.example",
          },
          secure: true,
        },
      ];
      for (const scenario of cases) {
        const request = createRequest({
          path: "/openclaw/control-ui-config.json",
          authorization: "Bearer test-token",
          ...scenario,
        });
        const tlsSocket =
          "tls" in scenario && scenario.tls ? new TLSSocket(request.socket) : undefined;
        if (tlsSocket) {
          Object.defineProperty(tlsSocket, "remoteAddress", { value: scenario.remoteAddress });
          request.socket = tlsSocket;
        }
        try {
          const response = createResponse();
          await dispatchRequest(server, request, response.res);
          expect(response.res.statusCode, JSON.stringify(scenario)).toBe(200);
          const issued = cookies(response);
          expect(issued).toHaveLength(1);
          expect(issued[0]).toContain("Path=/openclaw/__openclaw__/plugins/control-ui/native-ui/;");
          expect(issued[0]).toContain("SameSite=Strict;");
          expect(String(issued[0]).includes("; Secure;"), JSON.stringify(scenario)).toBe(
            scenario.secure,
          );
        } finally {
          tlsSocket?.destroy();
          request.destroy();
        }
      }
    },
  });
});

it("keeps native asset cookies Secure for each independently present forwarded header", async () => {
  await withTempConfig({
    cfg: { gateway: { controlUi: { basePath: "/openclaw" } } },
    run: async () => {
      activateFixture();
      // Exercise the post-authentication issuer, not an earlier proxy-attribution
      // denial. Each header must prevent the HTTP exception on its own.
      for (const header of [
        "forwarded",
        "x-real-ip",
        "x-forwarded-for",
        "x-forwarded-proto",
        "x-forwarded-host",
        "x-forwarded-prefix",
      ]) {
        for (const headerValue of ["present", ""]) {
          const request = createRequest({
            path: "/openclaw/control-ui-config.json",
            host: "localhost:18789",
            remoteAddress: "127.0.0.1",
            headers: { [header]: headerValue },
          });
          try {
            const response = createResponse();
            setControlUiPluginAuthCookieForRequest(
              request,
              response.res,
              resolveSharedGatewaySessionGeneration(AUTH_TOKEN),
              getRuntimeConfig(),
              ["operator.read"],
            );
            expect(cookies(response), `${header}=${headerValue}`).toEqual([
              expect.stringContaining("; Secure; SameSite=Strict;"),
            ]);
          } finally {
            request.destroy();
          }
        }
      }
    },
  });
});

it("keeps iframe grants Secure when native HTTP grants are allowed", () => {
  const basePath = "/openclaw";
  const response = createResponse();
  const nativePath = `${basePath}/__openclaw__/plugins/control-ui/native-ui/`;
  const framePath = `${basePath}/plugin-frame/`;
  const request = createRequest({
    path: `${basePath}/control-ui-config.json`,
    host: "localhost:18789",
    remoteAddress: "127.0.0.1",
  });
  try {
    setControlUiPluginAuthCookie(
      response.res,
      [
        { pluginId: "native-ui", path: nativePath, match: "prefix", scopes: ["operator.read"] },
        { pluginId: "native-ui", path: framePath, match: "prefix", scopes: ["operator.read"] },
      ],
      {
        generation: resolveSharedGatewaySessionGeneration(AUTH_TOKEN),
        basePath,
        request,
      },
    );
    expect(cookies(response)).toEqual([
      expect.stringContaining(`Path=${nativePath}; HttpOnly; SameSite=Strict;`),
      expect.stringContaining(`Path=${framePath}; HttpOnly; Secure; SameSite=None;`),
    ]);
  } finally {
    request.destroy();
  }
});

it("advertises only admitted static dependencies, including re-exports and cycles", async () => {
  const fixture = activateFixture();
  fs.mkdirSync(path.join(fixture.directory, "chunks"));
  for (const [name, source] of Object.entries({
    "index.js": `
      import './chunks/first.js';
      export { value } from './chunks/second.mjs';
      import('./lazy.js');
      import './missing.js';
      import '../outside.js';
      import 'bare-package';
      import 'https://example.test/remote.js';
      import './theme.css' with { type: 'css' };
      const text = "import './decoy.js'";
    `,
    "chunks/first.js": "export * from './second.mjs'; import '../index.js';",
    "chunks/second.mjs": "export { value } from '../shared.js';",
    "shared.js": "export const value = 1;",
    "lazy.js": "import './decoy.js';",
    "decoy.js": "export const decoy = true;",
  })) {
    fixture.write(name, source);
  }
  const catalog = await listControlUiPluginCatalog();
  expect(catalog.diagnostics).toEqual([]);
  const entry = catalog.plugins[0]!;
  const prefix = entry.entryUrl.slice(0, -"index.js".length);
  expect(entry.imports).toEqual([
    `${prefix}chunks/first.js`,
    `${prefix}chunks/second.mjs`,
    `${prefix}shared.js`,
  ]);
});

it("preserves browser build admission when a module cannot be parsed for preload hints", async () => {
  const fixture = activateFixture();
  fixture.write("index.js", "export const = ;");
  const catalog = await listControlUiPluginCatalog();
  expect(catalog.diagnostics).toEqual([]);
  expect(catalog.plugins[0]?.imports).toEqual([]);
});

it("serves hardlinked bundled assets, reloads a hardlinked manifest, and preserves working revisions", async () => {
  const fixture = activateFixture();
  fixture.link("dist/control-ui/index.js", "linked-entry.js");
  const firstChunk = "export const value = 'first';";
  fixture.write("lazy.js", firstChunk);
  const first = await listControlUiPluginCatalog();
  expect(first.diagnostics).toEqual([]);
  const entry = first.plugins[0]!;
  expect(entry.uiCapabilities).toEqual(["page", "widget"]);
  const browser = {};
  expect(reportControlUiPluginActivation(browser, activation(entry.revision))).toBe(true);
  await withAssetServer(async (server) => {
    const cookie = cookieForGrant();
    const read = (url: string, method = "GET") =>
      fetchAsset(server, url, { method, headers: { cookie } });
    const original = await read(entry.entryUrl);
    expectBody(original, firstSource);
    expect(original.setHeader).toHaveBeenCalledWith(
      "Content-Type",
      "text/javascript; charset=utf-8",
    );
    await expectStatus(read(entry.styles[0]!), 200);
    const head = await read(entry.entryUrl, "HEAD");
    expect(head.res.statusCode).toBe(200);
    expect(head.getBody()).toBe("");
    expect(responseHeader(head, "cache-control")).toBe(immutableCache);
    const unsupported = await read(entry.entryUrl, "POST");
    expect(unsupported.res.statusCode).toBe(405);
    expect(unsupported.setHeader).toHaveBeenCalledWith("Cache-Control", "no-store");

    const nextSource = 'export default { id: "native-ui", version: 2 };';
    fixture.write("index.js", nextSource);
    expect(await listControlUiPluginCatalog()).toEqual(first);
    expectBody(await read(entry.entryUrl), firstSource);
    fixture.link("openclaw.plugin.json", "linked-manifest.json");
    const next = await reloadControlUiPluginCatalog("native-ui");
    expect(next.plugins[0]!.revision).not.toBe(entry.revision);
    expectBody(await read(next.plugins[0]!.entryUrl), nextSource);
    expectBody(await read(entry.entryUrl), firstSource);

    expect(
      reportControlUiPluginActivation(browser, activation(next.plugins[0]!.revision, "failed")),
    ).toBe(true);
    fixture.write("lazy.js", "export const value = 'third';");
    const third = await reloadControlUiPluginCatalog("native-ui");
    expect(third.diagnostics).toEqual([]);
    expect(third.plugins[0]!.revision).not.toBe(next.plugins[0]!.revision);
    expect(
      reportControlUiPluginActivation(browser, activation(third.plugins[0]!.revision, "failed")),
    ).toBe(true);
    // Failed activations still use the first renderer, including its later imports.
    const retainedChunk = await read(entry.entryUrl.replace(/index\.js$/u, "lazy.js"));
    expect(responseHeader(retainedChunk, "cache-control")).toBe(immutableCache);
    expectBody(retainedChunk, firstChunk);
    expectBody(await read(entry.entryUrl), firstSource);

    fixture.unlink("index.js");
    const failed = await reloadControlUiPluginCatalog("native-ui");
    expectCatalogFailure(failed, third.plugins);
    await expectStatus(read(next.plugins[0]!.entryUrl), 200);
    fixture.record.enabled = false;
    await expectStatus(read(next.plugins[0]!.entryUrl), 404);
  });
});

it("serves profile-bound cookie assets with a replaced profile catalog", async () => {
  await withOpenClawTestState({ prefix: "native-ui-profile-cookie-" }, async () => {
    activateFixture();
    const entry = (await listControlUiPluginCatalog()).plugins[0]!;
    const profile = ensureProfileForEmail("reader@example.test");
    const previous = await userProfileCatalog.prepareUserProfileCatalog();
    try {
      const databasePath = resolveOpenClawStateSqlitePath();
      await closeOpenClawStateDatabaseByPathAsync(databasePath);
      fs.renameSync(databasePath, `${databasePath}.previous`);
      fs.copyFileSync(`${databasePath}.previous`, databasePath);
      await withAssetServer(async (server) => {
        const response = await fetchAsset(server, entry.entryUrl, {
          headers: { cookie: cookieForGrant({ profileId: profile.id }) },
        });
        expectBody(response, firstSource);
      });
    } finally {
      previous.release();
    }
  });
});

it.each(["auth rotation", "response closure"] as const)(
  "refuses asset disclosure after %s during profile preparation",
  async (invalidation) => {
    await withOpenClawTestState({ prefix: "native-ui-profile-authority-" }, async () => {
      await withConfig(async () => {
        activateFixture();
        const entry = (await listControlUiPluginCatalog()).plugins[0]!;
        const profile = ensureProfileForEmail("reader@example.test");
        const prepared = createDeferred();
        const resume = createDeferred();
        const prepare = userProfileCatalog.prepareUserProfileCatalog;
        const preparation = vi
          .spyOn(userProfileCatalog, "prepareUserProfileCatalog")
          .mockImplementationOnce(async () => {
            const catalog = await prepare();
            prepared.resolve();
            await resume.promise;
            return catalog;
          });
        let currentAuth = AUTH_TOKEN;
        const request = createRequest({
          path: entry.entryUrl,
          headers: { cookie: cookieForGrant({ profileId: profile.id }) },
        });
        const response = makeMockHttpResponse();
        const operation = handleControlUiPluginAssetRequest(request, response.res, {
          auth: currentAuth,
          getResolvedAuth: () => currentAuth,
          basePath: "",
        });
        try {
          await awaitGateBeforeSettlement(
            prepared.promise,
            operation,
            "asset request completed before profile preparation",
          );
          if (invalidation === "auth rotation") {
            currentAuth = { ...AUTH_TOKEN, token: "rotated-token" };
          } else {
            response.res.destroy();
          }
          resume.resolve();
          expect(await operation).toBe(true);
          if (invalidation === "auth rotation") {
            expect(response.res.statusCode).toBe(401);
          } else {
            expect(response.end).not.toHaveBeenCalled();
          }
        } finally {
          resume.resolve();
          try {
            await operation;
          } finally {
            preparation.mockRestore();
            response.res.destroy();
            request.destroy();
          }
        }
      });
    });
  },
);

it("retains advertised revisions and receipts only for the exact backend owner", async () => {
  const fixture = activateFixture();
  const firstChunk = "export const value = 'first';";
  fixture.write("lazy.js", firstChunk);
  const first = (await listControlUiPluginCatalog()).plugins[0]!;
  fixture.write("index.js", "export default { version: 2 };");
  fixture.write("lazy.js", "export const value = 'second';");
  const second = await reloadControlUiPluginCatalog("native-ui");
  const browser = {};
  const report = activation(second.plugins[0]!.revision);
  expect(reportControlUiPluginActivation(browser, report)).toBe(true);
  const retained = createEmptyPluginRegistry();
  retained.plugins.push(fixture.record, createPluginRecord({ id: "unrelated" }));
  retained.controlUiDescriptors.push(...fixture.registry.controlUiDescriptors);
  setActivePluginRegistry(retained);

  await withAssetServer(async (server) => {
    const cookie = cookieForGrant();
    const oldChunk = first.entryUrl.replace(/index\.js$/u, "lazy.js");
    const read = () => fetchAsset(server, oldChunk, { headers: { cookie } });
    const response = await read();
    expectBody(response, firstChunk);
    const unactivated = createEmptyPluginRegistry();
    unactivated.plugins.push(fixture.record);
    for (const registry of [unactivated, fixture.registry]) {
      await withPluginRuntimeRegistryScope(registry, async () => {
        await expectStatus(read(), 404);
        expect(reportControlUiPluginActivation(browser, report)).toBe(false);
        expect(listControlUiPluginActivations(browser)).toEqual([]);
      });
    }
    fixture.unlink("index.js");
    expect(await listControlUiPluginCatalog()).toEqual(second);
    expect(listControlUiPluginActivations(browser)).toEqual([report]);
    expect(reportControlUiPluginActivation(browser, report)).toBe(true);

    const replacement = createEmptyPluginRegistry();
    replacement.plugins.push(createPluginRecord({ ...fixture.record }));
    replacement.controlUiDescriptors.push(...fixture.registry.controlUiDescriptors);
    setActivePluginRegistry(replacement);
    await expectStatus(read(), 404);
    expect(listControlUiPluginActivations(browser)).toEqual([]);
    expect(reportControlUiPluginActivation(browser, report)).toBe(false);
    const replacementCatalog = await listControlUiPluginCatalog();
    expectCatalogFailure(replacementCatalog, []);
    await expectStatus(read(), 404);
  });
});

it("runs queued reloads after an earlier reload rejects", async () => {
  const fixture = activateFixture();
  const first = await listControlUiPluginCatalog();
  fixture.write("index.js", 'export default { id: "native-ui", version: 2 };');

  const rejected = reloadControlUiPluginCatalog("missing-plugin");
  const reloading = reloadControlUiPluginCatalog("native-ui");
  const reading = listControlUiPluginCatalog();
  const [second, listed] = await Promise.all([
    reloading,
    reading,
    expect(rejected).rejects.toThrow("No active Control UI entrypoint for this plugin"),
  ]);

  expect(second.diagnostics).toEqual([]);
  expect(second.plugins[0]!.revision).not.toBe(first.plugins[0]!.revision);
  expect(listed).toEqual(second);
  expect(await listControlUiPluginCatalog()).toEqual(second);
});

it("refuses reloads past 64 MiB without evicting advertised assets", async () => {
  const maxChanges = 16;
  const sourceBytes = 4 * 1024 * 1024;
  const fixture = activateFixture();
  const first = await listControlUiPluginCatalog();
  const entry = first.plugins[0]!;
  let current = first;
  let refused = false;
  for (let version = 1; version <= maxChanges; version++) {
    if (version === Math.floor(maxChanges / 2)) {
      const retained = createEmptyPluginRegistry();
      retained.plugins.push(fixture.record, createPluginRecord({ id: "unrelated" }));
      retained.controlUiDescriptors.push(...fixture.registry.controlUiDescriptors);
      setActivePluginRegistry(retained);
    }
    const source = `export default { version: ${version} };`.padEnd(sourceBytes);
    fixture.write("index.js", source);
    const next = await reloadControlUiPluginCatalog("native-ui");
    if (next.diagnostics.length) {
      expectCatalogFailure(next, current.plugins, "Reload this plugin's backend");
      refused = true;
      break;
    }
    current = next;
  }
  expect(refused).toBe(true);
  await withAssetServer(async (server) => {
    const original = await fetchAsset(server, entry.entryUrl, {
      headers: { cookie: cookieForGrant() },
    });
    expectBody(original, firstSource);
  });
  // Selecting an already advertised build needs no additional cache capacity.
  fixture.write("index.js", firstSource);
  expect((await reloadControlUiPluginCatalog("native-ui")).plugins).toEqual(first.plugins);
});

it("requires owner-bound read grants and never serves source files, maps, or escaped paths", async () => {
  const fixture = activateFixture();
  fixture.write("source.ts", "private source");
  fixture.write("index.js.map", "private sourcemap");
  fixture.write(".secret.js", "private hidden file");
  const entry = (await listControlUiPluginCatalog()).plugins[0]!;
  const prefix = entry.entryUrl.slice(0, -"index.js".length);
  expect(listControlUiPluginTabAuthGrants(["operator.approvals"])).toEqual([]);
  expect(authorizeOperatorScopesForMethod("plugins.controlUi.list", ["operator.read"])).toEqual({
    allowed: true,
  });
  expect(authorizeOperatorScopesForMethod("plugins.controlUi.reload", ["operator.write"])).toEqual({
    allowed: false,
    missingScope: "operator.admin",
  });
  await withAssetServer(async (server) => {
    const cookie = cookieForGrant();
    const unauthorizedHeaders: Record<string, string>[] = [
      {},
      { cookie: cookieForGrant({ pluginId: "another-owner" }) },
      { cookie: cookieForGrant({ generation: "stale-generation" }) },
    ];
    const read = (url: string) => fetchAsset(server, url, { headers: { cookie } });
    for (const headers of unauthorizedHeaders) {
      const denied = await fetchAsset(server, entry.entryUrl, { headers });
      expect(denied.res.statusCode).toBe(401);
      expect(responseHeader(denied, "cache-control")).toBe("no-store");
    }
    await expectStatus(
      fetchAsset(server, entry.entryUrl, { authorization: "Bearer test-token" }),
      200,
    );
    for (const invalidRevision of ["latest", "", "0".repeat(64)]) {
      const missing = await read(entry.entryUrl.replace(entry.revision, invalidRevision));
      expect(missing.res.statusCode).toBe(404);
      expect(responseHeader(missing, "cache-control")).toBe("no-store");
    }
    for (const suffix of [
      "source.ts",
      "index.js.map",
      ".secret.js",
      "%2e%2e%2fserver.js",
      "%252e%252e/server.js",
      "missing.js",
    ]) {
      const missing = await read(prefix + suffix);
      expect(missing.res.statusCode, suffix).toBe(404);
      expect(responseHeader(missing, "cache-control"), suffix).toBe("no-store");
    }
  });
});

it.each(["symlink", "hardlink"] as const)(
  "rejects %s browser files outside the allowed owner",
  async (kind) => {
    await withConfig(async () => {
      const fixture = activateFixture(kind === "symlink" ? "bundled" : "workspace");
      if (kind === "hardlink") {
        setRuntimeConfigSnapshot(customPlugins(true));
      }
      const privatePath = path.join(fixture.rootDir, "private.js");
      fs.writeFileSync(privatePath, "private source");
      const entry = path.join(fixture.directory, "index.js");
      fs.unlinkSync(entry);
      (kind === "symlink" ? fs.symlinkSync : fs.linkSync)(privatePath, entry);
      const catalog = await listControlUiPluginCatalog();
      expect(catalog.plugins).toEqual([]);
      expect(catalog.diagnostics).toEqual([{ pluginId: "native-ui", message: expect.any(String) }]);
    });
  },
);

it("rejects a hardlinked workspace manifest on reload and retains the working build", async () => {
  await withConfig(async () => {
    const fixture = activateFixture("workspace");
    const first = await listControlUiPluginCatalog();
    expect(first.plugins).toHaveLength(1);
    fixture.link("openclaw.plugin.json", "linked-manifest.json");
    const reloaded = await reloadControlUiPluginCatalog("native-ui");
    expectCatalogFailure(reloaded, first.plugins);
  }, customPlugins(true));
});

it("refreshes UI declarations and retires receipts when browser bytes stay unchanged", async () => {
  const fixture = activateFixture();
  const first = await listControlUiPluginCatalog();
  const browser = {};
  const report = activation(first.plugins[0]!.revision);
  expect(reportControlUiPluginActivation(browser, report)).toBe(true);
  fixture.manifest([]);
  expect(await listControlUiPluginCatalog()).toEqual(first);
  const next = await reloadControlUiPluginCatalog(fixture.record.id);
  expect(next.plugins[0]!.uiCapabilities).toEqual([]);
  expect(next.plugins[0]!.revision).not.toBe(first.plugins[0]!.revision);
  expect(listControlUiPluginActivations(browser)).toEqual([]);
  expect(reportControlUiPluginActivation(browser, report)).toBe(false);
  fixture.manifest(undefined);
  const undeclared = await reloadControlUiPluginCatalog(fixture.record.id);
  expect(undeclared.plugins[0]).not.toHaveProperty("uiCapabilities");
  expect(undeclared.plugins[0]!.revision).not.toBe(next.plugins[0]!.revision);
});
