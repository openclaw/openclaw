import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, readFile, readdir } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { WORKER_PROTOCOL_FEATURES } from "../../packages/gateway-protocol/src/schema/worker-admission.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { SessionManager } from "../agents/sessions/session-manager.js";
import {
  completionConfig,
  completionModelDefinition,
} from "../agents/simple-completion.test-support.js";
import { createWorkerBundleProducer } from "../gateway/worker-environments/bundle.js";
import * as openclawRoot from "../infra/openclaw-root.js";
import { resetSecretRedactionRegistryForTest } from "../logging/secret-redaction-registry.test-support.js";
import { NodeWorkerBundleInstaller } from "../node-host/node-worker-bundle-installer.js";
import { snapshotNodeWorkerNativeInference } from "../node-host/node-worker-native-inference.js";
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
import {
  closeNativeServers,
  expectNativeRequests,
  expectNoProxyInference,
  listenNativeServer,
  nativeProviderFixture,
} from "./native-worker.test-support.js";
import { nodeWorkerPlanHash, type NodeWorkerLaunchInput } from "./node-supervisor-protocol.js";
import {
  ComposedGatewayHarness,
  SESSION_ID,
  SESSION_KEY,
} from "./worker-fault-injection.test-support.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const MODEL = { provider: "openai", model: "bundled-native-model" };
const KEY_NAME = "NATIVE_BUNDLE_TEST_PROVIDER_KEY";
const KEY = "synthetic-bundle-oc-sent-v2." + "A".repeat(48) + ".end";
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
      await closeNativeServers(servers);
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

// Opt-in requires built artifacts; Unix-domain Gateway admission requires POSIX.
it.skipIf(process.env.TEST_NATIVE_WORKER_BUNDLE !== "1" || process.platform === "win32")(
  "installs the exact build, snapshots local custody, writes a file, and commits the Gateway transcript",
  async () => {
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

    const transferToken = "t".repeat(43);
    const transfers: Array<string | undefined> = [];
    const transferPort = await listenNativeServer(
      createServer((request, response) => {
        transfers.push(request.url);
        response.writeHead(500).end();
      }),
      servers,
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
    const provider = await nativeProviderFixture(
      servers,
      MODEL.model,
      (request) =>
        request === 1
          ? { name: "write", id: "bundled-write", args: { path: effectPath, content: EFFECT } }
          : FINAL,
      FINAL,
    );
    const config = completionConfig(MODEL.provider, {
      apiKey: KEY,
      api: "openai-completions",
      baseUrl: provider.baseUrl,
      headers: { "x-native-registry": "supervisor-snapshot" },
      models: [
        completionModelDefinition({ id: MODEL.model, contextWindow: 32768, maxTokens: 173 }),
      ],
    });
    const nativeInferenceSnapshot = snapshotNodeWorkerNativeInference(config, env)!;
    supervisor = createNodeWorkerSupervisor({
      bundleRoot,
      env,
      nativeInferenceSnapshot,
      capacity: 1,
    });
    const processOwner = supervisor;
    // Construction, not descriptor dispatch, owns configuration and credential capture.
    delete env[KEY_NAME];
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
    expectNativeRequests(provider, 2, {
      url: "/v1/chat/completions",
      headers: { authorization: "Bearer " + KEY, "x-native-registry": "supervisor-snapshot" },
      body: { model: MODEL.model, max_completion_tokens: 173 },
    });
    expect(owner.admissions).toHaveLength(1);
    expect(owner.admissions[0]).toMatchObject({
      bundleHash: artifact.bundleHash,
      sessionId: descriptor.admission.sessionId,
      ownerEpoch: descriptor.admission.ownerEpoch,
    });
    expectNoProxyInference(owner);
    expect(owner.replacementProviderCalls).toBe(0);
    expect(messages).toMatchObject([
      { role: "user" },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "bundled-write",
            name: "write",
            arguments: { path: effectPath, content: EFFECT },
          },
        ],
      },
      { role: "toolResult", toolName: "write", isError: false },
      {
        role: "assistant",
        provider: MODEL.provider,
        model: MODEL.model,
        content: [{ type: "text", text: FINAL }],
        stopReason: "stop",
      },
    ]);
    for (const value of [owner.requests, messages, receipt]) {
      expect(JSON.stringify(value)).not.toContain(KEY);
    }
    await processOwner.close();
    expect(await processOwner.hasActiveWork()).toBe(false);
  },
  120_000,
);
