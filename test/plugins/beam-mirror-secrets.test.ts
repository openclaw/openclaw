import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import beamPlugin from "../../extensions/beam/index.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
  createTestPluginServiceScheduler,
} from "../../src/plugin-sdk/plugin-test-api.js";
import { createPluginRecord } from "../../src/plugins/loader-records.js";
import { createPluginRegistry } from "../../src/plugins/registry.js";
import { setActivePluginRegistry } from "../../src/plugins/runtime.js";
import { createPluginRuntime } from "../../src/plugins/runtime/index.js";
import type { SessionCatalogProvider } from "../../src/plugins/session-catalog.js";
import { activateSecretsRuntimeSnapshot } from "../../src/secrets/runtime.js";
import { setupSecretsRuntimeSnapshotTestHooks } from "../../src/secrets/runtime.test-support.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const { prepareSecretsRuntimeSnapshot } = setupSecretsRuntimeSnapshotTestHooks();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const tokenPath = "plugins.entries.beam.config.mirror.token";
const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    ),
  );
});

function configWithToken(token: unknown, endpoint = "http://127.0.0.1:19483/beam"): OpenClawConfig {
  return {
    agents: { entries: { main: {} } },
    plugins: {
      entries: {
        beam: {
          enabled: true,
          config: {
            mirror: {
              endpoint,
              catalogs: ["claude"],
              token,
            },
          },
        },
      },
    },
  };
}

function prepare(config: OpenClawConfig, env: NodeJS.ProcessEnv) {
  return prepareSecretsRuntimeSnapshot({
    config,
    env,
    includeAuthStoreRefs: false,
    allowUnavailableSecretOwners: true,
    loadablePluginOrigins: new Map([["beam", "bundled"]]),
  });
}

async function startMirror(config: OpenClawConfig, catalog?: SessionCatalogProvider) {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const builder = createPluginRegistry({
    runtime: createPluginRuntime(),
    logger,
    activateGlobalSideEffects: false,
  });
  const record = createPluginRecord({
    id: "beam",
    source: fileURLToPath(new URL("../../extensions/beam/index.ts", import.meta.url)),
    origin: "bundled",
    enabled: true,
    configSchema: true,
  });
  builder.registry.plugins.push(record);
  const api = builder.createApi(record, { config });
  beamPlugin.register(api);
  if (catalog) {
    api.registerSessionCatalog(catalog);
  }
  setActivePluginRegistry(builder.registry);
  const service = builder.registry.services.find(({ id }) => id === "beam-mirror")?.service;
  if (!service || service.apiVersion !== 2) {
    throw new Error("Beam did not register its mirror service");
  }
  const clock = createGatewaySchedulerClock(Date.now());
  const scheduler = createTestPluginServiceScheduler(createTestGatewayScheduler(clock.clock));
  await service.start({ config, stateDir: "/unused", scheduler, logger });
  return { clock, scheduler, logger };
}

describe("Beam mirror prepared credentials", () => {
  it("isolates a cold mirror credential without disabling unrelated configured credentials", async () => {
    const config = configWithToken({
      source: "env",
      provider: "default",
      id: "BEAM_MISSING_TOKEN",
    });
    config.models = {
      providers: {
        example: {
          baseUrl: "https://provider.example/v1",
          apiKey: { source: "env", provider: "default", id: "HEALTHY_TOKEN" },
          models: [],
        },
      },
    };
    const snapshot = await prepare(config, { HEALTHY_TOKEN: "synthetic-healthy-key" });
    expect(snapshot.degradedOwners).toEqual([
      expect.objectContaining({
        ownerKind: "capability",
        ownerId: tokenPath,
        degradationState: "cold",
      }),
    ]);
    expect(snapshot.config.models?.providers?.example?.apiKey).toBe("synthetic-healthy-key");
    activateSecretsRuntimeSnapshot(snapshot);
    const { scheduler, logger } = await startMirror(snapshot.config);
    try {
      expect(logger.info).not.toHaveBeenCalled();
      expect(logger.warn.mock.calls.flat().join("\n")).toContain("credential");
      expect(logger.warn.mock.calls.flat().join("\n")).not.toContain("BEAM_MISSING_TOKEN");
    } finally {
      await scheduler.stop();
    }
  });

  it.skipIf(process.platform === "win32")(
    "uses prepared exec credentials and observes reloads before dispatch",
    async () => {
      const root = tempDirs.make("beam-secret-boundary-");
      const command = path.join(root, "credential.sh");
      const calls = path.join(root, "calls");
      const providerScript =
        "#!/bin/sh\nprintf 'call\\n' >> " +
        JSON.stringify(calls) +
        '\nprintf \'%s\\n\' \'{"protocolVersion":1,"values":{"mirror":"synthetic-prepared-token"}}\'\n';
      await fs.writeFile(command, providerScript, { mode: 0o700 });
      const requests: Array<{ url: string; auth: string | null }> = [];
      const server = http.createServer((req, res) => {
        requests.push({ url: req.url ?? "", auth: req.headers.authorization ?? null });
        req.resume();
        res.end("{}");
      });
      servers.push(server);
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Synthetic Beam receiver did not bind a TCP port");
      }
      const config = configWithToken(
        { source: "exec", provider: "beam-fixture", id: "mirror" },
        `http://127.0.0.1:${address.port}/beam`,
      );
      config.secrets = { providers: { "beam-fixture": { source: "exec", command } } };
      const snapshot = await prepare(config, {});
      expect(snapshot.config.plugins?.entries?.beam?.config).toMatchObject({
        mirror: { token: "synthetic-prepared-token" },
      });
      activateSecretsRuntimeSnapshot(snapshot);
      let reads = 0;
      let reloadDuringRead: (() => void) | undefined;
      const { clock, scheduler } = await startMirror(snapshot.config, {
        id: "claude",
        label: "Synthetic catalog",
        async list() {
          return [
            {
              hostId: "gateway:local",
              label: "Local",
              kind: "gateway",
              connected: true,
              sessions: [
                {
                  threadId: "t1",
                  recencyAt: Date.now(),
                  status: "stored",
                  createdAt: Date.now() - 60_000,
                  updatedAt: Date.now(),
                  archived: false,
                  canContinue: false,
                  canArchive: false,
                },
              ],
            },
          ];
        },
        async read({ hostId, threadId }) {
          reloadDuringRead?.();
          return {
            hostId,
            threadId,
            label: "Local",
            items: [
              {
                type: "agentMessage",
                text: "revision " + ++reads,
              },
            ],
          };
        },
      });
      try {
        await clock.wake();
        await clock.advanceBy(30_000);
        expect(requests).toEqual([
          { url: "/beam", auth: "Bearer synthetic-prepared-token" },
          { url: "/beam", auth: "Bearer synthetic-prepared-token" },
        ]);
        expect((await fs.readFile(calls, "utf8")).trim().split("\n")).toHaveLength(1);

        await fs.rm(command);
        const cold = await prepare(config, {});
        reloadDuringRead = () => activateSecretsRuntimeSnapshot(cold);
        await clock.advanceBy(30_000);
        expect(requests).toHaveLength(2);

        reloadDuringRead = undefined;
        await fs.writeFile(command, providerScript, { mode: 0o700 });
        activateSecretsRuntimeSnapshot(await prepare(config, {}));
        await clock.advanceBy(30_000);
        expect(requests).toHaveLength(3);
        expect(requests[2]?.auth).toBe("Bearer synthetic-prepared-token");
        expect((await fs.readFile(calls, "utf8")).trim().split("\n")).toHaveLength(2);
      } finally {
        await scheduler.stop();
      }
    },
  );
});
