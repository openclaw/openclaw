import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { acquireTestPortBlock } from "../test-utils/port-claims.js";
import { installGatewayTestHooks, startTestGatewayServer } from "./test-helpers.js";

const webFetchProviderDiscovery = vi.hoisted(() => ({
  bundled: vi.fn(() => {
    throw new Error("gateway startup must not discover bundled web fetch providers before bind");
  }),
  plugin: vi.fn(() => {
    throw new Error("gateway startup must not discover plugin web fetch providers before bind");
  }),
}));

// This boundary proves that credential-free web fetch config reaches the HTTP
// listener. Model publication, chat metadata, and orphan recovery have dedicated owners.
vi.mock("../agents/prepared-model-runtime.js", () => ({
  cancelPreparedModelRuntimeRefresh: vi.fn(),
  publishPreparedModelRuntimeSnapshot: vi.fn(async () => ({})),
  refreshPreparedModelRuntimeSnapshots: vi.fn(async () => {}),
}));

vi.mock("./server-chat-metadata-lifecycle.js", () => ({
  createGatewayChatMetadataLifecycle: vi.fn(async () => ({
    attachContext: vi.fn(async () => {}),
    read: vi.fn(async () => {
      throw new Error("chat metadata is outside this startup test");
    }),
    refresh: vi.fn(async () => {}),
  })),
}));

vi.mock("../agents/main-session-recovery/main-session-restart-recovery-marking.js", () => ({
  markStartupOrphanedMainSessionsForRecovery: vi.fn(async () => ({ marked: 0, skipped: 0 })),
}));

vi.mock("../secrets/runtime-web-tools-fallback.runtime.js", async () => {
  const actual = await vi.importActual<
    typeof import("../secrets/runtime-web-tools-fallback.runtime.js")
  >("../secrets/runtime-web-tools-fallback.runtime.js");
  return {
    ...actual,
    runtimeWebToolsFallbackProviders: {
      ...actual.runtimeWebToolsFallbackProviders,
      resolvePluginWebFetchProviders: webFetchProviderDiscovery.plugin,
    },
  };
});

vi.mock("../plugins/web-provider-public-artifacts.js", async () => {
  const actual = await vi.importActual<
    typeof import("../plugins/web-provider-public-artifacts.js")
  >("../plugins/web-provider-public-artifacts.js");
  return {
    ...actual,
    resolveBundledWebFetchProvidersFromPublicArtifacts: webFetchProviderDiscovery.bundled,
  };
});

installGatewayTestHooks({ scope: "suite" });

afterEach(() => {
  webFetchProviderDiscovery.bundled.mockClear();
  webFetchProviderDiscovery.plugin.mockClear();
});

describe("gateway startup web fetch config", () => {
  let port: number;
  let previousMinimal: string | undefined;
  let server: Awaited<ReturnType<typeof startTestGatewayServer>> | undefined;

  beforeAll(async () => {
    previousMinimal = process.env.OPENCLAW_TEST_MINIMAL_GATEWAY;
    process.env.OPENCLAW_TEST_MINIMAL_GATEWAY = "0";
    const { writeConfigFile } = await import("../config/config.js");
    await writeConfigFile({
      gateway: { mode: "local", bind: "loopback", auth: { mode: "none" } },
      plugins: { enabled: true, allow: [], entries: {} },
      tools: { web: { fetch: { enabled: true, maxChars: 200_000, maxCharsCap: 2_000_000 } } },
    });

    const portClaim = await acquireTestPortBlock({ offsets: [0, 1, 2, 3, 4] });
    port = portClaim.port;
    server = await startTestGatewayServer(portClaim, { auth: { mode: "none" } });
  });

  afterAll(async () => {
    await server?.close();
    if (previousMinimal === undefined) {
      delete process.env.OPENCLAW_TEST_MINIMAL_GATEWAY;
    } else {
      process.env.OPENCLAW_TEST_MINIMAL_GATEWAY = previousMinimal;
    }
  });

  it("binds HTTP with credential-free tools.web.fetch config without fetch provider discovery", async () => {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
      signal: AbortSignal.timeout(5_000),
    });
    await response.text();
    expect(response.status).toBe(200);
    expect([
      webFetchProviderDiscovery.bundled.mock.calls,
      webFetchProviderDiscovery.plugin.mock.calls,
    ]).toEqual([[], []]);
  });
});
