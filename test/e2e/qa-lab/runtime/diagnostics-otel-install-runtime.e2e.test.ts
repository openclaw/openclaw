import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterAll, describe, expect, test, type TestContext } from "vitest";
import {
  createQaGatewayChild,
  startQaMockOpenAiServer,
  type QaGatewayChild,
} from "../../../../extensions/qa-lab/api.js";
import { readPluginInstallRecords } from "../../../../scripts/e2e/lib/plugin-index-sqlite.mjs";
import { awaitGateBeforeSettlement, withinTest } from "../../../helpers/promise.js";
import { runQaGatewayFixture, stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import { startLocalOtlpReceiver } from "./otel-test-support.js";

const execFileAsync = promisify(execFile);
const PACKAGE_NAME = "@openclaw/diagnostics-otel";

type MutableConfig = {
  diagnostics?: unknown;
  plugins?: {
    entries?: Record<string, { enabled?: boolean }>;
  };
  [key: string]: unknown;
};

async function stopChild(
  owned: { child: ChildProcess; exited: Promise<unknown> } | undefined,
): Promise<void> {
  if (!owned) {
    return;
  }
  const { child, exited } = owned;
  // The grace only escalates termination; cleanup still joins the retained exit.
  const escalation = setTimeout(() => child.kill("SIGKILL"), 5_000);
  escalation.unref();
  try {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
    }
    await exited;
  } finally {
    clearTimeout(escalation);
  }
}

async function waitFor<T>(
  read: () => T | undefined | Promise<T | undefined>,
  timeoutMs = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) {
      return value;
    }
    await sleep(100);
  }
  throw new Error("timed out waiting for managed diagnostics-otel evidence");
}

async function startReceiver() {
  const receiver = startLocalOtlpReceiver();
  const port = await receiver.listen();
  return { ...receiver, baseUrl: `http://127.0.0.1:${port}` };
}

async function settleCleanup(...cleanups: Array<() => Promise<void>>): Promise<void> {
  const results = await Promise.allSettled(cleanups.map(async (cleanup) => await cleanup()));
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length > 0) {
    throw new AggregateError(failures, "managed diagnostics-otel cleanup failed");
  }
}

function runOtelTestFixture(
  context: Pick<TestContext, "signal" | "onTestFinished">,
  body: () => Promise<void>,
  cleanup: () => Promise<void>,
): Promise<void> {
  let closing: Promise<void> | undefined;
  const close = () => (closing ??= cleanup());
  const completed = runQaGatewayFixture(async () => {
    context.signal.throwIfAborted();
    await body();
  }, close);
  // Vitest cancels its wrapper before the body finishes unwinding. Retain that
  // original lifetime so suite teardown cannot remove the packed seed early.
  context.onTestFinished(async () => {
    await completed.catch(() => {});
    await close();
  });
  return completed;
}

async function packPlugin(repoRoot: string, scratch: string) {
  const outputDir = path.join(scratch, "pack");
  const pluginRoot = path.join(repoRoot, "extensions/diagnostics-otel");
  const stagingDir = path.join(scratch, "package-source");
  await cp(pluginRoot, stagingDir, {
    recursive: true,
    filter: (source) => {
      const relative = path.relative(pluginRoot, source);
      const topLevel = relative.split(path.sep)[0];
      return topLevel !== "dist" && topLevel !== "node_modules";
    },
  });
  await mkdir(outputDir, { recursive: true });
  await execFileAsync(process.execPath, ["scripts/lib/plugin-npm-runtime-build.mjs", stagingDir], {
    cwd: repoRoot,
    maxBuffer: 16 * 1024 * 1024,
    timeout: 120_000,
  });
  await execFileAsync(
    process.execPath,
    [
      "scripts/lib/plugin-npm-package-manifest.mjs",
      "--run",
      stagingDir,
      "--",
      "npm",
      "pack",
      "--json",
      "--ignore-scripts",
      "--pack-destination",
      outputDir,
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        OPENCLAW_PLUGIN_NPM_BUNDLE_DEPENDENCIES: "1",
      },
      maxBuffer: 16 * 1024 * 1024,
      timeout: 120_000,
    },
  );
  const tarballName = (await readdir(outputDir)).find((name) => name.endsWith(".tgz"));
  if (!tarballName) {
    throw new Error("diagnostics-otel pack did not produce a tarball");
  }
  const manifest = JSON.parse(await readFile(path.join(stagingDir, "package.json"), "utf8")) as {
    version?: unknown;
  };
  if (typeof manifest.version !== "string" || !manifest.version.trim()) {
    throw new Error("diagnostics-otel package version is missing");
  }
  return {
    tarball: path.join(outputDir, tarballName),
    version: manifest.version.trim(),
  };
}

async function startRegistry(
  repoRoot: string,
  scratch: string,
  tarball: string,
  version: string,
  signal: AbortSignal,
) {
  const portFile = path.join(scratch, "registry-port");
  const child = spawn(
    process.execPath,
    ["scripts/e2e/lib/plugins/npm-registry-server.mjs", portFile, PACKAGE_NAME, version, tarball],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        OPENCLAW_NPM_REGISTRY_UPSTREAM: "https://registry.npmjs.org",
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  const exited = once(child, "exit");
  const ready = once(child, "message").then(([message]: unknown[]) => {
    if (typeof message === "number" && Number.isInteger(message) && message > 0) {
      return message;
    }
    throw new Error("fixture npm registry sent invalid readiness");
  });
  try {
    const port = await withinTest(
      awaitGateBeforeSettlement(
        ready,
        exited.then(() => {
          throw new Error(`fixture npm registry exited early (${child.exitCode})`);
        }),
        "fixture npm registry exited early",
      ),
      signal,
    );
    return { baseUrl: `http://127.0.0.1:${port}`, child, exited };
  } catch (error) {
    await stopChild({ child, exited }).catch((stopError: unknown) => {
      throw new Error(
        `fixture npm registry startup cleanup failed: ${
          stopError instanceof Error ? stopError.message : String(stopError)
        }`,
        {
          cause: error,
        },
      );
    });
    throw error;
  }
}

async function runTurn(gateway: QaGatewayChild, marker: string) {
  const started = (await gateway.call("chat.send", {
    sessionKey: `agent:qa:${marker.toLowerCase()}`,
    message: `Reply exactly: ${marker}`,
    idempotencyKey: randomUUID(),
  })) as { runId?: string; status?: string };
  expect(started.status).toBe("started");
  expect(started.runId).toBeTruthy();
  const completed = (await gateway.call(
    "agent.wait",
    { runId: started.runId, timeoutMs: 60_000 },
    { timeoutMs: 65_000 },
  )) as { status?: string };
  expect(completed.status).toBe("ok");
}

async function restartWithOtelConfig(params: {
  gateway: QaGatewayChild;
  sampleRate: number;
  traceEndpoint: string;
}) {
  await params.gateway.restartAfterStateMutation(async ({ configPath }) => {
    const current = JSON.parse(await readFile(configPath, "utf8")) as MutableConfig;
    current.diagnostics = {
      enabled: true,
      otel: {
        enabled: true,
        protocol: "http/protobuf",
        traces: true,
        metrics: false,
        logs: false,
        tracesEndpoint: `${params.traceEndpoint}/v1/traces`,
        sampleRate: params.sampleRate,
        flushIntervalMs: 250,
        captureContent: false,
      },
    };
    await writeFile(configPath, `${JSON.stringify(current, null, 2)}\n`);
  });
}

// The caller retains the owner before startup and every later installation step.
async function startInstallGateway(params: {
  owner: ReturnType<typeof createQaGatewayChild>;
  envTraceEndpoint: string;
  mockBaseUrl: string;
  nodeOptions?: string;
  registryBaseUrl: string;
  repoRoot: string;
}) {
  return await params.owner.start({
    repoRoot: params.repoRoot,
    providerBaseUrl: `${params.mockBaseUrl}/v1`,
    providerMode: "mock-openai",
    transportBaseUrl: "http://127.0.0.1:9",
    controlUiEnabled: false,
    mutateConfig: (cfg) => ({
      ...cfg,
      plugins: {
        ...cfg.plugins,
        allow: [],
        slots: {
          ...cfg.plugins?.slots,
          memory: "none",
        },
        entries: {},
      },
    }),
    runtimeEnvPatch: {
      NPM_CONFIG_REGISTRY: params.registryBaseUrl,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `${params.envTraceEndpoint}/v1/traces`,
      ...(params.nodeOptions ? { NODE_OPTIONS: params.nodeOptions } : {}),
      ...(params.nodeOptions ? { OPENCLAW_OTEL_PRELOADED: "1" } : {}),
    },
  });
}

async function installAndConfigure(params: {
  gateway: QaGatewayChild;
  configTraceEndpoint: string;
  packageVersion: string;
  sampleRate?: number;
}) {
  const { gateway } = params;
  const spec = `npm:${PACKAGE_NAME}@${params.packageVersion}`;
  await gateway.runCli(["plugins", "install", spec, "--force", "--accept-capabilities"]);
  const stateDir = gateway.runtimeEnv.OPENCLAW_STATE_DIR;
  if (!stateDir) {
    throw new Error("qa gateway state directory was not configured");
  }
  const records = readPluginInstallRecords({
    stateDir,
    configPath: gateway.configPath,
  });
  expect(records["diagnostics-otel"]).toMatchObject({
    source: "npm",
    spec: `${PACKAGE_NAME}@${params.packageVersion}`,
    version: params.packageVersion,
    resolvedName: PACKAGE_NAME,
    resolvedVersion: params.packageVersion,
  });
  expect(records["diagnostics-otel"]?.installPath).toContain("diagnostics-otel");
  expect(records["diagnostics-otel"]?.integrity).toMatch(/^sha512-/u);

  await gateway.runCli(["plugins", "disable", "diagnostics-otel"]);
  let config = JSON.parse(await readFile(gateway.configPath, "utf8")) as MutableConfig;
  expect(config.plugins?.entries?.["diagnostics-otel"]?.enabled).toBe(false);
  await gateway.runCli(["plugins", "enable", "diagnostics-otel"]);
  config = JSON.parse(await readFile(gateway.configPath, "utf8")) as MutableConfig;
  expect(config.plugins?.entries?.["diagnostics-otel"]?.enabled).toBe(true);

  await restartWithOtelConfig({
    gateway,
    sampleRate: params.sampleRate ?? 1,
    traceEndpoint: params.configTraceEndpoint,
  });
  const inspect = JSON.parse(
    await gateway.runCli(["plugins", "inspect", "diagnostics-otel", "--runtime", "--json"]),
  ) as { plugin?: { enabled?: boolean; id?: string; status?: string } };
  expect(inspect.plugin).toMatchObject({
    enabled: true,
    id: "diagnostics-otel",
    status: "loaded",
  });
}

describe("managed diagnostics-otel install runtime", () => {
  let seedDir: string | undefined;
  let packedPlugin: ReturnType<typeof packPlugin> | undefined;

  afterAll(async () => {
    await runQaGatewayFixture(
      async () => await packedPlugin,
      async () => {
        if (seedDir) {
          await rm(seedDir, { recursive: true, force: true });
        }
      },
    );
  });

  async function copyPackedPlugin(repoRoot: string, scratch: string) {
    packedPlugin ??= (async () => {
      seedDir = await mkdtemp(path.join(tmpdir(), "openclaw-otel-install-seed-"));
      return await packPlugin(repoRoot, seedDir);
    })();
    const packed = await packedPlugin;
    const outputDir = path.join(scratch, "pack");
    await mkdir(outputDir, { recursive: true });
    const tarball = path.join(outputDir, path.basename(packed.tarball));
    await copyFile(packed.tarball, tarball);
    return { tarball, version: packed.version };
  }

  test("installs the exact package and exports with config precedence, sampling, and flush", async (context) => {
    const { signal } = context;
    const repoRoot = path.resolve(import.meta.dirname, "../../../..");
    const scratch = await mkdtemp(path.join(tmpdir(), "openclaw-otel-install-"));
    const configured = await startReceiver();
    const envOnly = await startReceiver();
    let registry: Awaited<ReturnType<typeof startRegistry>> | undefined;
    let mock: Awaited<ReturnType<typeof startQaMockOpenAiServer>> | undefined;
    const gatewayOwner = createQaGatewayChild();
    let gateway: QaGatewayChild | undefined;
    const runProof = async () => {
      const packed = await copyPackedPlugin(repoRoot, scratch);
      registry = await startRegistry(repoRoot, scratch, packed.tarball, packed.version, signal);
      mock = await startQaMockOpenAiServer();
      gateway = await startInstallGateway({
        owner: gatewayOwner,
        envTraceEndpoint: envOnly.baseUrl,
        mockBaseUrl: mock.baseUrl,
        registryBaseUrl: registry.baseUrl,
        repoRoot,
      });
      await installAndConfigure({
        gateway,
        configTraceEndpoint: configured.baseUrl,
        packageVersion: packed.version,
        sampleRate: 0,
      });
      await runTurn(gateway, "OTEL-MANAGED-SAMPLED-OUT");
      await sleep(1_500);
      expect(configured.capturedRequests).toHaveLength(0);
      expect(envOnly.capturedRequests).toHaveLength(0);

      await restartWithOtelConfig({
        gateway,
        sampleRate: 1,
        traceEndpoint: configured.baseUrl,
      });
      const sampledInRequestCursor = configured.capturedRequests.length;
      const sampledInSpanCursor = configured.capturedSpans.length;
      await runTurn(gateway, "OTEL-MANAGED-INSTALL-OK");
      const sampledInExport = await waitFor(() => {
        let spanOffset = sampledInSpanCursor;
        for (const request of configured.capturedRequests.slice(sampledInRequestCursor)) {
          const requestSpans = configured.capturedSpans.slice(
            spanOffset,
            spanOffset + request.spanCount,
          );
          spanOffset += request.spanCount;
          if (
            request.path === "/v1/traces" &&
            requestSpans.some((span) => span.name === "openclaw.run")
          ) {
            return { request, spans: requestSpans };
          }
        }
        return undefined;
      }, 15_000);
      // BatchSpanProcessor starts its timer on the first ended span. The first
      // export's earliest end timestamp is the boundary that must observe the clamp.
      const firstRequestEndTimes = sampledInExport.spans.flatMap((span) =>
        span.endTimeMs === undefined ? [] : [span.endTimeMs],
      );
      expect(firstRequestEndTimes.length).toBeGreaterThan(0);
      const firstSpanEndAt = Math.min(...firstRequestEndTimes);
      const exportDelayMs = (sampledInExport.request.receivedAtMs ?? 0) - firstSpanEndAt;
      expect(exportDelayMs).toBeGreaterThanOrEqual(1_000);
      expect(exportDelayMs).toBeLessThan(4_500);
      expect(envOnly.capturedRequests).toHaveLength(0);
    };
    await runOtelTestFixture(context, runProof, async () => {
      await runQaGatewayFixture(
        async () =>
          await settleCleanup(
            async () => await stopQaGatewayFixture(gatewayOwner),
            async () => await mock?.stop(),
            async () => await stopChild(registry),
            async () => await configured.close(),
            async () => await envOnly.close(),
          ),
        async () => await rm(scratch, { recursive: true, force: true }),
      );
    });
  }, 180_000);

  test("keeps installed diagnostic listeners active with a preloaded SDK", async (context) => {
    const { signal } = context;
    const repoRoot = path.resolve(import.meta.dirname, "../../../..");
    const rootPackage = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8")) as {
      devDependencies?: Record<string, string>;
    };
    const sourcePluginPackage = JSON.parse(
      await readFile(path.join(repoRoot, "extensions/diagnostics-otel/package.json"), "utf8"),
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(rootPackage.devDependencies?.["@opentelemetry/sdk-node"]).toBe("0.222.0");
    expect(sourcePluginPackage.dependencies?.["@opentelemetry/sdk-node"]).toBeUndefined();
    expect(sourcePluginPackage.devDependencies?.["@opentelemetry/sdk-node"]).toBeUndefined();
    const scratch = await mkdtemp(path.join(tmpdir(), "openclaw-otel-preloaded-"));
    const receiver = await startReceiver();
    const ignoredConfig = await startReceiver();
    let registry: Awaited<ReturnType<typeof startRegistry>> | undefined;
    let mock: Awaited<ReturnType<typeof startQaMockOpenAiServer>> | undefined;
    const gatewayOwner = createQaGatewayChild();
    let gateway: QaGatewayChild | undefined;
    const runProof = async () => {
      const packed = await copyPackedPlugin(repoRoot, scratch);
      registry = await startRegistry(repoRoot, scratch, packed.tarball, packed.version, signal);
      mock = await startQaMockOpenAiServer();
      const preloadRoot = path.join(scratch, `otel-preload-${randomUUID()}`);
      const preloadModules = path.join(preloadRoot, "node_modules", "@opentelemetry");
      await mkdir(preloadModules, { recursive: true });
      const requireFromSdk = createRequire(
        createRequire(path.join(repoRoot, "package.json")).resolve(
          "@opentelemetry/sdk-node/package.json",
        ),
      );
      // Resolve through the root-owned SDK without relying on dependency hoisting.
      // The installed plugin remains independently packed without sdk-node.
      for (const packageName of ["sdk-node", "exporter-trace-otlp-proto"]) {
        await symlink(
          path.dirname(requireFromSdk.resolve(`@opentelemetry/${packageName}/package.json`)),
          path.join(preloadModules, packageName),
          process.platform === "win32" ? "junction" : "dir",
        );
      }
      const preloadPath = path.join(preloadRoot, "preload.mjs");
      await writeFile(
        preloadPath,
        [
          'import { NodeSDK } from "@opentelemetry/sdk-node";',
          'import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";',
          `const sdk = new NodeSDK({ traceExporter: new OTLPTraceExporter({ url: ${JSON.stringify(`${receiver.baseUrl}/v1/traces`)} }) });`,
          "sdk.start();",
          "globalThis.__openclawQaPreloadedOtelSdk = sdk;",
        ].join("\n"),
      );
      gateway = await startInstallGateway({
        owner: gatewayOwner,
        envTraceEndpoint: receiver.baseUrl,
        mockBaseUrl: mock.baseUrl,
        nodeOptions: `--import=${pathToFileURL(preloadPath).href}`,
        registryBaseUrl: registry.baseUrl,
        repoRoot,
      });
      await installAndConfigure({
        gateway,
        configTraceEndpoint: ignoredConfig.baseUrl,
        packageVersion: packed.version,
      });
      const stateDir = gateway.runtimeEnv.OPENCLAW_STATE_DIR;
      if (!stateDir) {
        throw new Error("qa gateway state directory was not configured");
      }
      const installPath = readPluginInstallRecords({
        stateDir,
        configPath: gateway.configPath,
      })["diagnostics-otel"]?.installPath;
      if (!installPath) {
        throw new Error("diagnostics-otel install path was not recorded");
      }
      const installedPluginPackage = JSON.parse(
        await readFile(path.join(installPath, "package.json"), "utf8"),
      ) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      expect(installedPluginPackage.dependencies?.["@opentelemetry/sdk-node"]).toBeUndefined();
      expect(installedPluginPackage.devDependencies?.["@opentelemetry/sdk-node"]).toBeUndefined();
      expect(gateway.logs()).toContain("diagnostics-otel: using preloaded OpenTelemetry SDK");
      await runTurn(gateway, "OTEL-PRELOADED-INSTALL-OK");
      const runSpan = await waitFor(
        () => receiver.capturedSpans.find((span) => span.name === "openclaw.run"),
        20_000,
      );
      expect(runSpan.traceId).toBeTruthy();
      expect(runSpan.spanId).toBeTruthy();
      expect(ignoredConfig.capturedRequests).toHaveLength(0);
    };
    await runOtelTestFixture(context, runProof, async () => {
      await runQaGatewayFixture(
        async () =>
          await settleCleanup(
            async () => await stopQaGatewayFixture(gatewayOwner),
            async () => await mock?.stop(),
            async () => await stopChild(registry),
            async () => await receiver.close(),
            async () => await ignoredConfig.close(),
          ),
        async () => await rm(scratch, { recursive: true, force: true }),
      );
    });
  }, 180_000);
});
