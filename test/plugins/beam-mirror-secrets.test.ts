import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as processRuntime from "openclaw/plugin-sdk/process-runtime";
import { afterEach, assert, expect, it, vi } from "vitest";
import beamPlugin from "../../extensions/beam/index.js";
import { getRuntimeConfig } from "../../src/config/io.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
  createTestPluginServiceScheduler,
} from "../../src/plugin-sdk/plugin-test-api.js";
import { createPluginRecord } from "../../src/plugins/loader-records.js";
import { createRuntimeTestRegistry } from "../../src/plugins/registry-runtime.test-helpers.js";
import { setActivePluginRegistry } from "../../src/plugins/runtime.js";
import { createPluginRuntime } from "../../src/plugins/runtime/index.js";
import { createPluginServiceCatalogExports } from "../../src/plugins/service-catalog-exports.js";
import type { SessionCatalogProvider } from "../../src/plugins/session-catalog.js";
import { activateSecretsRuntimeSnapshot } from "../../src/secrets/runtime.js";
import { setupSecretsRuntimeSnapshotTestHooks } from "../../src/secrets/runtime.test-support.js";
import { closeHttpServer, listenLoopback } from "../helpers/gateway-integration-fixtures.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

// A source checkout does not contain release binaries. Install one pinned
// process fixture so this credential test takes the production registration,
// executable verification and child-process path.
const cleaner = vi.hoisted(
  () =>
    "#!" +
    process.execPath +
    "\n" +
    `
let input = "";
process.stdin.setEncoding("utf8").on("data", (chunk) => input += chunk);
process.stdin.on("end", () => {
  const { source, title, updatedAt, completed, items } = JSON.parse(input);
  const messages = items.map(({ type, text, speakerId }) => ({
    type, text, ...(speakerId ? { speaker: "p" + speakerId } : {}),
  }));
  process.stdout.write(JSON.stringify({ version: 2, beamId: "a".repeat(32), source, title, updatedAt, completed, items: messages }));
});
`,
);
vi.mock("../../extensions/beam/package.json", async (importOriginal) => {
  const current = await importOriginal<{ default: Record<string, unknown> }>();
  if (process.env.BEAM_TEST_CLEANER_PLUGIN_ROOT) {
    return current;
  }
  const { createHash } = await import("node:crypto");
  return {
    ...current,
    default: {
      ...current.default,
      beamNativeRelease: {
        version: "fixture",
        protocol: 1,
        platforms: {
          [process.platform + "-" + process.arch]: {
            executableBytes: Buffer.byteLength(cleaner),
            executableSha256: createHash("sha256").update(cleaner).digest("hex"),
          },
        },
      },
    },
  };
});

const { prepareSecretsRuntimeSnapshot } = setupSecretsRuntimeSnapshotTestHooks();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const tokenPath = "plugins.entries.beam.config.mirror.token";
const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(closeHttpServer));
});

function configWithToken(token: unknown, endpoint = "http://127.0.0.1:19483/beam"): OpenClawConfig {
  const mirror = { endpoint, catalogs: ["claude"], token };
  return {
    agents: { entries: { main: {} } },
    plugins: { entries: { beam: { enabled: true, config: { mirror } } } },
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

async function startMirror(config: OpenClawConfig, read?: SessionCatalogProvider["read"]) {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  const builder = createRuntimeTestRegistry(createPluginRuntime());
  const packaged = process.env.BEAM_TEST_CLEANER_PLUGIN_ROOT;
  const rootDir = packaged ?? tempDirs.make("beam-credential-plugin-");
  if (!packaged) {
    const platform = path.join(rootDir, "native", process.platform + "-" + process.arch);
    await fs.mkdir(platform, { recursive: true });
    await fs.writeFile(path.join(platform, "beam-clean"), cleaner, { mode: 0o700 });
  }
  const record = createPluginRecord({
    id: "beam",
    rootDir,
    source: fileURLToPath(new URL("../../extensions/beam/index.ts", import.meta.url)),
    origin: "bundled",
    enabled: true,
    configSchema: true,
  });
  const api = builder.createApi(record, { config });
  beamPlugin.register(api);
  if (read) {
    const producer = createPluginRecord({
      id: "native-catalog-fixture",
      source: "fixture",
      configSchema: true,
      origin: "bundled",
      enabled: true,
    });
    builder.createApi(producer, { config }).registerSessionCatalog({
      id: "claude",
      label: "Synthetic catalog",
      supportsProcessHomeIsolation: true,
      automaticExportHosts: () => ["gateway:local"],
      async list() {
        const session = {
          threadId: "t1",
          sourceHomeId: "isolated-fixture-home",
          exportPolicy: {
            origin: "native-local" as const,
            automatic: true,
            stableHostThreadIdentity: true as const,
          },
          recencyAt: Date.now(),
          status: "stored",
          archived: false,
          canContinue: false,
          canArchive: false,
        };
        return [
          {
            hostId: "gateway:local",
            label: "Local",
            kind: "gateway",
            connected: true,
            sessions: [session],
          },
        ];
      },
      read,
    });
  }
  setActivePluginRegistry(builder.registry);
  const service = builder.registry.services.find(({ id }) => id === "beam-mirror")?.service;
  assert(service?.apiVersion === 2, "Beam did not register its mirror service");
  const clock = createGatewaySchedulerClock(Date.now());
  const scheduler = createTestPluginServiceScheduler(createTestGatewayScheduler(clock.clock));
  assert(service.catalogExports, "Beam did not request catalog export access");
  const catalogExports = createPluginServiceCatalogExports({
    pluginId: record.id,
    configPath: service.catalogExports.allowlistPath,
    registry: builder.registry,
    signal: scheduler.signal,
    assertActive: () => scheduler.signal.throwIfAborted(),
    getConfig: getRuntimeConfig,
  });
  await service.start({ config, stateDir: "/unused", scheduler, logger, catalogExports });
  return { clock, scheduler, logger };
}

it("isolates a cold Beam credential without disabling unrelated configured credentials", async () => {
  const config = configWithToken({ source: "env", provider: "default", id: "BEAM_MISSING_TOKEN" });
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
  expect(snapshot.degradedOwners).toMatchObject([
    { ownerKind: "capability", ownerId: tokenPath, degradationState: "cold" },
  ]);
  expect(snapshot.config.models?.providers?.example?.apiKey).toBe("synthetic-healthy-key");
  activateSecretsRuntimeSnapshot(snapshot);
  const { scheduler, logger } = await startMirror(snapshot.config);
  try {
    const warnings = logger.warn.mock.calls.flat().join("\n");
    expect(warnings).toContain("credential");
    expect(warnings).not.toContain("BEAM_MISSING_TOKEN");
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
    const requests: Array<[string, string | null]> = [];
    const server = http.createServer((req, res) => {
      requests.push([req.url ?? "", req.headers.authorization ?? null]);
      req.resume();
      res.end("{}");
    });
    servers.push(server);
    const baseUrl = await listenLoopback(server);
    const config = configWithToken(
      { source: "exec", provider: "beam-fixture", id: "mirror" },
      `${baseUrl}/beam`,
    );
    config.secrets = { providers: { "beam-fixture": { source: "exec", command } } };
    const snapshot = await prepare(config, {});
    activateSecretsRuntimeSnapshot(snapshot);
    let reads = 0;
    let reloadDuringRead: (() => void) | undefined;
    const { clock, scheduler } = await startMirror(
      snapshot.config,
      async ({ hostId, threadId }) => {
        reloadDuringRead?.();
        return { hostId, threadId, items: [{ type: "agentMessage", text: String(++reads) }] };
      },
    );
    try {
      await clock.wake();
      await clock.advanceBy(30_000);
      expect(requests).toEqual([
        ["/beam", "Bearer synthetic-prepared-token"],
        ["/beam", "Bearer synthetic-prepared-token"],
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
      expect(requests[2]?.[1]).toBe("Bearer synthetic-prepared-token");
      expect((await fs.readFile(calls, "utf8")).trim().split("\n")).toHaveLength(2);
    } finally {
      await scheduler.stop();
    }
  },
);

it.skipIf(process.platform === "win32" && !process.env.BEAM_TEST_CLEANER_PLUGIN_ROOT)(
  "exports an attributed assistant and two human speakers from a registered local catalog",
  async () => {
    let deliveries = 0;
    const server = http.createServer((req, res) => {
      req.resume();
      deliveries++;
      res.end("{}");
    });
    servers.push(server);
    const config = configWithToken("fixture", (await listenLoopback(server)) + "/beam");
    const snapshot = await prepare(config, {});
    activateSecretsRuntimeSnapshot(snapshot);
    const cleanerRun = vi.spyOn(processRuntime, "runCommandBuffered");
    const { clock, scheduler } = await startMirror(
      snapshot.config,
      async ({ hostId, threadId }) => ({
        hostId,
        threadId,
        items: [
          {
            type: "userMessage",
            text: "Thanks.",
            sender: { identity: { type: "profile", id: "private-first" }, label: "First person" },
          },
          {
            type: "userMessage",
            text: "One more detail.",
            sender: { identity: { type: "profile", id: "private-second" }, label: "Second person" },
          },
          {
            type: "agentMessage",
            text: "Here is the result.",
            sender: { identity: { type: "agent", id: "private-assistant" }, label: "Assistant" },
          },
          {
            type: "userMessage",
            text: "Please check.",
            sender: { identity: { type: "profile", id: "private-first" }, label: "First person" },
          },
        ],
      }),
    );
    try {
      await clock.wake();
      expect(cleanerRun).toHaveBeenCalledTimes(1);
      const call = cleanerRun.mock.results[0];
      assert(call?.type === "return");
      const { stdout, code } = await call.value;
      expect(code).toBe(0);
      expect(JSON.parse(stdout.toString()).items).toEqual([
        { type: "userMessage", text: "Please check.", speaker: "p1" },
        { type: "agentMessage", text: "Here is the result." },
        { type: "userMessage", text: "One more detail.", speaker: "p2" },
        { type: "userMessage", text: "Thanks.", speaker: "p1" },
      ]);
      expect(stdout.toString()).not.toContain("private-");
      expect(deliveries).toBe(1);
    } finally {
      cleanerRun.mockRestore();
      await scheduler.stop();
    }
  },
);
