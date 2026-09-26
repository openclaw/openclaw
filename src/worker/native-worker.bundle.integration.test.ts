import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import {
  createServer,
  type IncomingHttpHeaders,
  type Server,
  type ServerResponse,
} from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WORKER_PROTOCOL_FEATURES } from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { SessionManager } from "../agents/sessions/session-manager.js";
import { createWorkerBundleProducer } from "../gateway/worker-environments/bundle.js";
import * as openclawRoot from "../infra/openclaw-root.js";
import { resetSecretRedactionRegistryForTest } from "../logging/secret-redaction-registry.test-support.js";
import { NodeWorkerBundleInstaller } from "../node-host/node-worker-bundle-installer.js";
import { createNodeWorkerSupervisor } from "../node-host/node-worker-supervisor.js";
import {
  DEFAULT_WORKER_BUNDLE_ARCHIVE_LIMITS,
  readWorkerBundleDirectoryManifest,
} from "../shared/worker-bundle-archive.js";
import {
  hashWorkerBundleManifest,
  WORKER_BUNDLE_ARTIFACT_PATHS,
  workerBundleArchiveRelativePath,
} from "../shared/worker-bundle-hash.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import type { NativeRuntimeConfig } from "./native-runtime-config.js";
import { nodeWorkerBundleTransferPath } from "./node-bundle-install-protocol.js";
import { nodeWorkerPlanHash, type NodeWorkerLaunchInput } from "./node-supervisor-protocol.js";
import {
  ComposedGatewayHarness,
  SESSION_ID,
  SESSION_KEY,
} from "./worker-fault-injection.test-support.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const MODEL = { provider: "openai", model: "bundled-native-model" };
const KEY_NAME = "NATIVE_BUNDLE_TEST_PROVIDER_KEY";
const KEY = "synthetic-bundled-native-provider-key";
const EFFECT = "written by the installed worker\n";
const FINAL = "Installed native worker completed.";
const servers: Server[] = [];
let gateway: ComposedGatewayHarness | undefined;
let supervisor: ReturnType<typeof createNodeWorkerSupervisor> | undefined;

// Shut down the real process owner before transports, SQLite, and test-owned homes disappear.
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    try {
      await supervisor?.close();
      supervisor = undefined;
      for (const server of servers.splice(0)) {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
      await gateway?.close();
      gateway = undefined;
    } finally {
      closeOpenClawStateDatabaseForTest();
      resetSecretRedactionRegistryForTest();
      vi.restoreAllMocks();
      cleanup();
    }
  }),
);

async function listen(server: Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Expected a loopback TCP fixture");
  }
  return address.port;
}

function frame(response: ServerResponse, delta: object, finish: string | null = null) {
  response.write(
    "data: " +
      JSON.stringify({
        id: "bundled-native-response",
        object: "chat.completion.chunk",
        created: 1,
        model: MODEL.model,
        choices: [{ index: 0, delta, finish_reason: finish }],
        ...(finish ? { usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } } : {}),
      }) +
      "\n\n",
  );
}

async function providerFixture(effectPath: string) {
  const requests: Array<{
    headers: IncomingHttpHeaders;
    body: Record<string, unknown>;
    url?: string;
  }> = [];
  const errors: unknown[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk));
      }
      requests.push({
        headers: request.headers,
        body: JSON.parse(Buffer.concat(chunks).toString()),
        url: request.url,
      });
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (requests.length === 1) {
        frame(response, {
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: "bundled-write",
              type: "function",
              function: {
                name: "write",
                arguments: JSON.stringify({ path: effectPath, content: EFFECT }),
              },
            },
          ],
        });
        frame(response, {}, "tool_calls");
      } else {
        frame(response, { role: "assistant", content: FINAL });
        frame(response, {}, "stop");
      }
      response.end("data: [DONE]\n\n");
    })().catch((error: unknown) => {
      errors.push(error);
      response.destroy(error instanceof Error ? error : new Error(String(error)));
    });
  });
  const port = await listen(server);
  return { requests, errors, baseUrl: "http://127.0.0.1:" + port + "/v1" };
}

// Explicit opt-in owns the build prerequisite. Missing artifacts fail when opted in;
// ordinary source suites skip this lane rather than accepting an expected failure.
// The shared composed Gateway uses Unix-domain admission, so this proof is POSIX-only.
describe.skipIf(
  process.env.OPENCLAW_TEST_NATIVE_WORKER_BUNDLE !== "1" || process.platform === "win32",
)("built native worker through the production node supervisor", () => {
  it("installs the exact build, snapshots local custody, writes a file, and commits the Gateway transcript", async () => {
    const root = tempDirs.make("oc-native-bundle-");
    const home = path.join(root, "node-home");
    const temp = path.join(root, "tmp");
    const workspace = path.join(root, "workspace");
    const bundleRoot = path.join(root, "node-bundles");
    await Promise.all([home, temp, workspace].map((directory) => mkdir(directory)));
    const artifact = await createWorkerBundleProducer({
      packageRoot: repoRoot,
      cacheDir: path.join(root, "bundle-cache"),
      protocolFeatures: WORKER_PROTOCOL_FEATURES,
    }).prepare();
    expect(artifact.bundleHash).toMatch(/^[a-f0-9]{64}$/u);
    const archiveHash = createHash("sha256");
    for await (const chunk of createReadStream(artifact.tarballPath)) {
      archiveHash.update(chunk);
    }
    expect(archiveHash.digest("hex")).toBe(artifact.tarballSha256);
    const build = {
      bundleHash: artifact.bundleHash,
      openclawVersion: artifact.openclawVersion,
      protocolFeatures: [...artifact.protocolFeatures],
    };

    // Only archive delivery is a fixture: the installer checks/extracts/hashes and
    // publishes the actual producer archive, with no substituted worker source.
    const transferToken = "t".repeat(43);
    const transfers: string[] = [];
    const transferErrors: unknown[] = [];
    const transferPort = await listen(
      createServer((request, response) => {
        if (
          request.method !== "GET" ||
          request.url !== nodeWorkerBundleTransferPath(build.bundleHash) ||
          request.headers.authorization !== "Bearer " + transferToken
        ) {
          response.writeHead(403).end();
          return;
        }
        transfers.push(request.url);
        response.writeHead(200, { "content-length": artifact.tarballBytes });
        const stream = createReadStream(artifact.tarballPath);
        stream.once("error", (error) => {
          transferErrors.push(error);
          response.destroy(error);
        });
        response.once("close", () => stream.destroy());
        stream.pipe(response);
      }),
    );
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: home,
      TMPDIR: temp,
      TMP: temp,
      TEMP: temp,
      OPENCLAW_STATE_DIR: path.join(root, "node-state"),
      NODE_DISABLE_COMPILE_CACHE: "1",
      [KEY_NAME]: KEY,
    };
    const gatewayNamespace = "native-bundle-gateway";
    // Exercise the supported prepackaged archive path. HTTP archive acquisition
    // is a separate transport contract; no proxy/security configuration is changed.
    const runtimePackage = path.join(root, "runtime-package");
    const retainedArchive = path.join(
      runtimePackage,
      workerBundleArchiveRelativePath(artifact.tarballSha256),
    );
    await mkdir(path.dirname(retainedArchive), { recursive: true });
    await copyFile(artifact.tarballPath, retainedArchive);
    const packageRootFixture = vi
      .spyOn(openclawRoot, "resolveOpenClawPackageRootSync")
      .mockReturnValue(runtimePackage);
    const installer = new NodeWorkerBundleInstaller({ root: bundleRoot, env });
    packageRootFixture.mockRestore();
    expect(
      await installer.ensure({
        input: {
          gatewayNamespace,
          build,
          archive: {
            token: transferToken,
            bytes: artifact.tarballBytes,
            sha256: artifact.tarballSha256,
          },
        },
        gatewayUrl: "ws://127.0.0.1:" + transferPort,
      }),
    ).toEqual(build);
    expect(transferErrors).toEqual([]);
    expect(transfers).toEqual([]);
    expect(await installer.inspect({ gatewayNamespace, bundleHash: build.bundleHash })).toEqual({
      bundleHash: build.bundleHash,
      status: "installed",
    });
    const installedRoot = path.join(bundleRoot, gatewayNamespace, "bundles", build.bundleHash);
    const manifest = await readWorkerBundleDirectoryManifest({
      root: installedRoot,
      limits: DEFAULT_WORKER_BUNDLE_ARCHIVE_LIMITS,
      ignoreTopLevel: new Set(["bootstrap-receipt.json"]),
    });
    expect(hashWorkerBundleManifest(manifest)).toBe(artifact.bundleHash);
    expect(manifest.map((entry) => entry.path)).toEqual([...WORKER_BUNDLE_ARTIFACT_PATHS]);

    gateway = await ComposedGatewayHarness.create(tempDirs.make("oc-bundle-gw-"), artifact);
    await gateway.start();
    const owner = gateway;
    const descriptor = await owner.createDescriptor();
    descriptor.assignment.inference = "runtime-local";
    descriptor.assignment.modelRef = MODEL;
    descriptor.assignment.workspaceDir = workspace;
    descriptor.assignment.toolAuthority = { allowedToolNames: ["write"] };
    const effectPath = path.join(workspace, "proof.txt");
    const provider = await providerFixture(effectPath);
    const config: NativeRuntimeConfig = {
      models: [
        {
          provider: MODEL.provider,
          id: MODEL.model,
          api: "openai-completions",
          baseUrl: provider.baseUrl,
          contextWindow: 32768,
          maxTokens: 173,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          apiKeyEnv: KEY_NAME,
          headers: { "x-native-registry": "supervisor-snapshot" },
        },
      ],
      workspaces: [
        {
          id: descriptor.assignment.agentId,
          path: workspace,
          sessionId: descriptor.admission.sessionId,
          models: [MODEL.provider + "/" + MODEL.model],
        },
      ],
    };
    const nativeInferenceConfig = path.join(root, "native-inference.json");
    await writeFile(nativeInferenceConfig, JSON.stringify(config), { mode: 0o600 });
    supervisor = createNodeWorkerSupervisor({
      bundleRoot,
      env,
      nativeInferenceConfig,
      capacity: 1,
    });
    const processOwner = supervisor;
    // Construction, not descriptor dispatch, owns configuration and credential capture.
    delete env[KEY_NAME];
    await writeFile(nativeInferenceConfig, "{}");
    const { connectionEndpoint, ...plan } = descriptor;
    const placement = owner.placementStore.get(SESSION_ID);
    expect(placement).toMatchObject({ state: "active", workerBundleHash: artifact.bundleHash });
    if (!placement || placement.state !== "active") {
      throw new Error("Expected exact live worker placement");
    }
    const input: NodeWorkerLaunchInput = {
      environmentSession: 1,
      launchId: descriptor.assignment.turnId,
      gatewayNamespace,
      sessionKey: SESSION_KEY,
      expectedBundleHash: artifact.bundleHash,
      placementGeneration: placement.generation,
      descriptor: plan,
    };
    const started = await processOwner.launch(input, connectionEndpoint);
    // A fast child may finish before launch() returns its journal snapshot.
    expect(["running", "completed"], started.errorText ?? "supervisor did not launch").toContain(
      started.state,
    );
    expect(started.worker?.pid).toBeGreaterThan(0);
    expect(started.worker?.pid).not.toBe(process.pid);
    await expect
      .poll(
        async () => {
          const receipt = await processOwner.status(input.launchId);
          return receipt && !["pending", "running"].includes(receipt.state) ? receipt : undefined;
        },
        { timeout: 30_000, interval: 50 },
      )
      .toMatchObject({ state: "completed" });
    const receipt = await processOwner.status(input.launchId);
    expect(receipt).toMatchObject({
      state: "completed",
      launchId: input.launchId,
      planHash: nodeWorkerPlanHash(input),
      placementGeneration: placement.generation,
    });
    if (receipt?.state !== "completed" || !receipt.resultJson) {
      throw new Error("Missing completed supervisor receipt");
    }
    const transcript = SessionManager.open(owner.sessionTarget);
    const messages = transcript
      .getEntries()
      .flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
    expect(JSON.parse(receipt.resultJson)).toMatchObject({
      status: "completed",
      transcriptLeafId: transcript.getLeafId(),
    });
    expect(await readFile(effectPath, "utf8")).toBe(EFFECT);
    expect(await readdir(workspace)).toEqual(["proof.txt"]);
    expect(provider.errors).toEqual([]);
    expect(provider.requests).toHaveLength(2);
    for (const request of provider.requests) {
      expect(request.url).toBe("/v1/chat/completions");
      expect(request.headers.authorization).toBe("Bearer " + KEY);
      expect(request.headers["x-native-registry"]).toBe("supervisor-snapshot");
      expect(request.body).toMatchObject({ model: MODEL.model, max_completion_tokens: 173 });
    }
    expect(owner.admissions).toHaveLength(1);
    expect(owner.admissions[0]).toMatchObject({
      bundleHash: artifact.bundleHash,
      sessionId: descriptor.admission.sessionId,
      ownerEpoch: descriptor.admission.ownerEpoch,
    });
    expect(owner.providerCalls).toBe(0);
    expect(owner.replacementProviderCalls).toBe(0);
    expect(
      owner.requests.filter((request) => request.method.startsWith("worker.inference.")),
    ).toEqual([]);
    expect(messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "assistant",
    ]);
    expect(messages[1]).toMatchObject({
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "bundled-write",
          name: "write",
          arguments: { path: effectPath, content: EFFECT },
        },
      ],
    });
    expect(messages[2]).toMatchObject({ role: "toolResult", toolName: "write", isError: false });
    expect(messages[3]).toMatchObject({
      role: "assistant",
      provider: MODEL.provider,
      model: MODEL.model,
      content: [{ type: "text", text: FINAL }],
      stopReason: "stop",
    });
    expect(JSON.stringify(owner.requests)).not.toContain(KEY);
    expect(JSON.stringify(messages)).not.toContain(KEY);
    expect(JSON.stringify(receipt)).not.toContain(KEY);
    await processOwner.close();
    expect(await processOwner.hasActiveWork()).toBe(false);
  }, 120_000);
});
