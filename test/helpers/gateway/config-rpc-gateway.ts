import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import chokidar from "chokidar";
import { afterAll, afterEach, beforeAll, beforeEach, expect, vi, type TestContext } from "vitest";
import { resolveDefaultAgentDir } from "../../../src/agents/agent-scope.js";
import { prepareHostConfigSnapshot } from "../../../src/config/io.snapshot-preparation.js";
import { GatewayClient, GatewayClientRequestError } from "../../../src/gateway/client.js";
import { invalidateConfigGetResponseCache } from "../../../src/gateway/config-get-response.js";
import { pruneStaleControlPlaneBuckets } from "../../../src/gateway/control-plane-rate-limit.js";
import { configRawPayload } from "../../../src/gateway/server.config-patch.test-support.js";
import { startGatewayServer } from "../../../src/gateway/server.js";
import { resetGatewayRestartStateForInProcessRestart } from "../../../src/infra/restart.js";
import { readConfiguredParsedLogTail } from "../../../src/logging/log-tail.js";
import { flushLogger, resetLogger, setLoggerOverride } from "../../../src/logging/logger.js";
import { clearPluginMetadataLifecycleCaches } from "../../../src/plugins/plugin-metadata-lifecycle.js";
import { createDeferredCore } from "../../../src/shared/deferred.js";
import { deleteTestEnvValue } from "../../../src/test-utils/env.js";
import { createOpenClawTestState } from "../../../src/test-utils/openclaw-test-state.js";
import { getFreePort } from "../../../src/test-utils/ports.js";
import { withTestTimeout } from "../promise.js";
import { runQaGatewayFixture } from "../qa-gateway-cleanup.js";

const GATEWAY_TOKEN = "config-rpc-synthetic-token";

let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
let server: Awaited<ReturnType<typeof startGatewayServer>> | undefined;
let client: GatewayClient | undefined;
const hotReloadRecovery = vi.fn(() => ({ status: "emitted" as const }));
const unarmedConfigWatchers: ReturnType<typeof chokidar.watch>[] = [];

type ConfigRpcGatewayOptions = {
  configRelativePath?: string;
  watchConfigFiles?: boolean;
};

export function requireClient(): GatewayClient {
  if (!client) {
    throw new Error("gateway test client not started");
  }
  return client;
}

// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Gateway test RPC helper lets callers ascribe response payload shape.
export async function rpcReq<T extends Record<string, unknown>>(
  gatewayClient: GatewayClient,
  method: string,
  params?: unknown,
  timeoutMs = 10_000,
): Promise<{
  ok: boolean;
  payload?: T;
  error?: { message?: string; code?: string; details?: unknown };
}> {
  try {
    return { ok: true, payload: await gatewayClient.request<T>(method, params, { timeoutMs }) };
  } catch (error) {
    if (!(error instanceof GatewayClientRequestError)) {
      throw error;
    }
    let message = error.message;
    if (isRecord(error.details) && Object.hasOwn(error.details, "persistedConfig")) {
      try {
        await flushLogger();
        const tail = await readConfiguredParsedLogTail({
          limit: 8,
          maxBytes: 64 * 1024,
          filter: ({ subsystem }) => subsystem === "gateway/reload",
        });
        if (tail.lines.length > 0) {
          message += `\nRecent Gateway reload diagnostics:\n${tail.lines.map((line) => line.message).join("\n")}`;
        }
      } catch {
        // Diagnostic I/O must not replace the config operation's original failure.
        message += "\nRecent Gateway reload diagnostics could not be read.";
      }
    }
    return {
      ok: false,
      error: { message, code: error.code, details: error.details },
    };
  }
}

export function requireConfigObject(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`expected ${label}`);
  }
  return value as Record<string, unknown>;
}

async function startConfigRpcGateway(
  { configRelativePath, watchConfigFiles = true }: ConfigRpcGatewayOptions = {},
  recordPhase?: (phase: string) => void,
) {
  recordPhase?.("state.create");
  state = await createOpenClawTestState({
    label: "config-rpc",
    env: {
      OPENCLAW_GATEWAY_TOKEN: undefined,
      OPENCLAW_GATEWAY_PASSWORD: undefined,
      OPENCLAW_LOG_LEVEL: undefined,
      OPENCLAW_TEST_MINIMAL_GATEWAY: "0",
      OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
      OPENCLAW_SKIP_CANVAS_HOST: "1",
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_SKIP_CRON: "1",
      OPENCLAW_SKIP_GMAIL_WATCHER: "1",
      OPENCLAW_SKIP_PROVIDERS: "1",
      // Config RPCs use real model discovery, without an unrelated native marketplace sync.
      OPENCLAW_CODEX_APP_SERVER_ARGS: "app-server --listen stdio:// -c features.plugins=false",
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
      OPENCLAW_BUNDLED_PLUGINS_DIR: path.resolve(import.meta.dirname, "../../../dist/extensions"),
    },
  });
  setLoggerOverride({
    file: state.path("gateway.log"),
    level: "info",
    consoleLevel: "silent",
  });
  const config = { agents: { entries: { main: {} } } };
  const configPath = configRelativePath ? state.statePath(configRelativePath) : state.configPath;
  recordPhase?.("config.write");
  if (configRelativePath) {
    await writeJsonFile(configPath, config);
    process.env.OPENCLAW_CONFIG_PATH = configPath;
  } else {
    await state.writeConfig(config);
  }
  if (!watchConfigFiles) {
    const watch = chokidar.watch;
    vi.spyOn(chokidar, "watch").mockImplementation((paths, options) => {
      if ((Array.isArray(paths) ? paths : [paths]).includes(configPath)) {
        // Keep managed writes and the real read cache active without independent file notifications.
        const watcher = new chokidar.FSWatcher(options);
        unarmedConfigWatchers.push(watcher);
        return watcher;
      }
      return watch(paths, options);
    });
  }
  hotReloadRecovery.mockClear();
  recordPhase?.("port.allocate");
  const port = await getFreePort();
  recordPhase?.("server.start");
  server = await startGatewayServer(port, {
    auth: { mode: "token", token: GATEWAY_TOKEN },
    prepareConfigSnapshot: prepareHostConfigSnapshot,
    controlUiEnabled: false,
    hotReloadRecovery,
  });
  recordPhase?.("client.create");
  const connected = createDeferredCore();
  client = new GatewayClient({
    url: `ws://127.0.0.1:${port}`,
    token: GATEWAY_TOKEN,
    clientName: "gateway-client",
    clientVersion: "1.0.0",
    platform: "test",
    mode: "backend",
    deviceIdentity: null,
    scopes: ["operator.admin"],
    hostDeps: {
      loadDeviceAuthToken: () => null,
      storeDeviceAuthToken: () => {},
      clearDeviceAuthToken: () => {},
    },
    onHelloOk: () => connected.resolve(),
    onConnectError: (error) => connected.reject(error),
    onClose: (code, reason) => connected.reject(new Error(`closed ${code}: ${reason}`)),
  });
  client.start();
  recordPhase?.("client.connect");
  await withTestTimeout(connected.promise, 10_000, "gateway connect timeout");
  recordPhase?.("server.startupSettled");
  await server.startupSettled;
  recordPhase?.("complete");
}

async function stopConfigRpcGateway(recordPhase?: (phase: string) => void) {
  // This fixture has no run loop. Retire direct RPC restart timers before
  // teardown and after its owners drain so they cannot reach the next case.
  await runQaGatewayFixture(
    async () => {
      recordPhase?.("restart.before");
      return resetGatewayRestartStateForInProcessRestart();
    },
    async () => {
      recordPhase?.("client.stopAndWait");
      await client?.stopAndWait();
      client = undefined;
    },
    async () => {
      recordPhase?.("server.close");
      await server?.close();
      server = undefined;
    },
    () => {
      recordPhase?.("watchers.close");
      return Promise.all(unarmedConfigWatchers.splice(0).map((watcher) => watcher.close()));
    },
    () => {
      recordPhase?.("restart.after");
      return resetGatewayRestartStateForInProcessRestart();
    },
    () => {
      recordPhase?.("logger.flush");
      return flushLogger();
    },
    () => {
      recordPhase?.("state.cleanup");
      return state?.cleanup();
    },
    () => {
      recordPhase?.("logger.reset");
      return resetLogger();
    },
    () => {
      recordPhase?.("metadata.clearCaches");
      return clearPluginMetadataLifecycleCaches();
    },
    () => {
      recordPhase?.("mocks.restore");
      return vi.restoreAllMocks();
    },
    () => {
      recordPhase?.("recovery.assert");
      return expect(hotReloadRecovery).not.toHaveBeenCalled();
    },
  );
  recordPhase?.("complete");
}

export async function resetTempDir(name: string): Promise<string> {
  const dir = state.path("fixtures", name);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

export async function writeJsonFile(filePath: string, value: unknown) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

export async function getConfigHash() {
  const current = await rpcReq(requireClient(), "config.get", {});
  expect(current.ok).toBe(true);
  expect(typeof current.payload?.hash).toBe("string");
  return String(current.payload?.hash);
}

export async function sendConfigApply(
  params: { raw: unknown; baseHash?: string },
  timeoutMs?: number,
) {
  return await rpcReq(requireClient(), "config.apply", params, timeoutMs);
}

export async function sendConfigSet(
  params: { raw: string; baseHash?: string },
  timeoutMs?: number,
) {
  return await rpcReq(requireClient(), "config.set", params, timeoutMs);
}

export async function getCurrentConfigObject() {
  const current = await rpcReq<{
    raw?: string | null;
    valid?: boolean;
    hash?: string;
    path?: string;
    config?: Record<string, unknown>;
    sourceConfig?: Record<string, unknown>;
  }>(requireClient(), "config.get", {});
  expect(current.ok).toBe(true);
  expect(typeof current.payload?.hash).toBe("string");
  expect(typeof current.payload?.path).toBe("string");
  return {
    hash: String(current.payload?.hash),
    path: String(current.payload?.path),
    raw: current.payload?.raw,
    valid: current.payload?.valid,
    config: requireConfigObject(current.payload?.sourceConfig, "editable source config"),
    runtimeConfig: requireConfigObject(current.payload?.config, "runtime config"),
  };
}

export async function restoreConfigFileForTest(
  original: Awaited<ReturnType<typeof getCurrentConfigObject>>,
) {
  await writeJsonFile(original.path, original.config);
}

export async function writeUnresolvedAuthProfileTokenRef(missingEnvVar: string) {
  deleteTestEnvValue(missingEnvVar);
  const authStorePath = path.join(resolveDefaultAgentDir({}), "auth-profiles.json");
  await fs.mkdir(path.dirname(authStorePath), { recursive: true });
  await fs.writeFile(
    authStorePath,
    `${JSON.stringify(
      {
        version: 1,
        profiles: {
          "custom:token": {
            type: "token",
            provider: "custom",
            tokenRef: { source: "env", provider: "default", id: missingEnvVar },
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf-8",
  );
}

export function installConfigWriteGatewayHooks(options: ConfigRpcGatewayOptions = {}) {
  const phasesByTask = new WeakMap<TestContext["task"], { setup: string; teardown: string }>();
  beforeEach((context) => {
    const phases = { setup: "not-started", teardown: "not-started" };
    phasesByTask.set(context.task, phases);
    context.onTestFailed(() => {
      console.error(
        "[config-rpc-hook-phase]",
        JSON.stringify({ test: context.task.name, ...phases }),
      );
    });
    return startConfigRpcGateway(options, (phase) => {
      phases.setup = phase;
    });
  });
  beforeEach(() => {
    pruneStaleControlPlaneBuckets(Number.MAX_SAFE_INTEGER);
  });
  afterEach((context) => {
    const phases = phasesByTask.get(context.task);
    return stopConfigRpcGateway((phase) => {
      if (phases) {
        phases.teardown = phase;
      }
    });
  });
}

export function installSharedConfigWriteGatewayHooks({
  configRelativePath,
  fixturePaths = [],
}: {
  configRelativePath?: string;
  fixturePaths?: string[];
} = {}) {
  let original: Awaited<ReturnType<typeof getCurrentConfigObject>>;
  beforeAll(async () => {
    await startConfigRpcGateway({ configRelativePath });
    original = await getCurrentConfigObject();
  });
  beforeEach(() => {
    pruneStaleControlPlaneBuckets(Number.MAX_SAFE_INTEGER);
    hotReloadRecovery.mockClear();
  });
  afterEach(() =>
    runQaGatewayFixture(
      async () => resetGatewayRestartStateForInProcessRestart(),
      () => vi.restoreAllMocks(),
      async () => {
        // Reset fixture data, then join the real reload owner before the next case.
        // config.set only acknowledges persistence; config.apply also joins application.
        await restoreConfigFileForTest(original);
        invalidateConfigGetResponseCache();
        const restored = await sendConfigApply(
          configRawPayload(original.config, await getConfigHash()),
        );
        expect(restored.ok, restored.error?.message).toBe(true);
      },
      () =>
        Promise.all(
          fixturePaths.map((name) =>
            fs.rm(path.join(path.dirname(original.path), name), { recursive: true, force: true }),
          ),
        ),
      () => resetGatewayRestartStateForInProcessRestart(),
      () => expect(hotReloadRecovery).not.toHaveBeenCalled(),
    ),
  );
  afterAll(() => stopConfigRpcGateway());
}

export function installReadOnlyConfigGatewayHooks() {
  // Authored fixtures exercise RPC reads/rejections without asynchronous file reloads.
  beforeAll(() => startConfigRpcGateway({ watchConfigFiles: false }));
  beforeEach(() => {
    resetGatewayRestartStateForInProcessRestart();
    pruneStaleControlPlaneBuckets(Number.MAX_SAFE_INTEGER);
    hotReloadRecovery.mockClear();
  });
  afterEach(() =>
    runQaGatewayFixture(
      async () => resetGatewayRestartStateForInProcessRestart(),
      () => vi.restoreAllMocks(),
      () => expect(hotReloadRecovery).not.toHaveBeenCalled(),
    ),
  );
  afterAll(() => stopConfigRpcGateway());
}

export function configRpcWorkspacePath(name: string) {
  return state.path(name);
}
