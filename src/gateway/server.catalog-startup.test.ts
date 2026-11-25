import { afterEach, expect, it, vi } from "vitest";
import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { getRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  getActiveRemoteModelCatalog,
  getRemoteModelCatalogProviderOverlay,
} from "../model-catalog/remote-overlay.js";
import { setRemoteModelCatalogOverlaySourcesForTest } from "../model-catalog/remote-overlay.test-support.js";
import { getFreePort } from "../test-utils/ports.js";
import { gatewayKernelLogs } from "./server-kernel.js";
import { startGatewayServerCore } from "./server-start.js";
import * as bootstrap from "./server-startup-bootstrap.js";
import { createStartupTestState } from "./server-startup.test-support.js";
import { startGatewayServer } from "./server.js";

it.each([false, true])("captures catalog before bootstrap (absent=%s)", async (absent) => {
  const modelRef = "anthropic/startup-model";
  const catalog = (model = "startup-model", input = 1, output = 2) =>
    JSON.stringify({
      schemaVersion: 1,
      generatedAt: 200,
      sourceCommit: "fixture",
      providers: { anthropic: { models: [{ id: model }] } },
      pricing: { [modelRef]: { input, output } },
    });
  const stored = {
    id: 1,
    bundle_json: catalog(),
    generated_at: 200,
    min_version: null,
    source_url: "https://catalog.openclaw.ai/models/v2/catalog.json",
    etag: null,
    last_modified: null,
    checked_at: 200,
  };
  const read = vi.fn(() => (absent ? undefined : stored));
  setRemoteModelCatalogOverlaySourcesForTest({
    bundledGeneratedAt: () => 100,
    readStoredCatalog: read,
  });
  const [pending, enteredBootstrap] = [createDeferred(), createDeferred()];
  const stopped = new Error("fixture stops bootstrap");
  const prepare = vi
    .spyOn(bootstrap, "prepareGatewayServerBootstrap")
    .mockImplementationOnce(async () => {
      enteredBootstrap.resolve();
      await pending.promise;
      throw stopped;
    });
  const startup = startGatewayServerCore(0).catch((error: unknown) => error);
  try {
    await enteredBootstrap.promise;
    read.mockReturnValue({ ...stored, bundle_json: catalog("downloaded-model", 3, 4) });
    expect(getRemoteModelCatalogProviderOverlay({}, "anthropic")).toEqual(
      absent ? undefined : { models: [{ id: "startup-model" }] },
    );
    const pricing = { [modelRef]: { cost: { input: 1, output: 2 }, explicit: false } };
    expect(getActiveRemoteModelCatalog({})?.pricing).toEqual(absent ? undefined : pricing);
  } finally {
    pending.resolve();
    const outcome = await startup;
    prepare.mockRestore();
    setRemoteModelCatalogOverlaySourcesForTest();
    expect(outcome).toBe(stopped);
  }
});

const startupFixture = createFixtureLifetime();

// Join timed-out startup before the outer hooks retire its runtime owners.
afterEach(() => startupFixture.cleanup());

it(
  "starts with provider settings without model rows when a channel is auto-enabled",
  ({ signal }) =>
    startupFixture.run(async () => {
      const token = "provider-overlay-startup-token";
      await using state = await createStartupTestState("provider-overlay-startup", {
        OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
        OPENCLAW_SKIP_PROVIDERS: process.env.OPENCLAW_SKIP_PROVIDERS,
        VITEST: process.env.VITEST,
      });
      let server: Awaited<ReturnType<typeof startGatewayServer>> | undefined;
      try {
        const port = await getFreePort();
        await state.writeConfig({
          agents: { entries: { main: {} } },
          models: { providers: { openai: { apiKey: "synthetic-provider-key" }, codex: {} } },
          channels: { telegram: { botToken: "123456:synthetic-test-token" } },
          gateway: { auth: { mode: "token", token } },
        });
        state.applyEnv();
        const ready = createDeferred();
        const info = gatewayKernelLogs.log.info.bind(gatewayKernelLogs.log);
        using readyLog = vi.spyOn(gatewayKernelLogs.log, "info");
        readyLog.mockImplementation((message, meta) => {
          info(message, meta);
          if (message === "gateway ready") {
            ready.resolve();
          }
        });
        server = await startGatewayServer(port, {
          bind: "loopback",
          auth: { mode: "token", token },
          controlUiEnabled: false,
        });
        await server.startupSettled;
        expect(getRuntimeConfigSnapshot()?.channels?.telegram).toMatchObject({ enabled: true });
        await withinTest(ready.promise, signal);
        const readiness = await fetch(`http://127.0.0.1:${port}/readyz`);
        expect(readiness.status).toBe(200);
        await expect(readiness.json()).resolves.toMatchObject({ ready: true });
      } finally {
        await server?.close({ reason: "provider overlay startup test complete" });
      }
    }),
  90_000,
);
