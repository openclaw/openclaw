import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
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

type InstallPhase =
  | "setup"
  | "scratch"
  | `${"configured" | "environment"}-receiver`
  | `pack-${"copy" | "build" | "npm" | "inspect" | "tarball"}`
  | `${"registry" | "mock"}-start`
  | `gateway-${"pre-listening" | "post-listening" | "ready"}`
  | `cli-${"install" | "disable" | "enable" | "inspect"}`
  | `${"install" | "disabled" | "enabled"}-config`
  | `${"initial" | "sampled-in"}-restart-${"stop" | "read" | "write" | "start" | "ready"}`
  | `${"sampled-out" | "sampled-in"}-${"send" | "wait" | "assert"}`
  | "sampling-window"
  | "export-wait"
  | "export-assert"
  | "cleanup"
  | "complete";
type PhaseObserver = (phase: InstallPhase) => void;
type CleanupEvent = "started" | "fulfilled" | "rejected" | "deadline";
type CleanupObserver = (event: CleanupEvent) => void;
type CleanupState = {
  startedAt: number;
  settledAt?: number;
  outcome: "not-started" | Exclude<CleanupEvent, "deadline">;
  deadline: boolean;
};

function createInstallDiagnostics(context: TestContext) {
  const startedAt = performance.now();
  let phase: InstallPhase = "setup";
  let phaseStartedAt = startedAt;
  let reported = false;
  const milestones: Partial<Record<InstallPhase, number>> = { setup: 0 };
  const cleanups: Record<string, CleanupState> = {};
  const observed: {
    gateway?: QaGatewayChild;
    receivers: Array<Awaited<ReturnType<typeof startReceiver>>>;
  } = { receivers: [] };
  const finiteMs = (value: number | undefined) =>
    value !== undefined && Number.isFinite(value) ? Math.max(0, Math.round(value)) : null;
  const capture = (event: "test-abort" | "body-failed" | "test-failed") => {
    if (reported) {
      return;
    }
    reported = true;
    try {
      const now = performance.now();
      const logs = observed.gateway?.logs().slice(-8_192);
      process.stderr.write(
        `[otel-install-diagnostic] ${JSON.stringify({
          event,
          phase,
          elapsedMs: finiteMs(now - startedAt),
          phaseElapsedMs: finiteMs(now - phaseStartedAt),
          milestones,
          // These are observed milestones, not evidence that a process is still alive.
          gatewayStartReturned: observed.gateway !== undefined,
          gatewayLogFacts:
            logs === undefined
              ? null
              : {
                  startupTraceLines: logs.match(/startup trace:/g)?.length ?? 0,
                  pluginLoadProfileLines: logs.match(/\[plugin-load-profile\]/g)?.length ?? 0,
                  sdkStartFailureObserved: logs.includes("diagnostics-otel: failed to start SDK:"),
                  sdkRollbackFailureObserved: logs.includes(
                    "diagnostics-otel: SDK startup rollback cleanup failed:",
                  ),
                },
          mockRequests: "unavailable",
          mockInflight: "unavailable",
          receivers: observed.receivers.map((receiver) => {
            const receivedAt = receiver.capturedRequests.at(-1)?.receivedAtMs;
            return {
              requests: receiver.capturedRequests.length,
              spans: receiver.capturedSpans.length,
              latestRequestAgeMs: finiteMs(
                receivedAt === undefined ? undefined : Date.now() - receivedAt,
              ),
            };
          }),
          cleanups: Object.fromEntries(
            Object.entries(cleanups).map(([owner, state]) => [
              owner,
              {
                outcome: state.outcome,
                deadline: state.deadline,
                elapsedMs: finiteMs((state.settledAt ?? now) - state.startedAt),
              },
            ]),
          ),
        })}\n`,
      );
    } catch {
      // Observing a failure must never replace it or prevent the existing cleanup.
    }
  };
  const onAbort = () => capture("test-abort");
  context.signal.addEventListener("abort", onAbort, { once: true });
  context.onTestFailed(() => capture("test-failed"));
  context.onTestFinished(() => context.signal.removeEventListener("abort", onAbort));
  return {
    observed,
    capture,
    phase(next: InstallPhase) {
      phase = next;
      phaseStartedAt = performance.now();
      milestones[next] ??= finiteMs(phaseStartedAt - startedAt) ?? 0;
    },
    cleanup(
      owner: "gateway" | "mock" | "registry" | "configured" | "environment" | "scratch",
    ): CleanupObserver {
      const state: CleanupState = {
        startedAt: performance.now(),
        outcome: "not-started",
        deadline: false,
      };
      cleanups[owner] = state;
      return (event) => {
        // The wrapper deadline does not settle the underlying cleanup promise.
        if (event === "deadline") {
          state.deadline = true;
        } else {
          state.outcome = event;
          if (event === "started") {
            state.startedAt = performance.now();
          } else {
            state.settledAt = performance.now();
          }
        }
      };
    },
  };
}

async function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null) {
    return true;
  }
  return await new Promise<boolean>((resolve) => {
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, timeoutMs);
    timer.unref();
    child.once("exit", onExit);
    if (child.exitCode !== null) {
      child.off("exit", onExit);
      clearTimeout(timer);
      resolve(true);
    }
  });
}

async function stopChild(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  if (await waitForChildExit(child, 5_000)) {
    return;
  }
  child.kill("SIGKILL");
  if (!(await waitForChildExit(child, 5_000))) {
    throw new Error("fixture registry did not exit after SIGKILL");
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

async function runCleanup(
  label: string,
  cleanup: () => Promise<void>,
  observe?: CleanupObserver,
  timeoutMs = 30_000,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      observe?.("deadline");
      reject(new Error(`${label} cleanup timed out`));
    }, timeoutMs);
    timer.unref();
    observe?.("started");
    cleanup().then(
      () => {
        observe?.("fulfilled");
        clearTimeout(timer);
        resolve();
      },
      (error: unknown) => {
        observe?.("rejected");
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

async function settleCleanup(
  ...cleanups: Array<
    readonly [label: string, cleanup: () => Promise<void>, observe?: CleanupObserver]
  >
): Promise<void> {
  const results = await Promise.allSettled(
    cleanups.map(async ([label, cleanup, observe]) => await runCleanup(label, cleanup, observe)),
  );
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length > 0) {
    throw new AggregateError(failures, "managed diagnostics-otel cleanup failed");
  }
}

async function packPlugin(repoRoot: string, scratch: string, observe?: PhaseObserver) {
  const outputDir = path.join(scratch, "pack");
  const pluginRoot = path.join(repoRoot, "extensions/diagnostics-otel");
  const stagingDir = path.join(scratch, "package-source");
  observe?.("pack-copy");
  await cp(pluginRoot, stagingDir, {
    recursive: true,
    filter: (source) => {
      const relative = path.relative(pluginRoot, source);
      const topLevel = relative.split(path.sep)[0];
      return topLevel !== "dist" && topLevel !== "node_modules";
    },
  });
  await mkdir(outputDir, { recursive: true });
  observe?.("pack-build");
  await execFileAsync(process.execPath, ["scripts/lib/plugin-npm-runtime-build.mjs", stagingDir], {
    cwd: repoRoot,
    maxBuffer: 16 * 1024 * 1024,
    timeout: 120_000,
  });
  observe?.("pack-npm");
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
  observe?.("pack-inspect");
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

async function startRegistry(repoRoot: string, scratch: string, tarball: string, version: string) {
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
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  try {
    const port = await waitFor(async () => {
      try {
        return (await readFile(portFile, "utf8")).trim() || undefined;
      } catch {
        if (child.exitCode !== null) {
          throw new Error(`fixture npm registry exited early (${child.exitCode})`);
        }
        return undefined;
      }
    });
    return { baseUrl: `http://127.0.0.1:${port}`, child };
  } catch (error) {
    await stopChild(child).catch((stopError: unknown) => {
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

async function runTurn(
  gateway: QaGatewayChild,
  marker: string,
  observe?: (phase: "send" | "wait" | "assert") => void,
) {
  observe?.("send");
  const started = (await gateway.call("chat.send", {
    sessionKey: `agent:qa:${marker.toLowerCase()}`,
    message: `Reply exactly: ${marker}`,
    idempotencyKey: randomUUID(),
  })) as { runId?: string; status?: string };
  expect(started.status).toBe("started");
  expect(started.runId).toBeTruthy();
  observe?.("wait");
  const completed = (await gateway.call(
    "agent.wait",
    { runId: started.runId, timeoutMs: 60_000 },
    { timeoutMs: 65_000 },
  )) as { status?: string };
  observe?.("assert");
  expect(completed.status).toBe("ok");
}

async function restartWithOtelConfig(params: {
  gateway: QaGatewayChild;
  sampleRate: number;
  traceEndpoint: string;
  observe?: (phase: "stop" | "read" | "write" | "start" | "ready") => void;
}) {
  params.observe?.("stop");
  await params.gateway.restartAfterStateMutation(async ({ configPath }) => {
    params.observe?.("read");
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
    params.observe?.("write");
    await writeFile(configPath, `${JSON.stringify(current, null, 2)}\n`);
    params.observe?.("start");
  });
  params.observe?.("ready");
}

// The caller retains the owner before startup and every later installation step.
async function startInstallGateway(params: {
  owner: ReturnType<typeof createQaGatewayChild>;
  envTraceEndpoint: string;
  mockBaseUrl: string;
  nodeOptions?: string;
  registryBaseUrl: string;
  repoRoot: string;
  observe?: PhaseObserver;
}) {
  return await params.owner.start({
    repoRoot: params.repoRoot,
    providerBaseUrl: `${params.mockBaseUrl}/v1`,
    providerMode: "mock-openai",
    transportBaseUrl: "http://127.0.0.1:9",
    controlUiEnabled: false,
    onListening: params.observe ? () => params.observe?.("gateway-post-listening") : undefined,
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
  observe?: PhaseObserver;
}) {
  const { gateway } = params;
  const spec = `npm:${PACKAGE_NAME}@${params.packageVersion}`;
  params.observe?.("cli-install");
  await gateway.runCli(["plugins", "install", spec, "--force", "--accept-capabilities"]);
  params.observe?.("install-config");
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

  params.observe?.("cli-disable");
  await gateway.runCli(["plugins", "disable", "diagnostics-otel"]);
  params.observe?.("disabled-config");
  let config = JSON.parse(await readFile(gateway.configPath, "utf8")) as MutableConfig;
  expect(config.plugins?.entries?.["diagnostics-otel"]?.enabled).toBe(false);
  params.observe?.("cli-enable");
  await gateway.runCli(["plugins", "enable", "diagnostics-otel"]);
  params.observe?.("enabled-config");
  config = JSON.parse(await readFile(gateway.configPath, "utf8")) as MutableConfig;
  expect(config.plugins?.entries?.["diagnostics-otel"]?.enabled).toBe(true);

  await restartWithOtelConfig({
    gateway,
    sampleRate: params.sampleRate ?? 1,
    traceEndpoint: params.configTraceEndpoint,
    observe: params.observe ? (phase) => params.observe?.(`initial-restart-${phase}`) : undefined,
  });
  params.observe?.("cli-inspect");
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

  async function copyPackedPlugin(repoRoot: string, scratch: string, observe?: PhaseObserver) {
    packedPlugin ??= (async () => {
      seedDir = await mkdtemp(path.join(tmpdir(), "openclaw-otel-install-seed-"));
      return await packPlugin(repoRoot, seedDir, observe);
    })();
    const packed = await packedPlugin;
    observe?.("pack-tarball");
    const outputDir = path.join(scratch, "pack");
    await mkdir(outputDir, { recursive: true });
    const tarball = path.join(outputDir, path.basename(packed.tarball));
    await copyFile(packed.tarball, tarball);
    return { tarball, version: packed.version };
  }

  test("installs the exact package and exports with config precedence, sampling, and flush", async (context) => {
    const diagnostics = createInstallDiagnostics(context);
    const observe = diagnostics.phase;
    const repoRoot = path.resolve(import.meta.dirname, "../../../..");
    observe("scratch");
    const scratch = await mkdtemp(path.join(tmpdir(), "openclaw-otel-install-"));
    observe("configured-receiver");
    const configured = await startReceiver();
    diagnostics.observed.receivers.push(configured);
    observe("environment-receiver");
    const envOnly = await startReceiver();
    diagnostics.observed.receivers.push(envOnly);
    let registry: Awaited<ReturnType<typeof startRegistry>> | undefined;
    let mock: Awaited<ReturnType<typeof startQaMockOpenAiServer>> | undefined;
    const gatewayOwner = createQaGatewayChild();
    let gateway: QaGatewayChild | undefined;
    const runProof = async () => {
      try {
        observe("pack-copy");
        const packed = await copyPackedPlugin(repoRoot, scratch, observe);
        observe("registry-start");
        registry = await startRegistry(repoRoot, scratch, packed.tarball, packed.version);
        observe("mock-start");
        mock = await startQaMockOpenAiServer();
        observe("gateway-pre-listening");
        gateway = await startInstallGateway({
          owner: gatewayOwner,
          envTraceEndpoint: envOnly.baseUrl,
          mockBaseUrl: mock.baseUrl,
          registryBaseUrl: registry.baseUrl,
          repoRoot,
          observe,
        });
        diagnostics.observed.gateway = gateway;
        observe("gateway-ready");
        await installAndConfigure({
          gateway,
          configTraceEndpoint: configured.baseUrl,
          packageVersion: packed.version,
          sampleRate: 0,
          observe,
        });
        await runTurn(gateway, "OTEL-MANAGED-SAMPLED-OUT", (phase) =>
          observe(`sampled-out-${phase}`),
        );
        observe("sampling-window");
        await sleep(1_500);
        expect(configured.capturedRequests).toHaveLength(0);
        expect(envOnly.capturedRequests).toHaveLength(0);

        await restartWithOtelConfig({
          gateway,
          sampleRate: 1,
          traceEndpoint: configured.baseUrl,
          observe: (phase) => observe(`sampled-in-restart-${phase}`),
        });
        const sampledInRequestCursor = configured.capturedRequests.length;
        const sampledInSpanCursor = configured.capturedSpans.length;
        await runTurn(gateway, "OTEL-MANAGED-INSTALL-OK", (phase) =>
          observe(`sampled-in-${phase}`),
        );
        observe("export-wait");
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
        observe("export-assert");
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
      } catch (error) {
        diagnostics.capture("body-failed");
        throw error;
      }
    };
    await runQaGatewayFixture(runProof, async () => {
      observe("cleanup");
      await settleCleanup(
        [
          "gateway",
          async () => await stopQaGatewayFixture(gatewayOwner),
          diagnostics.cleanup("gateway"),
        ],
        ["mock provider", async () => await mock?.stop(), diagnostics.cleanup("mock")],
        [
          "fixture registry",
          async () => await stopChild(registry?.child),
          diagnostics.cleanup("registry"),
        ],
        [
          "configured receiver",
          async () => await configured.close(),
          diagnostics.cleanup("configured"),
        ],
        [
          "environment receiver",
          async () => await envOnly.close(),
          diagnostics.cleanup("environment"),
        ],
        [
          "scratch directory",
          async () => await rm(scratch, { recursive: true, force: true }),
          diagnostics.cleanup("scratch"),
        ],
      );
    });
    observe("complete");
  }, 180_000);

  test("keeps installed diagnostic listeners active with a preloaded SDK", async () => {
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
    expect(rootPackage.devDependencies?.["@opentelemetry/sdk-node"]).toBe("0.221.0");
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
      registry = await startRegistry(repoRoot, scratch, packed.tarball, packed.version);
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
    await runQaGatewayFixture(runProof, async () => {
      await settleCleanup(
        ["gateway", async () => await stopQaGatewayFixture(gatewayOwner)],
        ["mock provider", async () => await mock?.stop()],
        ["fixture registry", async () => await stopChild(registry?.child)],
        ["preloaded receiver", async () => await receiver.close()],
        ["ignored config receiver", async () => await ignoredConfig.close()],
        ["scratch directory", async () => await rm(scratch, { recursive: true, force: true })],
      );
    });
  }, 180_000);
});
