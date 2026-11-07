import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeHttpServer,
  listenLoopback,
} from "../../test/helpers/gateway-integration-fixtures.js";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as pluginPreparation from "../plugins/plugin-generation-worker.js";
import * as pluginSourceReferences from "../plugins/plugin-source-references.js";
import { setTestEnvValue } from "../test-utils/env.js";
import {
  createGatewayConfigPath,
  nextGatewayId,
  removeGatewayTempHome,
  resetGatewayTestState,
  setupGatewayTempHome,
} from "./gateway.test-support.js";
import { startGatewayServer } from "./server.js";
import { acquireGatewayE2ePortBlock, startClaimedGateway } from "./test-helpers.listener.js";

const GATEWAY_E2E_TIMEOUT_MS = 90_000;

async function startLoopbackTokenGateway(token: string) {
  const claim = await acquireGatewayE2ePortBlock();
  const server = await startClaimedGateway(claim, () =>
    startGatewayServer(claim.port, {
      bind: "loopback",
      auth: { mode: "token", token },
      controlUiEnabled: false,
      sidecarStartup: "defer",
    }),
  );
  return { port: claim.port, server };
}

describe("gateway web fetch discovery", () => {
  let workspacePluginCleanup: Promise<void> | undefined;

  beforeEach(resetGatewayTestState);

  afterEach(async () => {
    try {
      // Vitest starts hooks on timeout without joining the body's async finally.
      await workspacePluginCleanup;
    } finally {
      workspacePluginCleanup = undefined;
      resetGatewayTestState();
    }
  });

  it(
    "keeps legacy web_fetch source capture off the Gateway thread",
    { timeout: GATEWAY_E2E_TIMEOUT_MS },
    async ({ signal }) => {
      const { envSnapshot, tempHome, workspaceDir } = await setupGatewayTempHome({
        prefix: "openclaw-gw-cold-web-fetch-",
      });
      const token = nextGatewayId("cold-web-fetch-token");
      setTestEnvValue("OPENCLAW_GATEWAY_TOKEN", token);
      const pluginId = "legacy-fetch-fixture";
      const pluginDir = path.join(tempHome, pluginId);
      const registeredPath = path.join(tempHome, "fetch-provider-registered.txt");
      await fs.mkdir(pluginDir, { recursive: true });
      await fs.writeFile(
        path.join(pluginDir, "openclaw.plugin.json"),
        JSON.stringify({
          id: pluginId,
          // Legacy providers can register without a webFetchProviders contract.
          // No explicit startup activation or manifest provider hint is available.
          activation: { onStartup: false },
          configSchema: { type: "object", additionalProperties: false },
        }),
      );
      await fs.writeFile(
        path.join(pluginDir, "index.cjs"),
        `module.exports = {
  id: ${JSON.stringify(pluginId)},
  register(api) {
    require("node:fs").appendFileSync(${JSON.stringify(registeredPath)}, "registered\\n");
    api.registerWebFetchProvider({
      id: "legacy-fetch",
      label: "Legacy Fetch Fixture",
      hint: "",
      envVars: [],
      placeholder: "",
      signupUrl: "",
      credentialPath: "apiKey",
      getCredentialValue() { return "fixture-only"; },
      getConfiguredCredentialValue() { return "fixture-only"; },
      setCredentialValue() {},
      createTool() {
        return {
          description: "Fixture fallback without network or model calls",
          parameters: {},
          async execute({ url }) {
            return { url, text: "cold provider fallback succeeded", status: 200 };
          },
        };
      },
    });
  },
};\n`,
      );
      const configPath = await createGatewayConfigPath(tempHome);
      const cfg: OpenClawConfig = {
        agents: {
          defaults: { workspace: workspaceDir },
          entries: { main: { tools: { allow: ["web_fetch"] } } },
        },
        plugins: {
          allow: [pluginId],
          load: { paths: [pluginDir] },
          entries: { [pluginId]: { enabled: true } },
          slots: { memory: "none" },
        },
        tools: {
          web: {
            search: { enabled: false },
            fetch: {
              cacheTtlMinutes: 0,
              ssrfPolicy: { allowedHostnames: ["127.0.0.1"] },
            },
          },
        },
        gateway: { auth: { token } },
      };
      await fs.writeFile(configPath, `${JSON.stringify(cfg, null, 2)}\n`);
      setTestEnvValue("OPENCLAW_CONFIG_PATH", configPath);

      const upstream = createServer((_request, response) => {
        response.writeHead(503, { "content-type": "text/plain" });
        response.end("fixture requires provider fallback");
      });
      let server: Awaited<ReturnType<typeof startGatewayServer>> | undefined;
      const cleanupSettled = createDeferred();
      workspacePluginCleanup = cleanupSettled.promise;
      void workspacePluginCleanup.catch(() => {});
      try {
        const upstreamUrl = await listenLoopback(upstream);
        const started = await startLoopbackTokenGateway(token);
        server = started.server;
        await withinTest(server.startupSettled, signal);
        const registeredBefore = await fs.readFile(registeredPath, "utf8").catch(() => "");

        // Observe the real loader without replacing its discovery or registration.
        // Source walking belongs in async preparation, not the Gateway event loop.
        const sourceVisit = vi.spyOn(pluginSourceReferences, "visitPluginSourceReferences");
        const prepare = vi.spyOn(pluginPreparation, "preparePluginGenerationArtifact");
        const invoke = async (pathname: string) => {
          const response = await fetch(`http://127.0.0.1:${started.port}/tools/invoke`, {
            method: "POST",
            headers: {
              authorization: `Bearer ${token}`,
              "content-type": "application/json",
              connection: "close",
            },
            body: JSON.stringify({
              tool: "web_fetch",
              args: { url: `${upstreamUrl}/${pathname}` },
              sessionKey: "main",
            }),
            signal,
          });
          const body = await response.json();
          expect(response.status, JSON.stringify(body)).toBe(200);
          expect(body).toMatchObject({
            ok: true,
            result: {
              details: {
                extractor: "legacy-fetch",
                text: expect.stringContaining("cold provider fallback succeeded"),
              },
            },
          });
        };
        // Distinct URLs avoid web_fetch's response-level in-flight/cache sharing.
        await Promise.all([invoke("cold-first"), invoke("cold-second")]);
        const registeredAfter = await fs.readFile(registeredPath, "utf8").catch(() => "");
        const observation = JSON.stringify({
          registrationsBefore: registeredBefore.trim().split("\n").filter(Boolean).length,
          registrationsAfter: registeredAfter.trim().split("\n").filter(Boolean).length,
          sourceVisits: sourceVisit.mock.calls.map(([source]) => source),
          preparations: prepare.mock.calls.map(([params]) => params.rootDir),
        });
        expect(registeredAfter, observation).toBe(`${registeredBefore}registered\n`);
        expect(sourceVisit, observation).not.toHaveBeenCalled();
        expect(prepare, observation).toHaveBeenCalledTimes(1);
        expect(prepare).toHaveBeenCalledWith(expect.objectContaining({ rootDir: pluginDir }));
        await invoke("warm-third");
        expect(await fs.readFile(registeredPath, "utf8")).toBe(registeredAfter);
        expect(sourceVisit).not.toHaveBeenCalled();
        expect(prepare).toHaveBeenCalledTimes(1);
      } finally {
        const cleanup = (async () => {
          vi.restoreAllMocks();
          await server?.close({ reason: "cold web fetch provider test complete" });
          await closeHttpServer(upstream);
          await removeGatewayTempHome(tempHome);
          envSnapshot.restore();
        })();
        cleanupSettled.resolve(cleanup);
        await cleanup;
      }
    },
  );
});
