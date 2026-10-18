import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createBeamTestCatalog,
  createBeamTestRuntime,
  beamTestNow,
} from "../../extensions/beam/src/beam.test-support.js";
import {
  createBeamMirrorRunner,
  createBeamMirrorService,
} from "../../extensions/beam/src/mirror.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import { createTestPluginServiceScheduler } from "../../src/plugin-sdk/plugin-test-api.js";
import { createRuntimeConfig } from "../../src/plugins/runtime/runtime-config.js";
import { activateSecretsRuntimeSnapshot } from "../../src/secrets/runtime.js";
import { setupSecretsRuntimeSnapshotTestHooks } from "../../src/secrets/runtime.test-support.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const { prepareSecretsRuntimeSnapshot } = setupSecretsRuntimeSnapshotTestHooks();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const tokenPath = "plugins.entries.beam.config.mirror.token";

function configWithToken(token: unknown): OpenClawConfig {
  return {
    agents: { entries: { main: {} } },
    plugins: {
      entries: {
        beam: {
          enabled: true,
          config: {
            mirror: {
              endpoint: "http://127.0.0.1:19483/beam",
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
    const scheduler = createTestPluginServiceScheduler();
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    try {
      await createBeamMirrorService({ runtime: createBeamTestRuntime(snapshot.config) }).start({
        config: snapshot.config,
        stateDir: "/unused",
        scheduler,
        logger,
      });
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
      const config = configWithToken({ source: "exec", provider: "beam-fixture", id: "mirror" });
      config.secrets = { providers: { "beam-fixture": { source: "exec", command } } };
      const snapshot = await prepare(config, {});
      expect(snapshot.config.plugins?.entries?.beam?.config).toMatchObject({
        mirror: { token: "synthetic-prepared-token" },
      });
      activateSecretsRuntimeSnapshot(snapshot);
      const requests: Array<{ url: string; auth: string | null }> = [];
      let reads = 0;
      let reloadDuringRead: (() => void) | undefined;
      const runner = createBeamMirrorRunner({
        runtime: { config: createRuntimeConfig() },
        now: () => beamTestNow,
        signal: new AbortController().signal,
        logger: { info() {}, warn() {} },
        listCatalogs: () => [
          createBeamTestCatalog({
            items: () => [{ type: "agentMessage", text: "revision " + ++reads }],
            onRead: () => reloadDuringRead?.(),
          }),
        ],
        fetchFn: async (url, init) => {
          requests.push({
            url: typeof url === "string" ? url : url instanceof URL ? url.href : url.url,
            auth: new Headers(init?.headers).get("authorization"),
          });
          return new Response("{}", { status: 200 });
        },
      });
      await runner.tick();
      await runner.tick();
      expect(requests).toEqual([
        { url: "http://127.0.0.1:19483/beam", auth: "Bearer synthetic-prepared-token" },
        { url: "http://127.0.0.1:19483/beam", auth: "Bearer synthetic-prepared-token" },
      ]);
      expect((await fs.readFile(calls, "utf8")).trim().split("\n")).toHaveLength(1);

      await fs.rm(command);
      const cold = await prepare(config, {});
      reloadDuringRead = () => activateSecretsRuntimeSnapshot(cold);
      await runner.tick();
      expect(requests).toHaveLength(2);

      reloadDuringRead = undefined;
      await fs.writeFile(command, providerScript, { mode: 0o700 });
      activateSecretsRuntimeSnapshot(await prepare(config, {}));
      await runner.tick();
      expect(requests).toHaveLength(3);
      expect(requests[2]?.auth).toBe("Bearer synthetic-prepared-token");
      expect((await fs.readFile(calls, "utf8")).trim().split("\n")).toHaveLength(2);
    },
  );
});
