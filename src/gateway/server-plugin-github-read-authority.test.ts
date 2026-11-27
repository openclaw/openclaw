import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import {
  createPluginRegistryFixture,
  registerVirtualTestPlugin,
} from "../plugin-sdk/plugin-test-contracts.js";
import type { OpenClawPluginDefinition } from "../plugins/types.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createGatewayMethodRegistry } from "./methods/registry.js";
import { controlUiHandlers } from "./server-methods/control-ui.js";
import { createContext } from "./server-plugin-in-process-dispatch.test-support.js";
import { dispatchProfile } from "./server/client-fixtures.test-support.js";
import {
  createDispatchTestHarness,
  createOperatorWsClient,
} from "./server/ws-connection/authenticated-request-dispatch.test-support.js";
import { resetTestPluginRegistry, setTestPluginRegistry } from "./test-helpers.plugin-registry.js";

const { default: github } = await loadBundledPluginFacade<{
  default: OpenClawPluginDefinition;
}>({ pluginId: "github", artifactBasename: "index.ts" });

let state: Awaited<ReturnType<typeof createOpenClawTestState>> | undefined;
beforeEach(async () => {
  state = await createOpenClawTestState({ scenario: "minimal" });
});
afterEach(async () => {
  resetTestPluginRegistry();
  clearRuntimeConfigSnapshot();
  vi.unstubAllGlobals();
  await state?.cleanup();
});

function fixture() {
  const cfg = {
    agents: { entries: { main: {} } },
    gateway: { controlUi: { github: { token: "synthetic-preview-credential" } } },
  };
  setRuntimeConfigSnapshot(cfg);
  const { registry, config } = createPluginRegistryFixture();
  registerVirtualTestPlugin({
    registry,
    config,
    id: "github",
    name: "GitHub",
    contracts: {
      tools: ["github_read", "github_search"],
      gatewayMethodDispatch: ["authenticated-request"],
    },
    register: expectDefined(github.register, "GitHub registration"),
  });
  setTestPluginRegistry(registry.registry);
  const context = createContext();
  context.getRuntimeConfig = () => cfg;
  const hostMethod = "controlUi.githubPreview";
  const handler = expectDefined(controlUiHandlers[hostMethod], "GitHub host reader");
  const methods = createGatewayMethodRegistry(
    [
      ...registry.registry.gatewayMethodDescriptors,
      {
        name: hostMethod,
        owner: { kind: "core", area: "control-ui" },
        scope: "operator.read",
        profileAccess: "independent",
        handler,
      },
    ],
    registry.registry,
  );
  context.getGatewayMethodRegistry = () => methods;
  const client = createOperatorWsClient({ scopes: ["operator.read"] });
  client.authenticatedUserProfile = dispatchProfile(
    ensureProfileForEmail("github-reader@example.test").id,
    { displayName: "GitHub reader" },
  );
  const harness = createDispatchTestHarness({ buildRequestContext: () => context });
  harness.clients.add(client);
  context.getClientConnIds = (filter) =>
    new Set(
      [...harness.clients]
        .filter((current) => !current.invalidated && (!filter || filter(current)))
        .map((current) => current.connId),
    );
  const fetchMock = vi.fn<typeof fetch>(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    return new Response(
      JSON.stringify(
        url.includes("/issues/")
          ? {
              title: "Preview without reloading",
              body: "Public issue content",
              state: "open",
              comments: 0,
              repository_url: "https://api.github.com/repos/octocat/preview",
              created_at: "2026-09-21T12:00:00Z",
              updated_at: "2026-09-21T12:00:00Z",
              user: { login: "octocat" },
            }
          : { id: 123, private: false, visibility: "public" },
      ),
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  const dispatch = () =>
    harness.dispatcher.dispatch(
      {
        type: "req",
        id: "github-read",
        method: "github.preview",
        params: {
          agentId: "main",
          url: "https://github.com/octocat/preview/issues/1",
          refresh: true,
        },
      },
      client,
    );
  return { harness, dispatch };
}

describe("registered GitHub readers", () => {
  it("loads a preview through an identified operator's nested request", async () => {
    const f = fixture();
    await f.dispatch();
    const response = await f.harness.awaitResponseFrame("github-read");
    expect(response.error).toBeUndefined();
    expect(response).toMatchObject({
      ok: true,
      payload: { title: "Preview without reloading" },
    });
  });
});
