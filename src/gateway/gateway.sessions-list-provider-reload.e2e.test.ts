import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createDeferredCore } from "../shared/deferred.js";
import { reserveTestPortListener } from "../test-utils/port-claims.js";
import { createStartupTestState } from "./server-startup.test-support.js";
import * as projectionCatalog from "./session-row-projection-catalog.js";
import type { SessionsListResult } from "./session-utils.types.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
  startGatewayWithClient,
} from "./test-helpers.e2e.js";

it("cancels disconnected lists during provider reload and publishes the successor policy", async ({
  signal,
}) => {
  await using state = await createStartupTestState("session-list-provider-reload", {
    OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
  });
  const observeWait = () => createDeferredCore<{ completion: Promise<unknown> }>();
  let waitingForCatalog = observeWait();
  const createCatalog = projectionCatalog.createSessionRowProjectionCatalog;
  using observeCatalog = vi.spyOn(projectionCatalog, "createSessionRowProjectionCatalog");
  observeCatalog.mockImplementation((params) => {
    const catalog = createCatalog(params);
    // The pre-fix control has no current-catalog preparation method.
    const prepareCurrent = catalog.prepareCurrent?.bind(catalog);
    catalog.prepareCurrent = (abortSignal) => {
      const pending = prepareCurrent(abortSignal);
      waitingForCatalog.resolve({
        completion: pending.then(
          () => undefined,
          (error: unknown) => error,
        ),
      });
      return pending;
    };
    return catalog;
  });
  const stopping = createDeferredCore();
  const release = createDeferredCore();
  const fixture = await reserveTestPortListener({
    offsets: [0],
    signal,
    createListener: () =>
      createServer((_req, res) => {
        stopping.resolve();
        void release.promise.then(() => res.end("released"));
      }),
  });
  let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
  let reader: Awaited<ReturnType<typeof connectGatewayClient>> | undefined;
  let cancelledListing: Promise<SessionsListResult> | undefined;
  let reload: Promise<unknown> | undefined;
  let listing: Promise<SessionsListResult> | undefined;
  await runQaGatewayFixture(
    async () => {
      const pluginDir = state.path("provider");
      await fs.mkdir(pluginDir);
      await fs.writeFile(
        path.join(pluginDir, "package.json"),
        JSON.stringify({
          name: "session-reload-proof",
          version: "1.0.0",
          openclaw: { extensions: ["./index.cjs"] },
        }),
      );
      await fs.writeFile(
        path.join(pluginDir, "openclaw.plugin.json"),
        JSON.stringify({
          id: "session-reload-proof",
          activation: { onStartup: true },
          providers: ["session-reload-proof"],
          configSchema: { type: "object" },
        }),
      );
      const writeProvider = (level: "low" | "high") =>
        fs.writeFile(
          path.join(pluginDir, "index.cjs"),
          `module.exports = { id: "session-reload-proof", register(api) {
      api.registerProvider({ id: "session-reload-proof", label: "Reload proof", auth: [],
        resolveThinkingProfile() {
          return { levels: [{ id: "off" }, { id: "${level}" }], defaultLevel: "${level}" };
        }
      });
      api.registerService({ id: "session-reload-proof", start() {}, async stop() {
        const response = await fetch("http://127.0.0.1:${fixture.claim.port}/stop");
        if (!response.ok) throw new Error("reload fixture failed");
      }});
    }};`,
        );
      await writeProvider("low");
      const modelRef = "session-reload-proof/reasoner";
      const token = "session-reload-proof-token";
      const cfg: OpenClawConfig = {
        agents: {
          ownership: "explicit",
          defaults: {
            workspace: state.workspaceDir,
            skipBootstrap: true,
            model: { primary: modelRef },
          },
          entries: { main: {} },
        },
        models: {
          mode: "replace",
          providers: {
            "session-reload-proof": {
              baseUrl: "http://127.0.0.1:1/v1",
              api: "openai-completions",
              apiKey: "synthetic-proof-key",
              models: [
                {
                  id: "reasoner",
                  name: "Reasoner",
                  reasoning: true,
                  input: ["text"],
                  contextWindow: 32000,
                  maxTokens: 1024,
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                },
              ],
            },
          },
        },
        plugins: {
          allow: ["session-reload-proof"],
          load: { paths: [pluginDir] },
          slots: { memory: "none" },
        },
        gateway: { auth: { mode: "token", token } },
      };
      state.applyEnv();
      gateway = await startGatewayWithClient({
        cfg,
        configPath: state.configPath,
        token,
        scopes: ["operator.admin", "operator.read", "operator.write"],
      });
      await gateway.server.startupSettled;
      reader = await connectGatewayClient({
        url: `ws://127.0.0.1:${gateway.port}`,
        token,
        scopes: ["operator.admin", "operator.read", "operator.write"],
      });
      const key = "agent:main:dashboard:reload-proof";
      await gateway.client.request("sessions.create", { key, label: "Reload proof" });
      const { client } = gateway;
      const list = () =>
        client.request<SessionsListResult>("sessions.list", {
          agentId: "main",
          includeGlobal: true,
          includeUnknown: true,
        });
      const before = await list();
      expect(before.defaults.thinkingDefault).toBe("low");
      expect(before.sessions.some((row) => row.key === key)).toBe(true);
      await writeProvider("high");
      reload = gateway.client.request("plugins.reload", {
        plugins: [{ pluginId: "session-reload-proof" }],
      });
      void reload.catch(() => {});
      await withinTest(
        awaitGateBeforeSettlement(stopping.promise, reload, "reload did not stop the old provider"),
        signal,
      );
      waitingForCatalog = observeWait();
      cancelledListing = reader.request<SessionsListResult>("sessions.list", {
        agentId: "main",
        includeGlobal: true,
        includeUnknown: true,
      });
      void cancelledListing.catch(() => {});
      const cancelledWait = await withinTest(
        awaitGateBeforeSettlement(
          waitingForCatalog.promise,
          cancelledListing,
          "list completed before cancellation",
        ),
        signal,
      );
      waitingForCatalog = observeWait();
      let settled = false;
      listing = list().finally(() => {
        settled = true;
      });
      void listing.catch(() => {});
      await gateway.client.request("health", {});
      expect(settled).toBe(false);
      await disconnectGatewayClient(reader);
      reader = undefined;
      expect(await withinTest(cancelledWait.completion, signal)).toHaveProperty(
        "name",
        "AbortError",
      );
      await withinTest(
        awaitGateBeforeSettlement(
          waitingForCatalog.promise,
          listing,
          "list completed before waiting for the current catalog",
        ),
        signal,
      );
      await gateway.client.request("health", {});
      expect(settled).toBe(false);
      release.resolve();
      await reload;
      const after = await listing;
      expect(after.defaults.thinkingDefault).toBe("high");
      expect(after.sessions.some((row) => row.key === key)).toBe(true);
      expect((await list()).defaults.thinkingDefault).toBe("high");
    },
    async () => {
      release.resolve();
      await Promise.allSettled([reload, listing, cancelledListing]);
    },
    () => reader && disconnectGatewayClient(reader),
    () => gateway && disconnectGatewayClient(gateway.client),
    () => gateway?.server.close({ reason: "session list reload proof complete" }),
    fixture.releaseListener,
    fixture.claim.release,
  );
}, 120_000);
