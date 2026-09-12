// QA evidence for the real Gateway TLS listener and public client pinning boundary.
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import tls from "node:tls";
import { pathToFileURL } from "node:url";
import { GatewayClient, GatewayClientRequestError } from "@openclaw/gateway-client";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  QA_EVIDENCE_FILENAME,
  type QaEvidenceSummaryJson,
} from "../../../../extensions/qa-lab/api.js";
import { normalizeTlsFingerprint } from "../../../../packages/gateway-client/src/client-address-utils.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../../../../src/config/config.js";
import { createConfiguredGatewayLocalProbe } from "../../../../src/gateway/local-http-probe.js";
import { startGatewayServer } from "../../../../src/gateway/server.js";
import { GATEWAY_STARTUP_MUTATED_ENV_KEYS } from "../../../../src/gateway/test-helpers.env.js";
import { formatErrorMessage } from "../../../../src/infra/errors.js";
import { loadGatewayTlsServerRuntime } from "../../../../src/infra/tls/gateway.js";
import { flushLogger, resetLogger } from "../../../../src/logging/logger.js";
import { createDeferred } from "../../../helpers/promise.js";
import { createQaScriptEvidenceWriter } from "./script-evidence.js";

const SCENARIO_ID = "gateway-tls-pinning";
const SOURCE_PATH = "qa/scenarios/runtime/gateway-tls-pinning.yaml";
const DISCOVERY_PLUGIN_ID = "tls-discovery-proof";
const CONNECTION_TIMEOUT_MS = 15_000;
const ENV_KEYS = [
  "HOME",
  ...GATEWAY_STARTUP_MUTATED_ENV_KEYS,
  "NODE_ENV",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_BUNDLED_PLUGINS_DIR",
  "OPENCLAW_DISABLE_BONJOUR",
  "OPENCLAW_DISABLE_BUNDLED_PLUGINS",
  "OPENCLAW_TEST_MINIMAL_GATEWAY",
  "OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR",
  "OPENCLAW_SKIP_BROWSER_CONTROL_SERVER",
  "OPENCLAW_SKIP_CANVAS_HOST",
  "OPENCLAW_SKIP_CHANNELS",
  "OPENCLAW_SKIP_CRON",
  "OPENCLAW_SKIP_GMAIL_WATCHER",
  "OPENCLAW_SKIP_PROVIDERS",
  "VITEST",
] as const;

type ProducerOptions = {
  artifactBase: string;
  repoRoot: string;
};

export type GatewayTlsPinningProof = {
  advertisedFingerprint: string;
  cleartextMismatch: string;
  healthResponded: boolean;
  peerFingerprint: string;
  wrongPinFailure: string;
  wrongPinHelloObserved: boolean;
  renewedFingerprint: string;
  retainedConnection: boolean;
  siblingListeners: number;
  rejectedPartialRenewal: boolean;
  reloadOffPreservedCertificate: boolean;
  symlinkRenewal: boolean;
};

function parseOptions(argv: readonly string[]): ProducerOptions {
  const readValue = (name: string) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const artifactBase = readValue("--artifact-base");
  if (!artifactBase) {
    throw new Error("--artifact-base is required");
  }
  return {
    artifactBase: path.resolve(artifactBase),
    repoRoot: path.resolve(readValue("--repo-root") ?? process.cwd()),
  };
}

function captureEnvironment() {
  const snapshot = new Map<string, string | undefined>(
    ENV_KEYS.map((key) => [key, process.env[key]]),
  );
  return () => {
    for (const [key, value] of snapshot) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
}

async function writeDiscoveryProbePlugin(
  pluginDir: string,
  advertisementPath: string,
): Promise<void> {
  await fs.mkdir(pluginDir, { recursive: true });
  await Promise.all([
    fs.writeFile(
      path.join(pluginDir, "openclaw.plugin.json"),
      `${JSON.stringify(
        {
          id: DISCOVERY_PLUGIN_ID,
          activation: { onStartup: true },
          configSchema: {
            type: "object",
            additionalProperties: false,
            properties: {},
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    ),
    fs.writeFile(
      path.join(pluginDir, "index.cjs"),
      `const fs = require("node:fs");
module.exports = {
  id: ${JSON.stringify(DISCOVERY_PLUGIN_ID)},
  register(api) {
    api.registerGatewayMethod("tls-discovery-proof.inspect", async ({ params, context, respond }) => {
      const portal = params.portal ? await context.portalService.open({ targetPort: params.portal }) : undefined;
      const sandboxPort = params.sandbox ? await context.ensureSandboxHostPort() : undefined;
      respond(true, { fingerprint: context.gatewayTlsFingerprint, portalPort: portal?.listenPort, sandboxPort });
    }, { scope: "operator.admin" });
    api.registerGatewayDiscoveryService({
      id: ${JSON.stringify(DISCOVERY_PLUGIN_ID)},
      advertise(context) {
        fs.writeFileSync(${JSON.stringify(advertisementPath)}, JSON.stringify(context), "utf8");
      },
    });
  },
};
`,
      "utf8",
    ),
  ]);
}

async function readAdvertisedFingerprint(advertisementPath: string): Promise<string> {
  const advertisement: unknown = JSON.parse(await fs.readFile(advertisementPath, "utf8"));
  if (!isRecord(advertisement) || advertisement.gatewayTlsEnabled !== true) {
    throw new Error("Gateway discovery publisher did not advertise TLS");
  }
  const fingerprint = advertisement.gatewayTlsFingerprintSha256;
  if (typeof fingerprint !== "string") {
    throw new Error("Gateway discovery publisher did not advertise a TLS fingerprint");
  }
  const normalized = normalizeTlsFingerprint(fingerprint);
  if (!normalized) {
    throw new Error("Gateway discovery publisher advertised an invalid TLS fingerprint");
  }
  return normalized;
}

async function getFreePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("failed to allocate a loopback port");
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

async function waitForPeerFingerprint(port: number): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const socket = tls.connect({
      host: "127.0.0.1",
      minVersion: "TLSv1.3",
      port,
      rejectUnauthorized: false,
    });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("timed out reading Gateway TLS peer certificate"));
    }, CONNECTION_TIMEOUT_MS);
    timer.unref?.();
    const cleanup = () => clearTimeout(timer);
    socket.once("secureConnect", () => {
      const fingerprint = normalizeTlsFingerprint(socket.getPeerCertificate().fingerprint256 ?? "");
      cleanup();
      socket.end();
      if (!fingerprint) {
        reject(new Error("Gateway peer certificate did not expose a SHA-256 fingerprint"));
        return;
      }
      resolve(fingerprint);
    });
    socket.once("error", (error) => {
      cleanup();
      reject(error);
    });
  });
}

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${CONNECTION_TIMEOUT_MS}ms`)),
      CONNECTION_TIMEOUT_MS,
    );
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

async function withExactPin<T>(
  url: string,
  tlsFingerprint: string,
  run: (client: GatewayClient) => Promise<T>,
): Promise<T> {
  const hello = createDeferred<void>();
  let hellos = 0;
  let closes = 0;
  const client = new GatewayClient({
    url,
    tlsFingerprint,
    onConnectError: hello.reject,
    onHelloOk: () => {
      hellos += 1;
      hello.resolve();
    },
    onClose: () => {
      closes += 1;
    },
  });
  try {
    client.start();
    await withTimeout(hello.promise, "Gateway exact-pin hello");
    const result = await run(client);
    if (hellos !== 1 || closes !== 0) {
      throw new Error("TLS renewal replaced the retained Gateway connection");
    }
    return result;
  } finally {
    await client.stopAndWait().catch(() => undefined);
  }
}

async function waitForRenewalFact<T>(
  read: () => Promise<T | undefined>,
  label: string,
): Promise<T> {
  const deadline = Date.now() + CONNECTION_TIMEOUT_MS;
  do {
    const value = await read();
    if (value !== undefined) return value;
    await delay(100);
  } while (Date.now() < deadline);
  throw new Error(`TLS renewal proof did not observe ${label}`);
}

async function connectWithWrongPin(
  url: string,
  tlsFingerprint: string,
): Promise<{ error: string; helloObserved: boolean }> {
  const failure = createDeferred<Error>();
  let helloObserved = false;
  const client = new GatewayClient({
    url,
    tlsFingerprint,
    onConnectError: (error) => {
      client.stop();
      failure.resolve(error);
    },
    onHelloOk: () => {
      helloObserved = true;
    },
  });
  try {
    client.start();
    const error = await withTimeout(failure.promise, "Gateway wrong-pin failure");
    if (!/fingerprint mismatch/iu.test(error.message)) {
      throw new Error(`wrong pin failed for an unexpected reason: ${error.message}`);
    }
    if (helloObserved) {
      throw new Error("wrong TLS pin reached Gateway hello");
    }
    return { error: error.message, helloObserved };
  } finally {
    await client.stopAndWait().catch(() => undefined);
  }
}

async function proveCleartextMismatch(port: number, tlsFingerprint: string): Promise<string> {
  const failure = createDeferred<Error>();
  const client = new GatewayClient({
    url: `ws://127.0.0.1:${port}`,
    tlsFingerprint,
    onConnectError: failure.resolve,
  });
  try {
    client.start();
    const error = await withTimeout(failure.promise, "Gateway plaintext pin policy");
    if (!/fingerprint requires wss:\/\//iu.test(error.message)) {
      throw new Error(`plaintext mismatch failed for an unexpected reason: ${error.message}`);
    }
    return error.message;
  } finally {
    await client.stopAndWait().catch(() => undefined);
  }
}

export async function runGatewayTlsPinningProof(): Promise<GatewayTlsPinningProof> {
  const restoreEnvironment = captureEnvironment();
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gateway-tls-pinning-"));
  const stateDir = path.join(runtimeRoot, "state");
  const configPath = path.join(stateDir, "openclaw.json");
  const certPath = path.join(runtimeRoot, "tls", "gateway-cert.pem");
  const keyPath = path.join(runtimeRoot, "tls", "gateway-key.pem");
  const pluginDir = path.join(runtimeRoot, "discovery-plugin");
  const advertisementPath = path.join(runtimeRoot, "gateway-discovery-advertisement.json");
  const gatewayLogPath = path.join(runtimeRoot, "gateway.log");
  // Windows symlink creation requires host privileges unrelated to Gateway TLS.
  const symlinkRenewal = process.platform !== "win32";
  let server: Awaited<ReturnType<typeof startGatewayServer>> | undefined;

  try {
    process.env.HOME = runtimeRoot;
    process.env.OPENCLAW_CONFIG_PATH = configPath;
    process.env.OPENCLAW_STATE_DIR = stateDir;
    delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
    process.env.OPENCLAW_DISABLE_BUNDLED_PLUGINS = "1";
    delete process.env.OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR;
    delete process.env.OPENCLAW_TEST_MINIMAL_GATEWAY;
    process.env.OPENCLAW_SKIP_BROWSER_CONTROL_SERVER = "1";
    process.env.OPENCLAW_SKIP_CANVAS_HOST = "1";
    process.env.OPENCLAW_SKIP_CHANNELS = "1";
    process.env.OPENCLAW_SKIP_CRON = "1";
    process.env.OPENCLAW_SKIP_GMAIL_WATCHER = "1";
    process.env.OPENCLAW_SKIP_PROVIDERS = "1";
    delete process.env.NODE_ENV;
    delete process.env.OPENCLAW_DISABLE_BONJOUR;
    delete process.env.VITEST;
    await writeDiscoveryProbePlugin(pluginDir, advertisementPath);

    const preparedTls = await loadGatewayTlsServerRuntime({
      enabled: true,
      autoGenerate: true,
      certPath: symlinkRenewal ? path.join(runtimeRoot, "initial", "cert.pem") : certPath,
      keyPath: symlinkRenewal ? path.join(runtimeRoot, "initial", "key.pem") : keyPath,
    });
    if (
      !preparedTls.enabled ||
      !preparedTls.fingerprintSha256 ||
      !preparedTls.certPath ||
      !preparedTls.keyPath
    ) {
      throw new Error(preparedTls.error ?? "Gateway TLS runtime did not expose a fingerprint");
    }
    if (symlinkRenewal) {
      await fs.mkdir(path.dirname(certPath), { recursive: true });
      await fs.symlink(preparedTls.certPath, certPath);
      await fs.symlink(preparedTls.keyPath, keyPath);
    }
    await fs.mkdir(stateDir, { recursive: true });
    await fs.writeFile(
      configPath,
      `${JSON.stringify(
        {
          logging: { file: gatewayLogPath, level: "info" },
          agents: { defaults: { model: { primary: "openai/gpt-5.6-luna" } } },
          gateway: {
            auth: { mode: "none" },
            bind: "loopback",
            controlUi: { enabled: false },
            tls: { enabled: true, autoGenerate: false, certPath, keyPath },
          },
          plugins: {
            enabled: true,
            allow: [DISCOVERY_PLUGIN_ID],
            load: { paths: [pluginDir] },
            entries: {
              [DISCOVERY_PLUGIN_ID]: { enabled: true },
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    clearConfigCache();
    clearRuntimeConfigSnapshot();

    const port = await getFreePort();
    server = await startGatewayServer(port, {
      auth: { mode: "none" },
      bind: "loopback",
      controlUiEnabled: false,
      sidecarStartup: "defer",
    });
    const url = `wss://127.0.0.1:${port}`;
    const localProbe = createConfiguredGatewayLocalProbe({
      gateway: { tls: { enabled: true, certPath, keyPath } },
    });
    const probeHealth = () =>
      localProbe.requestHttp({
        host: "127.0.0.1",
        port,
        pathname: "/healthz",
        timeoutMs: 1000,
      });
    if ((await probeHealth())?.statusCode !== 200) {
      throw new Error("Initial local TLS health probe failed");
    }
    const advertisedFingerprint = await readAdvertisedFingerprint(advertisementPath);
    const peerFingerprint = await waitForPeerFingerprint(port);
    if (peerFingerprint !== advertisedFingerprint) {
      throw new Error("Gateway advertised TLS fingerprint did not match the live peer certificate");
    }

    const replacement = await loadGatewayTlsServerRuntime({
      enabled: true,
      certPath: path.join(runtimeRoot, "replacement", "cert.pem"),
      keyPath: path.join(runtimeRoot, "replacement", "key.pem"),
    });
    if (!replacement.enabled || !replacement.certPath || !replacement.keyPath) {
      throw new Error(replacement.error ?? "Failed to prepare renewal certificate");
    }
    const nextCert = await fs.readFile(replacement.certPath);
    const nextKey = await fs.readFile(replacement.keyPath);
    const renewal = await withExactPin(url, advertisedFingerprint, async (client) => {
      const inspect = (params: { portal?: number; sandbox?: boolean } = {}) =>
        client.request<{ fingerprint: string; portalPort?: number; sandboxPort?: number }>(
          "tls-discovery-proof.inspect",
          params,
        );
      const existing = await inspect({ portal: await getFreePort() });
      if (!existing.portalPort || existing.fingerprint !== advertisedFingerprint) {
        throw new Error("Initial portal or enrollment fingerprint is missing");
      }
      await fs.writeFile(certPath, nextCert);
      await waitForRenewalFact(async () => {
        const log = await fs.readFile(gatewayLogPath, "utf8");
        return log.includes("TLS renewal failed; keeping accepted material") ? true : undefined;
      }, "rejection of the incomplete cert/key replacement");
      for (const listener of [port, existing.portalPort]) {
        if ((await waitForPeerFingerprint(listener)) !== advertisedFingerprint) {
          throw new Error("An incomplete renewal changed an accepted TLS listener");
        }
      }
      if (
        (await inspect()).fingerprint !== advertisedFingerprint ||
        (await readAdvertisedFingerprint(advertisementPath)) !== advertisedFingerprint
      ) {
        throw new Error("An incomplete renewal changed enrollment or discovery");
      }
      await fs.writeFile(keyPath, nextKey);
      const renewedFingerprint = await waitForRenewalFact(async () => {
        const fingerprint = await waitForPeerFingerprint(port);
        return fingerprint === replacement.fingerprintSha256 ? fingerprint : undefined;
      }, "the renewed listener certificate");
      await waitForRenewalFact(
        async () =>
          (await readAdvertisedFingerprint(advertisementPath)) === renewedFingerprint
            ? true
            : undefined,
        "the renewed discovery advertisement",
      );
      const later = await inspect({ portal: await getFreePort(), sandbox: true });
      if (!later.portalPort || !later.sandboxPort || later.fingerprint !== renewedFingerprint) {
        throw new Error("Renewal left stale enrollment or future listener material");
      }
      for (const listener of [existing.portalPort, later.portalPort, later.sandboxPort]) {
        if ((await waitForPeerFingerprint(listener)) !== renewedFingerprint) {
          throw new Error("A sibling TLS listener kept the old certificate");
        }
      }
      const setReloadMode = async (mode: "hybrid" | "off") => {
        const snapshot = await client.request<{ hash: string }>("config.get", {});
        try {
          await client.request("config.patch", {
            baseHash: snapshot.hash,
            raw: JSON.stringify({ gateway: { reload: { mode } } }),
          });
        } catch (error) {
          // Off is persisted source policy; the RPC correctly reports no runtime apply.
          if (
            mode !== "off" ||
            !(error instanceof GatewayClientRequestError) ||
            error.code !== "UNAVAILABLE" ||
            !error.message.includes("persisted but was not applied")
          ) {
            throw error;
          }
        }
      };
      const nextPair = await loadGatewayTlsServerRuntime({
        enabled: true,
        certPath: path.join(runtimeRoot, "paused", "cert.pem"),
        keyPath: path.join(runtimeRoot, "paused", "key.pem"),
      });
      if (!nextPair.enabled || !nextPair.certPath || !nextPair.keyPath) {
        throw new Error(nextPair.error ?? "Failed to prepare paused renewal");
      }
      await setReloadMode("off");
      await waitForRenewalFact(
        async () =>
          (await fs.readFile(gatewayLogPath, "utf8")).includes("TLS renewal deferred")
            ? true
            : undefined,
        "accepted reload-off policy",
      );
      await flushLogger();
      const pausedLogSize = (await fs.readFile(gatewayLogPath)).length;
      await fs.copyFile(nextPair.certPath, certPath);
      await fs.copyFile(nextPair.keyPath, keyPath);
      await waitForRenewalFact(async () => {
        const laterLog = (await fs.readFile(gatewayLogPath)).subarray(pausedLogSize).toString();
        return laterLog.includes("TLS renewal deferred") ? true : undefined;
      }, "the paused owner's certificate observation");
      if ((await waitForPeerFingerprint(port)) !== renewedFingerprint) {
        throw new Error("TLS certificate changed while automatic reload was off");
      }
      await setReloadMode("hybrid");
      const resumedFingerprint = await waitForRenewalFact(async () => {
        const fingerprint = await waitForPeerFingerprint(port);
        return fingerprint === nextPair.fingerprintSha256 ? fingerprint : undefined;
      }, "renewal on re-enable without another certificate write");
      for (const listener of [existing.portalPort, later.portalPort, later.sandboxPort]) {
        if ((await waitForPeerFingerprint(listener)) !== resumedFingerprint) {
          throw new Error("An existing HTTPS sibling missed the resumed renewal");
        }
      }
      await waitForRenewalFact(
        async () =>
          (await readAdvertisedFingerprint(advertisementPath)) === resumedFingerprint
            ? true
            : undefined,
        "the resumed discovery fingerprint",
      );
      let finalFingerprint = resumedFingerprint;
      if (symlinkRenewal) {
        const retargeted = await loadGatewayTlsServerRuntime({
          enabled: true,
          certPath: path.join(runtimeRoot, "retargeted", "cert.pem"),
          keyPath: path.join(runtimeRoot, "retargeted", "key.pem"),
        });
        if (!retargeted.enabled || !retargeted.certPath || !retargeted.keyPath) {
          throw new Error(retargeted.error ?? "Failed to prepare symlink renewal");
        }
        await fs.symlink(retargeted.certPath, `${certPath}.next`);
        await fs.symlink(retargeted.keyPath, `${keyPath}.next`);
        // Retain the old target files, as certificate managers do across renewals.
        await fs.rename(`${certPath}.next`, certPath);
        await fs.rename(`${keyPath}.next`, keyPath);
        finalFingerprint = await waitForRenewalFact(async () => {
          const fingerprint = await waitForPeerFingerprint(port);
          return fingerprint === retargeted.fingerprintSha256 ? fingerprint : undefined;
        }, "the certificate after atomic symlink retargeting");
        for (const listener of [existing.portalPort, later.portalPort, later.sandboxPort]) {
          if ((await waitForPeerFingerprint(listener)) !== finalFingerprint) {
            throw new Error("An HTTPS sibling missed symlink renewal");
          }
        }
        await waitForRenewalFact(
          async () =>
            (await readAdvertisedFingerprint(advertisementPath)) === finalFingerprint
              ? true
              : undefined,
          "discovery after symlink renewal",
        );
      }
      const health = await client.request("health", {});
      if ((await localProbe.resolveWebSocketTarget(port))?.tlsFingerprint !== finalFingerprint) {
        throw new Error("Retained local probe returned its startup certificate pin after renewal");
      }
      if ((await probeHealth())?.statusCode !== 200) {
        throw new Error("Retained local health probe kept its old certificate pin after renewal");
      }
      return {
        renewedFingerprint: finalFingerprint,
        retainedConnection: true,
        siblingListeners: 3,
        rejectedPartialRenewal: true,
        reloadOffPreservedCertificate: true,
        symlinkRenewal,
        healthResponded: health !== null && typeof health === "object",
      };
    });
    const wrongPinResult = await connectWithWrongPin(url, advertisedFingerprint);
    const cleartextMismatch = await proveCleartextMismatch(port, advertisedFingerprint);

    return {
      advertisedFingerprint,
      cleartextMismatch,
      ...renewal,
      peerFingerprint,
      wrongPinFailure: wrongPinResult.error,
      wrongPinHelloObserved: wrongPinResult.helloObserved,
    };
  } finally {
    await server?.close({ reason: "Gateway TLS pinning proof complete" }).catch(() => undefined);
    clearConfigCache();
    clearRuntimeConfigSnapshot();
    restoreEnvironment();
    await flushLogger();
    resetLogger();
    await fs.rm(runtimeRoot, { force: true, recursive: true });
  }
}

export async function runGatewayTlsPinningProducer(
  options: ProducerOptions,
): Promise<QaEvidenceSummaryJson> {
  const writer = createQaScriptEvidenceWriter({
    artifactBase: options.artifactBase,
    logFileName: `${SCENARIO_ID}.log`,
    primaryModel: "mock-openai/gpt-5.6-luna",
    providerMode: "mock-openai",
    repoRoot: options.repoRoot,
    target: {
      id: SCENARIO_ID,
      title: "Gateway TLS certificate pinning",
      sourcePath: SOURCE_PATH,
      docsRefs: ["docs/gateway/index.md", "docs/gateway/discovery.md", "docs/gateway/protocol.md"],
      codeRefs: [
        "src/infra/tls/gateway.ts",
        "src/gateway/server-runtime-state.ts",
        "packages/gateway-client/src/client.ts",
      ],
    },
  });
  const startedAt = Date.now();
  try {
    const proof = await runGatewayTlsPinningProof();
    await fs.mkdir(options.artifactBase, { recursive: true });
    const summaryPath = path.join(options.artifactBase, "gateway-tls-pinning-summary.json");
    await fs.writeFile(summaryPath, `${JSON.stringify(proof, null, 2)}\n`, "utf8");
    writer.appendLog("pass: exact pin connected; wrong pin and plaintext mismatch rejected\n");
    return await writer.write({
      artifacts: [{ filePath: summaryPath, kind: "summary" }],
      details: "Real TLS Gateway pinning contract passed.",
      durationMs: Math.max(1, Date.now() - startedAt),
      status: "pass",
    });
  } catch (error) {
    const details = formatErrorMessage(error);
    writer.appendLog(`fail: ${details}\n`);
    return await writer.write({
      details,
      durationMs: Math.max(1, Date.now() - startedAt),
      status: "fail",
    });
  }
}

async function main(argv: readonly string[]) {
  const evidence = await runGatewayTlsPinningProducer(parseOptions(argv));
  const status = evidence.entries[0]?.result.status;
  console.log(`Gateway TLS pinning evidence: ${QA_EVIDENCE_FILENAME}`);
  console.log(`Gateway TLS pinning status: ${status}`);
  return status === "pass" ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2))
    .then((exitCode) => {
      process.exit(exitCode);
    })
    .catch((error: unknown) => {
      console.error(formatErrorMessage(error));
      process.exitCode = 1;
    });
}
