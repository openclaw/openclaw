import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Agent, fetch as fetchWithDispatcher } from "undici";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.js";
import { ensureDevicePairSetupBootstrapToken } from "../../infra/device-bootstrap.js";
import { decodePairingSetupCode } from "../../pairing/setup-code.js";
import { loadBundledPluginPublicArtifactModuleSync } from "../../plugins/public-surface-loader.js";
import * as processExec from "../../process/exec.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import {
  classifyWorkerBootstrapArtifactTransferPath,
  WORKER_BOOTSTRAP_ARTIFACT_TRANSFER_PATH,
} from "../gateway-http-route-contracts.js";
import {
  createArtifactTransferHttpCallback,
  handleArtifactTransferHttpRequest,
} from "./artifact-transfer-http.js";
import { useNodeBootstrapArtifactFixtures } from "./node-bootstrap-artifact.test-support.js";
import { createWorkerNodeEnrollmentManager } from "./node-enrollment.js";
import { createWorkerEnvironmentStore, type WorkerEnvironmentStore } from "./store.js";
import { createWorkerBootstrapArtifactTransferService } from "./worker-bootstrap-artifact-transfer-service.js";

vi.mock("../../infra/device-bootstrap.js", () => ({
  revokeDeviceBootstrapToken: vi.fn(async () => ({ removed: true })),
  ensureDevicePairSetupBootstrapToken: vi.fn(async ({ setupId }: { setupId: string }) => ({
    status: "pending",
    token: "bootstrap-token",
    expiresAtMs: 10_000,
    setupId,
  })),
}));

const PUBLIC_ORIGIN = "https://gateway.example.test";
const PLUGIN_PUBLIC_URL = "wss://pairing.example.test";
const LOCAL_TLS_FINGERPRINT = "c".repeat(64);
const REMOTE_TLS_FINGERPRINT = "d".repeat(64);

function downloadRequest(descriptor: { token: string; sha256: string }) {
  return { token: descriptor.token, artifactKey: descriptor.sha256 };
}

function createConfig(
  pluginPublicUrl?: string,
  gateway: OpenClawConfig["gateway"] = {},
): OpenClawConfig {
  return {
    gateway: {
      bind: "loopback",
      publicOrigin: PUBLIC_ORIGIN,
      auth: { mode: "token", token: "gateway-token" },
      ...gateway,
    },
    ...(pluginPublicUrl
      ? {
          plugins: {
            entries: { "device-pair": { config: { publicUrl: pluginPublicUrl } } },
          },
        }
      : {}),
  };
}

describe("worker node enrollment", () => {
  let root: string;
  let database: OpenClawStateDatabase;
  let store: WorkerEnvironmentStore;
  let transfer: ReturnType<typeof createWorkerBootstrapArtifactTransferService>;
  let managers: ReturnType<typeof createWorkerNodeEnrollmentManager>[];
  const bootstrapArtifacts = useNodeBootstrapArtifactFixtures();

  const artifact = () => ({
    tarballPath: path.join(root, "node-runtime.tgz"),
    tarballSha256: "a".repeat(64),
    tarballBytes: 1,
    openclawVersion: "2026.8.1",
    buildId: "gateway-source-build",
    enabledPluginIds: ["runtime-plugin"],
  });
  const bundle = () => ({
    tarballPath: path.join(root, "worker-bundle.tgz"),
    tarballSha256: "b".repeat(64),
    tarballBytes: 6,
  });
  const createManager = (
    overrides: Partial<Parameters<typeof createWorkerNodeEnrollmentManager>[0]> = {},
  ) => {
    const manager = createWorkerNodeEnrollmentManager({
      store,
      getConfig: () => createConfig(),
      resolveAvailability: async () => ({ available: false }),
      prepareArtifact: async () => artifact(),
      transfer,
      ...overrides,
    });
    managers.push(manager);
    return manager;
  };
  const createRequested = async (profileId = "test-profile") =>
    await store.createIntent({
      environmentId: "worker-enrollment",
      providerId: "fake-provider",
      profileId,
      profileSnapshot: { settings: {} },
      provisionOperationId: "provision:worker-enrollment",
    });
  const createProvisioning = async (nodeDeviceId?: string) => {
    const record = await createRequested();
    return await store.transition({
      environmentId: record.environmentId,
      from: "requested",
      to: "provisioning",
      ...(nodeDeviceId ? { patch: { nodeDeviceId } } : {}),
    });
  };
  const holdFirstArtifact = () => {
    const entered = createDeferredCore();
    const resume = createDeferredCore();
    let first = true;
    return {
      entered: entered.promise,
      resume: resume.resolve,
      prepareArtifact: async () => {
        if (first) {
          first = false;
          entered.resolve();
          await resume.promise;
        }
        return artifact();
      },
    };
  };

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "openclaw-node-enrollment-"));
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    store = await createWorkerEnvironmentStore({ database, now: () => 1_000 });
    transfer = createWorkerBootstrapArtifactTransferService();
    managers = [];
    await fs.writeFile(artifact().tarballPath, "x");
    await fs.writeFile(bundle().tarballPath, "worker");
  });

  afterEach(async () => {
    for (const manager of managers) {
      manager.stop();
    }
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("rejects an unreachable cloud Gateway before preparing artifacts", async () => {
    const prepareArtifact = vi.fn(async () => artifact());
    const manager = createManager({
      getConfig: () => createConfig("http://localhost:19821"),
      prepareArtifact,
    });
    await expect(manager.prepare(await createRequested())).rejects.toThrow(
      "Cloud node bootstrap resolved a Gateway address that a cloud worker cannot reach (ws://localhost:19821, from plugins.entries.device-pair.config.publicUrl)",
    );
    expect(prepareArtifact).not.toHaveBeenCalled();
  });

  it.each(["codex", "runtime-plugin"])(
    "scopes private Codex inputs to the selected %s runtime at enrollment",
    async (pluginId) => {
      const directory = path.join(root, "worker-provisioning", "codex");
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const configPath = path.join(directory, "config.toml");
      const helperPath = path.join(directory, "token.mjs");
      const configToml =
        'model_provider = "worker"\n[model_providers.worker]\nwire_api = "responses"\nauth = { command = "node", args = [' +
        JSON.stringify(helperPath) +
        "] }\n";
      const helperScript = 'process.stdout.write("synthetic-worker-token")\n';
      await fs.writeFile(configPath, configToml, { mode: 0o600 });
      await fs.writeFile(helperPath, helperScript, { mode: 0o600 });
      vi.stubEnv("OPENAI_API_KEY", "synthetic-gateway-only-token");
      const record = await createProvisioning();
      const manager = createManager({
        prepareArtifact: async () => ({ ...artifact(), enabledPluginIds: [pluginId] }),
      });
      const runtime = await manager.prepareRuntime(record, bundle());
      expect(runtime).not.toHaveProperty("workerCodex");
      const enrollment = await manager.begin(record);
      if (pluginId !== "codex") {
        expect(enrollment).not.toHaveProperty("workerCodex");
        return;
      }
      expect(enrollment.workerCodex).toEqual({
        configToml,
        helperScript,
        helperPath,
        configVersion: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      const { resolveCodexWorkerAppServerCommand } = loadBundledPluginPublicArtifactModuleSync<{
        resolveCodexWorkerAppServerCommand: (env: NodeJS.ProcessEnv, required: boolean) => string;
      }>({ dirName: "codex", artifactBasename: "worker-provisioning-api.js" });
      const command = resolveCodexWorkerAppServerCommand(process.env, true);
      expect(command).toBe("codex.app-server.stdio.v1." + enrollment.workerCodex!.configVersion);
      await fs.writeFile(helperPath, helperScript + "// changed\n");
      const changed = await manager.begin(record);
      expect(changed.workerCodex!.configVersion).not.toBe(enrollment.workerCodex!.configVersion);
      expect(resolveCodexWorkerAppServerCommand(process.env, true)).toBe(
        "codex.app-server.stdio.v1." + changed.workerCodex!.configVersion,
      );
      expect(JSON.stringify(enrollment.nodeBootstrap)).not.toContain("synthetic-worker-token");
      expect(JSON.stringify(enrollment)).not.toContain("synthetic-gateway-only-token");
    },
  );

  it.each([
    "incomplete",
    "malformed",
    "outside helper",
    "empty",
    "oversized",
    "public file",
    "symlink",
  ])("rejects %s private Codex bundle without issuing pairing credentials", async (invalid) => {
    const directory = path.join(root, "worker-provisioning", "codex");
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const helperPath = path.join(directory, "token.mjs");
    const selectedHelper =
      invalid === "outside helper" ? path.join(root, "outside.mjs") : helperPath;
    const config =
      'model_provider = "worker"\n[model_providers.worker]\nwire_api = "responses"\nauth = { command = "node", args = [' +
      JSON.stringify(selectedHelper) +
      "] }\n";
    await fs.writeFile(
      path.join(directory, "config.toml"),
      invalid === "empty" ? "" : invalid === "malformed" ? "invalid [" : config,
      { mode: 0o600 },
    );
    if (invalid !== "incomplete") {
      await fs.writeFile(
        helperPath,
        invalid === "oversized" ? "x".repeat(16 * 1024 + 1) : "// private helper\n",
        { mode: invalid === "public file" ? 0o644 : 0o600 },
      );
    }
    if (invalid === "symlink") {
      await fs.rename(helperPath, path.join(root, "actual.mjs"));
      await fs.symlink(path.join(root, "actual.mjs"), helperPath);
    }
    const manager = createManager({
      prepareArtifact: async () => ({ ...artifact(), enabledPluginIds: ["codex"] }),
    });
    vi.mocked(ensureDevicePairSetupBootstrapToken).mockClear();
    await expect(manager.begin(await createProvisioning())).rejects.toThrow(
      /Worker Codex|Cloud worker Codex/,
    );
    expect(ensureDevicePairSetupBootstrapToken).not.toHaveBeenCalled();
  });

  it("prepares requested-state artifacts without enrollment or transfer grants", async () => {
    const record = await createRequested();
    const { provider } = await bootstrapArtifacts.fixture();
    const manager = createManager({
      prepareArtifact: async (_record, signal) => await provider.prepare(signal),
    });
    const caller = new AbortController();
    const ensureEnrollment = vi.spyOn(store, "ensureNodeEnrollment");
    const grant = vi.spyOn(transfer, "prepare");
    await manager.prepare(record, caller.signal);
    expect(caller.signal.aborted).toBe(false);
    expect(ensureEnrollment).not.toHaveBeenCalled();
    expect(grant).not.toHaveBeenCalled();
    expect(store.get(record.environmentId)).toMatchObject({
      state: "requested",
      nodeSetupId: null,
      nodeDeviceId: null,
    });
    await provider.close();
  });

  it.each(["caller", "shutdown"] as const)(
    "cancels requested-state preflight on %s while its shared producer drains",
    async (reason) => {
      const record = await createRequested();
      const { provider } = await bootstrapArtifacts.fixture();
      const stagingRoot = path.join(root, "held-artifact");
      await fs.mkdir(stagingRoot);
      const entered = createDeferredCore();
      const resume = createDeferredCore<string>();
      const makeTemp = vi.spyOn(fs, "mkdtemp").mockImplementationOnce(async () => {
        entered.resolve();
        return await resume.promise;
      });
      const manager = createManager({
        prepareArtifact: async (_record, signal) => await provider.prepare(signal),
      });
      const caller = new AbortController();
      const ensureEnrollment = vi.spyOn(store, "ensureNodeEnrollment");
      const grant = vi.spyOn(transfer, "prepare");
      const completed = vi.fn();
      const pending = manager.prepare(record, caller.signal).then(
        () => completed({ ready: true }),
        (error: unknown) => completed({ error }),
      );
      let closing: Promise<void> | undefined;
      try {
        await entered.promise;
        if (reason === "caller") {
          caller.abort(new DOMException("Stop preflight", "AbortError"));
        } else {
          manager.stop();
        }
        await vi.waitFor(() =>
          expect(completed).toHaveBeenCalledExactlyOnceWith({
            error: expect.objectContaining({ name: "AbortError" }),
          }),
        );
        expect(caller.signal.aborted).toBe(reason === "caller");
        expect(ensureEnrollment).not.toHaveBeenCalled();
        expect(grant).not.toHaveBeenCalled();
        expect(store.get(record.environmentId)).toMatchObject({
          state: "requested",
          nodeSetupId: null,
          nodeDeviceId: null,
        });
        const closed = vi.fn();
        closing = provider.close().then(closed);
        await fs.access(stagingRoot);
        expect(closed).not.toHaveBeenCalled();
        resume.resolve(stagingRoot);
        await closing;
        await expect(fs.access(stagingRoot)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        resume.resolve(stagingRoot);
        manager.stop();
        await pending;
        await closing;
        makeTemp.mockRestore();
      }
    },
  );

  it("transfers the prepared project lock under the runtime's revocable authority", async () => {
    const record = await createProvisioning();
    const manager = createManager({
      prepareArtifact: async () => ({ ...artifact(), installLock: bundle() }),
    });
    const runtime = await manager.prepareRuntime(record, bundle());
    const lock = runtime.nodeBootstrap.installLock!;
    const request = downloadRequest(lock);
    expect(lock.sha256).toBe(bundle().tarballSha256);
    expect(lock.token).not.toBe(runtime.nodeBootstrap.token);
    const authorization = transfer.authorize(request)!;
    const opened = await transfer.openFile(authorization);
    expect(opened).not.toBeNull();
    if (opened) {
      expect(await opened.handle.readFile("utf8")).toBe("worker");
      await opened.handle.close();
    }
    manager.closeRuntime(runtime);
    expect(transfer.authorize(request)).toBeUndefined();
  });

  it("sizes grants and download authority for the actual artifacts", async () => {
    const record = await createProvisioning();
    let transferNow = 0;
    let tarballBytes = 1;
    vi.spyOn(Date, "now").mockImplementation(() => transferNow);
    transfer = createWorkerBootstrapArtifactTransferService();
    const manager = createManager({
      prepareArtifact: async () => ({ ...artifact(), tarballBytes }),
    });
    for (const { bytes, enrollmentMs, runtimeMs } of [
      { bytes: 1, enrollmentMs: 45 * 60_000, runtimeMs: 45 * 60_000 },
      { bytes: 200_000_000, enrollmentMs: 61 * 60_000 + 40_000, runtimeMs: 88 * 60_000 + 20_000 },
      { bytes: 250_000_000, enrollmentMs: 68 * 60_000 + 20_000, runtimeMs: 95 * 60_000 },
    ]) {
      tarballBytes = bytes;
      const runtime = await manager.prepareRuntime(record, { ...bundle(), tarballBytes });
      expect(runtime.bootstrapTimeoutMs).toBe(runtimeMs);
      transferNow += runtimeMs - 1;
      for (const download of [runtime.nodeBootstrap, runtime.workerBundle]) {
        expect(transfer.authorize(downloadRequest(download))).toBeDefined();
      }
      const enrollment = await manager.begin(record);
      expect(enrollment.bootstrapTimeoutMs).toBe(enrollmentMs);
    }
  });

  it.each(["shutdown", "destroy", "operation-abort"] as const)(
    "revokes runtime preparation on %s",
    async (reason) => {
      const record = await createProvisioning();
      const manager = createManager();
      const operation = new AbortController();
      const runtime = await manager.prepareRuntime(record, bundle(), operation.signal);
      const requests = [runtime.nodeBootstrap, runtime.workerBundle].map(downloadRequest);
      const authorizations = requests.map((request) => transfer.authorize(request)!);
      if (reason === "shutdown") {
        manager.stop();
      } else if (reason === "operation-abort") {
        operation.abort();
      } else {
        await store.requestDestroy({ environmentId: record.environmentId, state: "provisioning" });
      }
      for (const [index, authorization] of authorizations.entries()) {
        expect(transfer.isAuthorizationCurrent(authorization)).toBe(false);
        expect(transfer.authorize(requests[index]!)).toBeUndefined();
        await expect(transfer.openFile(authorization)).resolves.toBeNull();
      }
    },
  );

  it("serves both preparation archives through HTTP only while their exact owner is current", async () => {
    const dispatcher = new Agent({ connections: 1 });
    const resumeEof = createDeferredCore();
    const openFile = transfer.openFile.bind(transfer);
    // Delay the last archive's EOF, after all advertised bytes have reached the client.
    // Replacing preparation must not abort a completed response's keep-alive socket.
    vi.spyOn(transfer, "openFile").mockImplementation(async (...args) => {
      const file = await openFile(...args);
      if (file?.bytes === bundle().tarballBytes) {
        const read = file.handle.read.bind(file.handle);
        vi.spyOn(file.handle, "read").mockImplementation(async (...readArgs) => {
          const result = await read(...readArgs);
          if (result.bytesRead === 0) {
            await resumeEof.promise;
          }
          return result;
        });
      }
      return file;
    });
    const callback = createArtifactTransferHttpCallback(transfer);
    const handledRequests: Promise<unknown>[] = [];
    const server = http.createServer((req, res) => {
      handledRequests.push(
        handleArtifactTransferHttpRequest({
          classifyPath: classifyWorkerBootstrapArtifactTransferPath,
          routePrefix: `${WORKER_BOOTSTRAP_ARTIFACT_TRANSFER_PATH}/artifacts/`,
          req,
          res,
          clientIp: "127.0.0.1",
          callback,
        }).catch(() => res.writeHead(500).end()),
      );
    });
    const connected = vi.fn();
    server.on("connection", connected);
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("HTTP proof server did not bind");
      }
      const testOrigin = `http://127.0.0.1:${address.port}`;
      const manager = createManager({
        prepareArtifact: async () => ({
          ...artifact(),
          tarballSha256: createHash("sha256").update("x").digest("hex"),
        }),
      });
      const preparedBundle = {
        ...bundle(),
        tarballSha256: createHash("sha256").update("worker").digest("hex"),
      };
      const record = await createProvisioning();
      const ensureEnrollment = vi.spyOn(store, "ensureNodeEnrollment");
      vi.mocked(ensureDevicePairSetupBootstrapToken).mockClear();
      const requestPair = async (
        runtime: Awaited<ReturnType<typeof manager.prepareRuntime>>,
        status: number,
      ) => {
        for (const descriptor of [runtime.nodeBootstrap, runtime.workerBundle]) {
          // Route the advertised public URL to this test's local HTTP server.
          const downloadUrl = new URL(descriptor.url);
          expect(downloadUrl.origin).toBe(PUBLIC_ORIGIN);
          const response = await fetchWithDispatcher(new URL(downloadUrl.pathname, testOrigin), {
            dispatcher,
            headers: { authorization: `Bearer ${descriptor.token}` },
          });
          expect(response.status).toBe(status);
          const body = Buffer.from(await response.arrayBuffer());
          if (status === 200) {
            expect(body.byteLength).toBe(descriptor.bytes);
            expect(createHash("sha256").update(body).digest("hex")).toBe(descriptor.sha256);
          }
        }
      };
      await requestPair(await manager.prepareRuntime(record, preparedBundle), 200);
      const closed = await manager.prepareRuntime(record, preparedBundle);
      manager.closeRuntime(closed);
      await requestPair(closed, 404);
      const previous = await manager.prepareRuntime(record, preparedBundle);
      const current = await manager.prepareRuntime(record, preparedBundle);
      await requestPair(previous, 404);
      await requestPair(current, 200);
      expect(connected).toHaveBeenCalledOnce();
      expect(ensureEnrollment).not.toHaveBeenCalled();
      expect(ensureDevicePairSetupBootstrapToken).not.toHaveBeenCalled();
      expect(store.get(record.environmentId)).toMatchObject({
        nodeSetupId: null,
        nodeDeviceId: null,
      });
      // Client body completion precedes the server releasing its transfer authorization.
      await Promise.all(handledRequests);
      const authorization = transfer.authorize(downloadRequest(current.workerBundle))!;
      const enrollment = await manager.begin(record);
      expect(enrollment).not.toHaveProperty("workerBundle");
      expect(current.signal?.aborted).toBe(true);
      expect(transfer.isAuthorizationCurrent(authorization)).toBe(false);
      manager.closeRuntime(current);
      manager.close({ ...enrollment });
      expect(enrollment.signal?.aborted).toBe(false);
      expect(transfer.authorize(downloadRequest(enrollment.nodeBootstrap))).toBeDefined();
    } finally {
      resumeEof.resolve();
      await dispatcher.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  it.each(["enrollment", "operation-abort", "destroy"] as const)(
    "rejects late artifact preparation after %s",
    async (reason) => {
      const record = await createProvisioning();
      const held = holdFirstArtifact();
      const manager = createManager({ prepareArtifact: held.prepareArtifact });
      const operation = new AbortController();
      const pending = manager.prepareRuntime(record, bundle(), operation.signal);
      const rejected = expect(pending).rejects.toThrow();
      await held.entered;
      const enrollment = reason === "enrollment" ? await manager.begin(record) : undefined;
      if (reason === "operation-abort") {
        operation.abort();
      }
      if (reason === "destroy") {
        await store.requestDestroy({ environmentId: record.environmentId, state: "provisioning" });
      }
      held.resume();
      await rejected;
      if (enrollment) {
        expect(enrollment.signal?.aborted).toBe(false);
        expect(transfer.authorize(downloadRequest(enrollment.nodeBootstrap))).toBeDefined();
      }
    },
  );

  it.each(
    ["public origin", "pairing path", "direct TLS", "remote TLS"].flatMap((endpoint) =>
      (endpoint.endsWith("TLS") ? ["connect", "resume"] : ["connect"]).map((mode) => ({
        endpoint,
        mode,
      })),
    ),
  )("resolves $endpoint ($mode)", async ({ endpoint, mode }) => {
    let config: OpenClawConfig;
    let expectedUrl: string;
    let expectedFingerprint: string | undefined;
    if (endpoint === "public origin") {
      config = createConfig(undefined, { tls: { enabled: true }, tailscale: { mode: "serve" } });
      expectedUrl = "wss://gateway.example.test";
    } else if (endpoint === "pairing path") {
      config = createConfig(`${PLUGIN_PUBLIC_URL}/extra`);
      expectedUrl = `${PLUGIN_PUBLIC_URL}/extra`;
    } else {
      const direct = endpoint === "direct TLS";
      expectedUrl = direct ? "wss://192.168.50.20:19443" : "wss://remote.example.test";
      expectedFingerprint = direct ? LOCAL_TLS_FINGERPRINT : REMOTE_TLS_FINGERPRINT;
      config = {
        gateway: {
          auth: { mode: "token", token: "gateway-token" },
          ...(direct
            ? {
                bind: "custom" as const,
                customBindHost: "192.168.50.20",
                port: 19443,
                tls: { enabled: true },
              }
            : { remote: { url: expectedUrl, tlsFingerprint: expectedFingerprint } }),
        },
      };
    }
    const discover = vi
      .spyOn(processExec, "runCommandWithTimeout")
      .mockRejectedValue(new Error("Unexpected endpoint discovery"));
    const record = await createProvisioning(mode === "resume" ? "existing-node" : undefined);
    const manager = createManager({
      getConfig: () => config,
      getLocalTlsFingerprint: () => LOCAL_TLS_FINGERPRINT,
    });

    const enrollment = await manager.begin(record);
    expect(discover).not.toHaveBeenCalled();

    expect(enrollment.mode).toBe(mode);
    if (enrollment.mode === "connect") {
      const setup = decodePairingSetupCode(enrollment.setupCode, { nowMs: 0 });
      expect(setup.url).toBe(expectedUrl);
      expect(setup.tlsFingerprint).toBe(expectedFingerprint);
    } else {
      expect(enrollment.deviceId).toBe("existing-node");
    }
    expect(enrollment.nodeBootstrap).toMatchObject({
      url: `${new URL(expectedUrl.replace(/^wss:/u, "https:")).origin}/__openclaw__/worker-bootstrap/artifacts/${artifact().tarballSha256}`,
      sha256: artifact().tarballSha256,
      bytes: 1,
      openclawVersion: "2026.8.1",
      enabledPluginIds: ["runtime-plugin"],
    });
    expect(enrollment.nodeBootstrap.tlsFingerprint).toBe(expectedFingerprint);
    const authorization = transfer.authorize(downloadRequest(enrollment.nodeBootstrap));
    expect(authorization).toBeDefined();
    const opened = await transfer.openFile(authorization!);
    expect(await opened?.handle.readFile("utf8")).toBe("x");
    await opened?.handle.close();
  });

  it("does not split surrogate pairs when bounding the enrollment display name", async () => {
    const profileId = `${"x".repeat(50)}😀tail`;
    const record = await store.transition({
      environmentId: (await createRequested(profileId)).environmentId,
      from: "requested",
      to: "provisioning",
    });
    const manager = createManager();

    await expect(manager.begin(record)).resolves.toMatchObject({
      displayName: `Cloud worker ${"x".repeat(50)}`,
    });
  });

  it("publishes pairing and keeps the session-list inventory stable while polling node readiness", async () => {
    const bootstrap = await vi.importActual<typeof import("../../infra/device-bootstrap.js")>(
      "../../infra/device-bootstrap.js",
    );
    vi.mocked(ensureDevicePairSetupBootstrapToken).mockImplementationOnce((params) =>
      bootstrap.ensureDevicePairSetupBootstrapToken({ ...params, baseDir: root }),
    );
    const record = await createProvisioning();
    const polledVersions: number[] = [];
    const manager = createManager({
      resolveAvailability: async (deviceId) => {
        expect(deviceId).toBe("paired-cloud-node");
        polledVersions.push(store.inventoryVersion());
        return { available: polledVersions.length === 3 };
      },
    });
    const enrollment = await manager.begin(record);
    if (enrollment.mode !== "connect") {
      throw new Error("Expected a fresh node enrollment");
    }
    const setup = decodePairingSetupCode(enrollment.setupCode);
    const inventoryVersion = store.inventoryVersion();
    const pending = store.get(record.environmentId);
    const waiting = enrollment.waitForDeviceId();
    try {
      expect(store.inventoryVersion()).toBe(inventoryVersion);
      expect(store.get(record.environmentId)).toEqual(pending);

      await bootstrap.verifyDeviceBootstrapToken({
        baseDir: root,
        token: setup.bootstrapToken,
        deviceId: "paired-cloud-node",
        publicKey: "paired-cloud-public-key",
        role: "node",
        scopes: [],
      });
      await bootstrap.consumeDeviceBootstrapTokenWithSetupCompletion({
        baseDir: root,
        token: setup.bootstrapToken,
        deviceId: "paired-cloud-node",
        completedAtMs: 1_100,
        admitsCloudWorkerSetup: manager.admitsNodeSetupCompletion,
      });
      expect(store.get(record.environmentId)).toMatchObject({
        nodeSetupId: enrollment.setupId,
        nodeDeviceId: "paired-cloud-node",
      });
      const completedVersion = store.inventoryVersion();
      expect(completedVersion).toBeGreaterThan(inventoryVersion);

      await expect(waiting).resolves.toBe("paired-cloud-node");
      expect(polledVersions).toEqual([completedVersion, completedVersion, completedVersion]);
      expect(store.inventoryVersion()).toBe(completedVersion);
    } finally {
      manager.close(enrollment);
      await waiting.catch(() => undefined);
    }
  });

  it("aborts pending enrollment waits idempotently and rejects enrollment after shutdown", async () => {
    const record = await createProvisioning("device-pending");
    const manager = createManager();
    const enrollment = await manager.begin(record);
    const waiting = enrollment.waitForDeviceId();
    const waitRejected = expect(waiting).rejects.toMatchObject({ name: "AbortError" });

    manager.stop();
    manager.stop();

    await waitRejected;
    expect(enrollment.signal?.aborted).toBe(true);
    const ensureEnrollment = vi.spyOn(store, "ensureNodeEnrollment");
    await expect(manager.begin(record)).rejects.toMatchObject({ name: "AbortError" });
    expect(ensureEnrollment).not.toHaveBeenCalled();
  });

  it.each(["retire", "shutdown", "destroy"] as const)(
    "revokes bootstrap download authority on %s",
    async (reason) => {
      const record = await createProvisioning();
      const manager = createManager();
      const enrollment = await manager.begin(record);
      const request = downloadRequest(enrollment.nodeBootstrap);
      const authorization = transfer.authorize(request)!;
      expect(transfer.isAuthorizationCurrent(authorization)).toBe(true);

      if (reason === "retire") {
        await manager.retire(record);
      } else if (reason === "shutdown") {
        manager.stop();
      } else {
        await store.requestDestroy({ environmentId: record.environmentId, state: "provisioning" });
      }

      expect(transfer.isAuthorizationCurrent(authorization)).toBe(false);
      expect(transfer.authorizationSignal(authorization).aborted).toBe(true);
      expect(transfer.authorize(request)).toBeUndefined();
      await expect(transfer.openFile(authorization)).resolves.toBeNull();
    },
  );

  it("replaces enrollment authority without allowing stale or copied handles to close its successor", async () => {
    const record = await createProvisioning();
    const manager = createManager();
    const previous = await manager.begin(record);
    const replacement = await manager.begin(record);
    expect(previous.signal?.aborted).toBe(true);
    expect(transfer.authorize(downloadRequest(previous.nodeBootstrap))).toBeUndefined();

    manager.close(previous);
    manager.close({ ...replacement });
    await expect(
      manager.begin({ ...record, provisionOperationId: "retired-provision" }),
    ).rejects.toThrow("no longer provisioning");
    const authorization = transfer.authorize(downloadRequest(replacement.nodeBootstrap))!;
    expect(transfer.isAuthorizationCurrent(authorization)).toBe(true);
    manager.close(replacement);
    expect(transfer.isAuthorizationCurrent(authorization)).toBe(false);
  });

  it("does not let an older pending enrollment replace a newer enrollment", async () => {
    const record = await createProvisioning();
    const held = holdFirstArtifact();
    const manager = createManager({ prepareArtifact: held.prepareArtifact });
    const pending = manager.begin(record);
    const rejected = expect(pending).rejects.toThrow();
    await held.entered;
    const current = await manager.begin(record);
    const authorization = transfer.authorize(downloadRequest(current.nodeBootstrap))!;
    expect(transfer.isAuthorizationCurrent(authorization)).toBe(true);

    held.resume();
    await rejected;

    expect(current.signal?.aborted).toBe(false);
    expect(transfer.isAuthorizationCurrent(authorization)).toBe(true);
    const opened = await transfer.openFile(authorization);
    expect(await opened?.handle.readFile("utf8")).toBe("x");
    await opened?.handle.close();
  });

  it.each(["artifact", "pairing"] as const)(
    "does not grant download authority after teardown during %s preparation",
    async (stage) => {
      const record = await createProvisioning();
      const held = holdFirstArtifact();
      if (stage === "pairing") {
        vi.mocked(ensureDevicePairSetupBootstrapToken).mockImplementationOnce(
          async ({ setupId }) => {
            await held.prepareArtifact();
            return { status: "pending", token: "bootstrap-token", expiresAtMs: 10_000, setupId };
          },
        );
      }
      const manager = createManager(
        stage === "artifact" ? { prepareArtifact: held.prepareArtifact } : {},
      );
      const beginning = manager.begin(record);
      const rejected = expect(beginning).rejects.toThrow(
        /cannot begin node enrollment|no longer provisioning|authority is unavailable/u,
      );
      await held.entered;
      await store.requestDestroy({ environmentId: record.environmentId, state: "provisioning" });
      held.resume();
      await rejected;
    },
  );
});
