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
import { createDeferredCore } from "../shared/deferred.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createGatewayMethodRegistry } from "./methods/registry.js";
import { createControlUiHandlers } from "./server-methods/control-ui.js";
import type { GatewayRequestHandlerOptions, RespondFn } from "./server-methods/types.js";
import { createContext } from "./server-plugin-in-process-dispatch.test-support.js";
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

function fixture(method: "preview" | "detail") {
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
    contracts: { gatewayMethodDispatch: ["authenticated-request"] },
    register: expectDefined(github.register, "GitHub registration"),
  });
  setTestPluginRegistry(registry.registry);
  const context = createContext();
  context.getRuntimeConfig = () => cfg;
  const hostMethod = method === "preview" ? "controlUi.githubPreview" : "controlUi.githubDetail";
  const handler = expectDefined(createControlUiHandlers()[hostMethod], "GitHub host reader");
  const readResponse = vi.fn<RespondFn>();
  const methods = createGatewayMethodRegistry(
    [
      ...registry.registry.gatewayMethodDescriptors,
      {
        name: hostMethod,
        owner: { kind: "core", area: "control-ui" },
        scope: "operator.read",
        profileAccess: "independent",
        handler: (options: GatewayRequestHandlerOptions) =>
          handler({
            ...options,
            respond: (...args) => {
              readResponse(...args);
              options.respond(...args);
            },
          }),
      },
    ],
    registry.registry,
  );
  context.getGatewayMethodRegistry = () => methods;
  const client = createOperatorWsClient({ scopes: ["operator.read"] });
  client.authenticatedUserProfile = {
    profileId: ensureProfileForEmail("github-reader@example.test").id,
    displayName: "GitHub reader",
    avatarRevision: "1",
    hasAvatar: false,
    updatedAt: 1,
  };
  const harness = createDispatchTestHarness({ buildRequestContext: () => context });
  harness.clients.add(client);
  context.getClientConnIds = (filter) =>
    new Set(
      [...harness.clients]
        .filter((current) => !current.invalidated && (!filter || filter(current)))
        .map((current) => current.connId),
    );
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const fetchMock = vi.fn<typeof fetch>(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.includes("/issues/")) {
      entered.resolve();
      await release.promise;
    }
    return new Response(
      JSON.stringify(
        url.includes("/issues/")
          ? {
              title: "Preview without reloading",
              body: "Public issue content",
              state: "open",
              comments: 0,
              repository_url: `https://api.github.com/repos/octocat/${method}`,
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
        method: `github.${method}`,
        params: {
          agentId: "main",
          url: `https://github.com/octocat/${method}/issues/1`,
          refresh: true,
        },
      },
      client,
    );
  return { client, harness, readResponse, fetchMock, entered, release, dispatch };
}

describe.each(["preview", "detail"] as const)("registered GitHub %s reader", (method) => {
  it("loads public content through an identified operator's nested request", async () => {
    const f = fixture(method);
    f.release.resolve();
    await f.dispatch();
    const response = await f.harness.awaitResponseFrame("github-read");
    expect(response.error).toBeUndefined();
    expect(response).toMatchObject({
      ok: true,
      payload: { title: "Preview without reloading" },
    });
    expect(f.fetchMock).toHaveBeenCalled();
  });

  it("does not deliver content when the original operator is revoked during the read", async () => {
    const f = fixture(method);
    const pending = f.dispatch();
    try {
      await Promise.race([
        f.entered.promise,
        pending.then(() => {
          throw new Error("GitHub read finished before reaching the upstream request");
        }),
      ]);
      f.client.invalidated = true;
      f.client.invalidatedReason = "device-token-revoked";
    } finally {
      f.release.resolve();
      await pending;
    }
    expect(f.readResponse).toHaveBeenCalledExactlyOnceWith(false, undefined, {
      code: "UNAVAILABLE",
      message: "GitHub request is no longer active. Try again.",
      retryable: true,
    });
    expect(f.harness.send).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: "github-read", ok: true }),
    );
    expect(f.harness.close).toHaveBeenCalledWith(4001, "client invalidated: device-token-revoked");
  });
});
