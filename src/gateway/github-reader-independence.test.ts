import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import type { GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/gateway-runtime";
import {
  createPluginRegistryFixture,
  registerVirtualTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterEach, expect, it, vi } from "vitest";
import { loadPluginManifest } from "../plugins/manifest.js";
import type { OpenClawPluginDefinition } from "../plugins/plugin-definition.types.js";
import {
  loadBundledPluginFacade,
  resolveBundledPluginPublicModulePath,
} from "../test-utils/bundled-plugin-public-surface.js";
import { createContext } from "./server-plugin-in-process-dispatch.test-support.js";

const { default: plugin } = await loadBundledPluginFacade<{ default: OpenClawPluginDefinition }>({
  pluginId: "github",
  artifactBasename: "index.ts",
});
const loadedManifest = loadPluginManifest(
  path.dirname(
    resolveBundledPluginPublicModulePath({ pluginId: "github", artifactBasename: "index.ts" }),
  ),
  false,
);
if (!loadedManifest.ok) {
  throw new Error(loadedManifest.error);
}
const manifest = loadedManifest.manifest;

const config = {
  agents: { entries: { main: {} } },
  plugins: {
    entries: {
      "github-repositories": {
        enabled: false,
        config: { system: { profileId: "ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } },
      },
    },
  },
};
afterEach(() => {
  clearRuntimeConfigSnapshot();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it.each([
  { method: "github.preview", retired: false },
  { method: "github.detail", retired: false },
  { method: "github.detail", retired: true },
])(
  "$method with repository integration disabled and caller retired=$retired",
  async ({ method, retired }) => {
    let current = true;
    setRuntimeConfigSnapshot(config);
    vi.stubEnv("GH_TOKEN", "");
    vi.stubEnv("GITHUB_TOKEN", "");
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input;
      if (url === "https://api.github.com/repos/fixture/independent") {
        if (retired) {
          current = false;
        }
        return Response.json({ id: 123, private: false, visibility: "public" });
      }
      if (url === "https://api.github.com/repos/fixture/independent/issues/1") {
        return Response.json({
          title: "Independent public reader",
          body: "Fixture issue body",
          state: "open",
          user: { login: "fixture" },
          comments: 0,
          created_at: "2026-10-01T00:00:00Z",
          updated_at: "2026-10-01T00:00:00Z",
        });
      }
      throw new Error("Unexpected public GitHub request: " + url);
    });
    vi.stubGlobal("fetch", fetchMock);
    const fixture = createPluginRegistryFixture(config);
    registerVirtualTestPlugin({
      ...fixture,
      id: "github",
      name: "GitHub",
      contracts: manifest.contracts,
      register: expectDefined(plugin.register, "GitHub plugin registration"),
    });
    const handler = fixture.registry.registry.gatewayHandlers[method]!;
    const respond = vi.fn<GatewayRequestHandlerOptions["respond"]>();
    const params = {
      url: "https://github.com/fixture/independent/issues/1",
      refresh: true,
      ...(method === "github.detail" ? { section: "overview" } : {}),
    };
    try {
      await handler({
        params,
        respond,
        req: { id: "1", type: "req", method, params },
        client: null,
        hasCurrentClientAuthority: () => current,
        context: createContext([], () => config),
        isWebchatConnect: () => false,
      });
      if (retired) {
        expect(respond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({ code: "UNAVAILABLE", retryable: false }),
          undefined,
        );
        return;
      }
      expect(respond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          title: "Independent public reader",
          url: params.url,
          ...(method === "github.detail"
            ? { body: "Fixture issue body" }
            : { badge: { label: "Open", tone: "positive", timestamp: undefined } }),
        }),
        undefined,
        undefined,
      );
      expect(fetchMock).toHaveBeenCalled();
    } finally {
      fixture.registry.rollbackPluginGlobalSideEffects(
        "github",
        fixture.registry.registry.plugins[0]!,
      );
    }
  },
);
