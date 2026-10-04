import { afterEach, describe, expect, it, onTestFailed, onTestFinished, vi } from "vitest";
import { createFixtureLifetime } from "../../test/helpers/fixture-lifetime.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { getRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  getActiveRemoteModelCatalog,
  getRemoteModelCatalogProviderOverlay,
} from "../model-catalog/remote-overlay.js";
import { setRemoteModelCatalogOverlaySourcesForTest } from "../model-catalog/remote-overlay.test-support.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { getFreePort } from "../test-utils/ports.js";
import { startGatewayServerCore } from "./server-start.js";
import * as bootstrap from "./server-startup-bootstrap.js";
import { startGatewayServer } from "./server.js";

describe("Gateway startup catalog", () => {
  it.each([false, true])("captures metadata before bootstrap awaits, absent=%s", async (absent) => {
    const bundle = {
      schemaVersion: 1,
      generatedAt: 200,
      sourceCommit: "fixture",
      providers: { anthropic: { models: [{ id: "startup-model" }] } },
      pricing: { "anthropic/startup-model": { input: 1, output: 2 } },
    };
    const stored = {
      id: 1,
      bundle_json: JSON.stringify(bundle),
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
    const pending = createDeferred();
    const stopped = new Error("fixture stops bootstrap");
    const prepare = vi
      .spyOn(bootstrap, "prepareGatewayServerBootstrap")
      .mockImplementationOnce(async () => {
        await pending.promise;
        throw stopped;
      });
    const startup = startGatewayServerCore(0).catch((error: unknown) => error);
    try {
      read.mockReturnValue({
        ...stored,
        bundle_json: JSON.stringify({
          ...bundle,
          providers: { anthropic: { models: [{ id: "downloaded-model" }] } },
          pricing: { "anthropic/startup-model": { input: 3, output: 4 } },
        }),
      });
      expect(getRemoteModelCatalogProviderOverlay({}, "anthropic")).toEqual(
        absent ? undefined : bundle.providers.anthropic,
      );
      expect(getActiveRemoteModelCatalog({})?.pricing).toEqual(
        absent
          ? undefined
          : {
              "anthropic/startup-model": { cost: { input: 1, output: 2 }, explicit: false },
            },
      );
    } finally {
      pending.resolve();
      const outcome = await startup;
      prepare.mockRestore();
      setRemoteModelCatalogOverlaySourcesForTest();
      expect(outcome).toBe(stopped);
    }
  });
});

type StartupPhase = { phase: string; elapsedMs: number };

// Issue #156539: this case owns a single deadline over state creation, Gateway startup,
// readiness, close and cleanup, so a CI timeout names none of the phases it covers.
// Record the phase each awaited step enters and repeat the unjoined phase in the receipt,
// so a recurrence localizes itself instead of reporting an anonymous deadline.
function createStartupPhaseTrace(intervalMs = 15_000) {
  const startedAt = performance.now();
  const phases: StartupPhase[] = [];
  let pending: { phase: string; since: number } | undefined;
  let ticker: ReturnType<typeof setInterval> | undefined;
  const stopTicker = () => {
    if (ticker) {
      clearInterval(ticker);
    }
    ticker = undefined;
  };
  return {
    phase(phase: string) {
      stopTicker();
      const since = performance.now();
      pending = { phase, since };
      phases.push({ phase, elapsedMs: Math.round(since - startedAt) });
      console.warn(
        `[catalog-startup] awaiting phase "${phase}" at +${Math.round(since - startedAt)}ms`,
      );
      ticker = setInterval(() => {
        console.warn(
          `[catalog-startup] still awaiting phase "${phase}" after ${Math.round(performance.now() - since)}ms`,
        );
      }, intervalMs);
      ticker.unref();
    },
    reportPendingPhase() {
      stopTicker();
      console.error("Provider settings startup phases", {
        phases,
        elapsedMs: Math.round(performance.now() - startedAt),
        pendingPhase: pending?.phase ?? null,
        pendingForMs: pending ? Math.round(performance.now() - pending.since) : null,
      });
    },
    stop: stopTicker,
  };
}

describe("Gateway provider settings startup", () => {
  const startupFixture = createFixtureLifetime();

  afterEach(async () => {
    // Join timed-out startup before the outer hooks retire its runtime owners.
    await startupFixture.cleanup();
  });

  it(
    "starts with provider settings without model rows when a channel is auto-enabled",
    () =>
      startupFixture.run(async () => {
        const trace = createStartupPhaseTrace();
        onTestFailed(() => trace.reportPendingPhase());
        onTestFinished(() => trace.stop());
        const token = "provider-overlay-startup-token";
        trace.phase("create-isolated-state");
        const state = await createOpenClawTestState({
          label: "provider-overlay-startup",
          env: {
            OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
            OPENCLAW_SKIP_CHANNELS: "1",
            OPENCLAW_SKIP_GMAIL_WATCHER: "1",
            OPENCLAW_SKIP_CRON: "1",
            OPENCLAW_SKIP_CANVAS_HOST: "1",
            OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
            OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
          },
        });
        let server: Awaited<ReturnType<typeof startGatewayServer>> | undefined;
        try {
          trace.phase("reserve-port");
          const port = await getFreePort();
          trace.phase("write-config");
          await state.writeConfig({
            agents: { entries: { main: {} } },
            models: { providers: { openai: { apiKey: "synthetic-provider-key" }, codex: {} } },
            channels: { telegram: { botToken: "123456:synthetic-test-token" } },
            gateway: { auth: { mode: "token", token } },
          });
          state.applyEnv();
          trace.phase("gateway-startup");
          server = await startGatewayServer(port, {
            bind: "loopback",
            auth: { mode: "token", token },
            controlUiEnabled: false,
          });
          trace.phase("startup-settled");
          await server.startupSettled;
          expect(getRuntimeConfigSnapshot()?.channels?.telegram).toMatchObject({ enabled: true });
          trace.phase("readyz-probe");
          const readiness = await fetch(`http://127.0.0.1:${port}/readyz`);
          expect(readiness.status).toBe(200);
          await expect(readiness.json()).resolves.toMatchObject({ ready: true });
        } finally {
          trace.phase("gateway-close");
          await server?.close({ reason: "provider overlay startup test complete" });
          trace.phase("state-cleanup");
          await state.cleanup();
        }
      }),
    90_000,
  );
});
