import { expect, it, vi } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import { acquireTestPortBlock } from "../test-utils/port-claims.js";
import { installGatewayTestHooks, startTestGatewayServer } from "./test-helpers.js";

const webFetchProviderDiscovery = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("gateway startup must not discover web fetch providers before bind");
  }),
);

// This boundary proves that credential-free web fetch config reaches the HTTP
// listener. Model publication and chat metadata have dedicated owners.
vi.mock("../agents/prepared-model-runtime.js", () => ({
  cancelPreparedModelRuntimeRefresh: vi.fn(),
  publishPreparedModelRuntimeSnapshot: vi.fn(async () => ({})),
  refreshPreparedModelRuntimeSnapshots: vi.fn(async () => {}),
}));

// mock-isolation: Prove HTTP bind without starting the unrelated chat metadata runtime or listeners.
vi.mock("./server-chat-metadata-lifecycle.js", () => ({
  createGatewayChatMetadataLifecycle: vi.fn(async () => ({
    attachContext: vi.fn(async () => {}),
    read: vi.fn().mockRejectedValue(new Error("chat metadata is outside this startup test")),
    refresh: vi.fn(async () => {}),
  })),
}));

vi.mock("../secrets/runtime-web-tools-fallback.runtime.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../secrets/runtime-web-tools-fallback.runtime.js")>();
  return {
    ...actual,
    runtimeWebToolsFallbackProviders: {
      ...actual.runtimeWebToolsFallbackProviders,
      resolvePluginWebFetchProviders: webFetchProviderDiscovery,
    },
  };
});

vi.mock("../plugins/web-provider-public-artifacts.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../plugins/web-provider-public-artifacts.js")>();
  return {
    ...actual,
    resolveBundledWebFetchProvidersFromPublicArtifacts: webFetchProviderDiscovery,
  };
});

installGatewayTestHooks({ scope: "suite" });

it("binds HTTP with credential-free tools.web.fetch config without fetch provider discovery", async () => {
  await withEnvAsync({ OPENCLAW_TEST_MINIMAL_GATEWAY: "0" }, async () => {
    const { writeConfigFile } = await import("../config/config.js");
    await writeConfigFile({
      gateway: { mode: "local", bind: "loopback", auth: { mode: "none" } },
      plugins: { enabled: true, allow: [], entries: {} },
      tools: { web: { fetch: { enabled: true, maxChars: 200_000, maxCharsCap: 2_000_000 } } },
    });

    const portClaim = await acquireTestPortBlock({ offsets: [0, 1, 2, 3, 4] });
    const server = await startTestGatewayServer(portClaim, { auth: { mode: "none" } });
    try {
      const response = await fetch(`http://127.0.0.1:${portClaim.port}/healthz`, {
        signal: AbortSignal.timeout(5_000),
      });
      await response.text();
      expect(response.status).toBe(200);
      expect(webFetchProviderDiscovery).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });
});
