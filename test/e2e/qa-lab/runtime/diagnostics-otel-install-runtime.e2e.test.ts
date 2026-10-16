import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
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
import type { OpenClawConfig } from "../../../../src/config/types.openclaw.js";
import { awaitGateBeforeSettlement, withinTest } from "../../../helpers/promise.js";
import { runQaGatewayFixture, stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import { startLocalOtlpReceiver } from "./otel-test-support.js";

const execFileAsync = promisify(execFile);
const PACKAGE_NAME = "@openclaw/diagnostics-otel";
const repoRoot = path.resolve(import.meta.dirname, "../../../..");
type PackageManifest = {
  version?: unknown;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};
async function readPackage(directory: string): Promise<PackageManifest> {
  return JSON.parse(await fs.readFile(path.join(directory, "package.json"), "utf8"));
}
function expectNoBundledSdk(pkg: PackageManifest) {
  expect(pkg.dependencies?.["@opentelemetry/sdk-node"]).toBeUndefined();
  expect(pkg.devDependencies?.["@opentelemetry/sdk-node"]).toBeUndefined();
}

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
  return { ...receiver, baseUrl: `http://127.0.0.1:${await receiver.listen()}` };
}

async function settleCleanup(...cleanups: Array<() => Promise<void>>): Promise<void> {
  const results = await Promise.allSettled(cleanups.map((cleanup) => cleanup()));
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length > 0) {
    throw new AggregateError(failures, "managed diagnostics-otel cleanup failed");
  }
}

async function packPlugin(scratch: string) {
  const outputDir = path.join(scratch, "pack");
  const pluginRoot = path.join(repoRoot, "extensions/diagnostics-otel");
  const stagingDir = path.join(scratch, "package-source");
  await fs.cp(pluginRoot, stagingDir, {
    recursive: true,
    filter: (source) => {
      const relative = path.relative(pluginRoot, source);
      const topLevel = relative.split(path.sep)[0];
      return topLevel !== "dist" && topLevel !== "node_modules";
    },
  });
  await fs.mkdir(outputDir, { recursive: true });
  const options = { cwd: repoRoot, maxBuffer: 16 * 1024 * 1024, timeout: 120_000 };
  await execFileAsync(
    process.execPath,
    ["scripts/lib/plugin-npm-runtime-build.mjs", stagingDir],
    options,
  );
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
      ...options,
      env: { ...process.env, OPENCLAW_PLUGIN_NPM_BUNDLE_DEPENDENCIES: "1" },
    },
  );
  const tarballName = (await fs.readdir(outputDir)).find((name) => name.endsWith(".tgz"));
  if (!tarballName) {
    throw new Error("diagnostics-otel pack did not produce a tarball");
  }
  const manifest = await readPackage(stagingDir);
  if (typeof manifest.version !== "string" || !manifest.version.trim()) {
    throw new Error("diagnostics-otel package version is missing");
  }
  return {
    tarball: path.join(outputDir, tarballName),
    version: manifest.version.trim(),
  };
}

async function startRegistry(
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
        { cause: error },
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

async function restartWithOtelConfig(
  gateway: QaGatewayChild,
  traceEndpoint: string,
  sampleRate: number,
) {
  await gateway.restartAfterStateMutation(async ({ configPath }) => {
    const current = JSON.parse(await fs.readFile(configPath, "utf8")) as OpenClawConfig;
    current.diagnostics = {
      enabled: true,
      otel: {
        enabled: true,
        protocol: "http/protobuf",
        traces: true,
        metrics: false,
        logs: false,
        tracesEndpoint: `${traceEndpoint}/v1/traces`,
        sampleRate,
        flushIntervalMs: 250,
        captureContent: false,
      },
    };
    await fs.writeFile(configPath, `${JSON.stringify(current, null, 2)}\n`);
  });
}

function readInstallRecord(gateway: QaGatewayChild) {
  const stateDir = gateway.runtimeEnv.OPENCLAW_STATE_DIR;
  if (!stateDir) {
    throw new Error("qa gateway state directory was not configured");
  }
  return readPluginInstallRecords({ stateDir, configPath: gateway.configPath })["diagnostics-otel"];
}

async function installAndConfigure(
  gateway: QaGatewayChild,
  traceEndpoint: string,
  version: string,
  sampleRate: number,
) {
  const spec = `npm:${PACKAGE_NAME}@${version}`;
  await gateway.runCli(["plugins", "install", spec, "--force", "--accept-capabilities"]);
  expect(readInstallRecord(gateway)).toMatchObject({
    source: "npm",
    spec: `${PACKAGE_NAME}@${version}`,
    version,
    resolvedName: PACKAGE_NAME,
    resolvedVersion: version,
    installPath: expect.stringContaining("diagnostics-otel"),
    integrity: expect.stringMatching(/^sha512-/u),
  });

  await gateway.runCli(["plugins", "disable", "diagnostics-otel"]);
  let config = JSON.parse(await fs.readFile(gateway.configPath, "utf8")) as OpenClawConfig;
  expect(config.plugins?.entries?.["diagnostics-otel"]?.enabled).toBe(false);
  await gateway.runCli(["plugins", "enable", "diagnostics-otel"]);
  config = JSON.parse(await fs.readFile(gateway.configPath, "utf8")) as OpenClawConfig;
  expect(config.plugins?.entries?.["diagnostics-otel"]?.enabled).toBe(true);

  await restartWithOtelConfig(gateway, traceEndpoint, sampleRate);
  const inspect = JSON.parse(
    await gateway.runCli(["plugins", "inspect", "diagnostics-otel", "--runtime", "--json"]),
  ) as { plugin?: { enabled?: boolean; id?: string; status?: string } };
  expect(inspect.plugin).toMatchObject({ enabled: true, id: "diagnostics-otel", status: "loaded" });
}

describe("managed diagnostics-otel install runtime", () => {
  let seedDir: string | undefined;
  let packedPlugin: ReturnType<typeof packPlugin> | undefined;

  afterAll(async () => {
    await runQaGatewayFixture(
      async () => await packedPlugin,
      async () => {
        if (seedDir) {
          await fs.rm(seedDir, { recursive: true, force: true });
        }
      },
    );
  });

  async function getPackedPlugin() {
    packedPlugin ??= (async () => {
      seedDir = await fs.mkdtemp(path.join(tmpdir(), "openclaw-otel-install-seed-"));
      return await packPlugin(seedDir);
    })();
    // Each registry reads the seed into memory; suite teardown joins every body before removing it.
    return await packedPlugin;
  }

  async function createInstallFixture(context: TestContext) {
    const scratch = await fs.mkdtemp(path.join(tmpdir(), "openclaw-otel-install-"));
    const configured = await startReceiver();
    const environment = await startReceiver();
    let registry: Awaited<ReturnType<typeof startRegistry>> | undefined;
    let mock: Awaited<ReturnType<typeof startQaMockOpenAiServer>> | undefined;
    const owner = createQaGatewayChild();
    return {
      scratch,
      configured,
      environment,
      async start(sampleRate: number, nodeOptions?: string) {
        const packed = await getPackedPlugin();
        const registryServer = (registry = await startRegistry(
          scratch,
          packed.tarball,
          packed.version,
          context.signal,
        ));
        const mockServer = (mock = await startQaMockOpenAiServer());
        const gateway = await owner.start({
          repoRoot,
          providerBaseUrl: `${mockServer.baseUrl}/v1`,
          providerMode: "mock-openai",
          transportBaseUrl: "http://127.0.0.1:9",
          controlUiEnabled: false,
          mutateConfig: (cfg) => ({
            ...cfg,
            plugins: {
              ...cfg.plugins,
              allow: [],
              slots: { ...cfg.plugins?.slots, memory: "none" },
              entries: {},
            },
          }),
          runtimeEnvPatch: {
            NPM_CONFIG_REGISTRY: registryServer.baseUrl,
            OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
            OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `${environment.baseUrl}/v1/traces`,
            ...(nodeOptions ? { NODE_OPTIONS: nodeOptions, OPENCLAW_OTEL_PRELOADED: "1" } : {}),
          },
        });
        await installAndConfigure(gateway, configured.baseUrl, packed.version, sampleRate);
        return gateway;
      },
      async close() {
        await runQaGatewayFixture(
          () =>
            settleCleanup(
              async () => await stopQaGatewayFixture(owner),
              async () => await mock?.stop(),
              async () => await stopChild(registry),
              async () => await configured.close(),
              async () => await environment.close(),
            ),
          () => fs.rm(scratch, { recursive: true, force: true }),
        );
      },
    };
  }

  async function withInstallFixture(
    context: TestContext,
    body: (fixture: Awaited<ReturnType<typeof createInstallFixture>>) => Promise<void>,
  ) {
    const fixture = await createInstallFixture(context);
    let closing: Promise<void> | undefined;
    const close = () => (closing ??= fixture.close());
    const completed = runQaGatewayFixture(async () => {
      context.signal.throwIfAborted();
      await body(fixture);
    }, close);
    // Join the original body even when Vitest cancels its wrapper, before deleting the seed.
    context.onTestFinished(async () => {
      await completed.catch(() => {});
      await close();
    });
    await completed;
  }

  test("installs the exact package and exports with config precedence, sampling, and flush", async (context) => {
    await withInstallFixture(context, async ({ configured, environment, start }) => {
      const gateway = await start(0);
      await runTurn(gateway, "OTEL-MANAGED-SAMPLED-OUT");
      await sleep(1_500);
      expect(configured.capturedRequests).toHaveLength(0);
      expect(environment.capturedRequests).toHaveLength(0);

      await restartWithOtelConfig(gateway, configured.baseUrl, 1);
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
      expect(environment.capturedRequests).toHaveLength(0);
    });
  }, 180_000);

  test("keeps installed diagnostic listeners active with a preloaded SDK", async (context) => {
    const rootPackage = await readPackage(repoRoot);
    expect(rootPackage.devDependencies?.["@opentelemetry/sdk-node"]).toBe("0.223.0");
    expectNoBundledSdk(await readPackage(path.join(repoRoot, "extensions/diagnostics-otel")));
    await withInstallFixture(context, async ({ scratch, configured, environment, start }) => {
      const preloadRoot = path.join(scratch, `otel-preload-${randomUUID()}`);
      const preloadModules = path.join(preloadRoot, "node_modules", "@opentelemetry");
      await fs.mkdir(preloadModules, { recursive: true });
      const requireFromSdk = createRequire(
        createRequire(path.join(repoRoot, "package.json")).resolve(
          "@opentelemetry/sdk-node/package.json",
        ),
      );
      // Resolve through the root-owned SDK without relying on dependency hoisting.
      // The installed plugin remains independently packed without sdk-node.
      for (const packageName of ["sdk-node", "exporter-trace-otlp-proto"]) {
        await fs.symlink(
          path.dirname(requireFromSdk.resolve(`@opentelemetry/${packageName}/package.json`)),
          path.join(preloadModules, packageName),
          process.platform === "win32" ? "junction" : "dir",
        );
      }
      const preloadPath = path.join(preloadRoot, "preload.mjs");
      await fs.writeFile(
        preloadPath,
        [
          'import { NodeSDK } from "@opentelemetry/sdk-node";',
          'import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";',
          `const sdk = new NodeSDK({ traceExporter: new OTLPTraceExporter({ url: ${JSON.stringify(`${environment.baseUrl}/v1/traces`)} }) });`,
          "sdk.start();",
          "globalThis.__openclawQaPreloadedOtelSdk = sdk;",
        ].join("\n"),
      );
      const gateway = await start(1, `--import=${pathToFileURL(preloadPath).href}`);
      const installPath = readInstallRecord(gateway)?.installPath;
      if (!installPath) {
        throw new Error("diagnostics-otel install path was not recorded");
      }
      expectNoBundledSdk(await readPackage(installPath));
      expect(gateway.logs()).toContain("diagnostics-otel: using preloaded OpenTelemetry SDK");
      await runTurn(gateway, "OTEL-PRELOADED-INSTALL-OK");
      const runSpan = await waitFor(
        () => environment.capturedSpans.find((span) => span.name === "openclaw.run"),
        20_000,
      );
      expect(runSpan.traceId).toBeTruthy();
      expect(runSpan.spanId).toBeTruthy();
      expect(configured.capturedRequests).toHaveLength(0);
    });
  }, 180_000);
});
