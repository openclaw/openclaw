import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { SessionManager } from "../agents/sessions/session-manager.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { createNodeWorkerSupervisor } from "../node-host/node-worker-supervisor.js";
import { NodeWorkerTurnStore } from "../node-host/node-worker-turn-store.js";
import { createCompiledSdkHost } from "../plugins/compiled-sdk-host.test-support.js";
import * as nativeStartup from "./native-inference-startup.js";
import type { NativeRuntimeConfig } from "./native-runtime-config.js";
import { nativeWorkerTestEntrypoint } from "./native-worker-entrypoints.test-support.js";
import type { NodeWorkerLaunchInput } from "./node-supervisor-protocol.js";
import {
  ComposedGatewayHarness,
  SESSION_ID,
  SESSION_KEY,
} from "./worker-fault-injection.test-support.js";
import { workerBackgroundExecEntrypoints } from "./worker-runtime-background-exec-entrypoints.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

async function sink(model: string) {
  const requests: Array<{ model: unknown; authorization: string | undefined }> = [];
  const errors: unknown[] = [];
  const server = createServer((request, response) => {
    const observed: { model: unknown; authorization: string | undefined } = {
      model: undefined,
      authorization: request.headers.authorization,
    };
    requests.push(observed); // Count every HTTP arrival, including malformed bodies.
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString());
      observed.model = body.model;
      response.writeHead(200, { "content-type": "text/event-stream" });
      for (const [delta, finish_reason] of [
        [{ role: "assistant", content: "Explicit grant completed." }, null],
        [{}, "stop"],
      ]) {
        response.write(
          "data: " +
            JSON.stringify({
              id: "grant-proof",
              object: "chat.completion.chunk",
              created: 1,
              model,
              choices: [{ index: 0, delta, finish_reason }],
            }) +
            "\n\n",
        );
      }
      response.end("data: [DONE]\n\n");
    })().catch((error: unknown) => {
      errors.push(error);
      response.destroy();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Missing test sink address");
  }
  return { server, requests, errors, baseUrl: "http://127.0.0.1:" + address.port + "/v1" };
}
async function closeServer(server: Server) {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

// One Gateway and supervisor composition; no production owner or provider operation is mocked.
// Only the deployment entry shim loads the runner-owned compiled source rather than an installed archive.
it.skipIf(process.platform === "win32")(
  "requires explicit agent grants through supervisor, private carrier, compiled worker and Gateway",
  async () => {
    const root = tempDirs.make("native-grant-chain-");
    const gateway = await ComposedGatewayHarness.create(path.join(root, "gateway"));
    const servers: Server[] = [];
    let supervisor: ReturnType<typeof createNodeWorkerSupervisor> | undefined;
    try {
      await gateway.start();
      const a = await sink("grant-a");
      servers.push(a.server);
      const b = await sink("grant-b");
      servers.push(b.server);
      const descriptor = await gateway.createDescriptor();
      descriptor.assignment.inference = "runtime-local";
      descriptor.assignment.modelRef = { provider: "openai", model: "grant-a" };
      descriptor.assignment.toolAuthority = { allowedToolNames: [] };
      const home = path.join(root, "home");
      await mkdir(home);
      const env = {
        PATH: process.env.PATH,
        HOME: home,
        TMPDIR: root,
        OPENCLAW_STATE_DIR: path.join(root, "node-state"),
        NODE_DISABLE_COMPILE_CACHE: "1",
        GRANT_A_KEY: "synthetic-grant-a-credential",
        GRANT_B_KEY: "synthetic-grant-b-credential",
      };
      const config: NativeRuntimeConfig = {
        models: [a, b].map((provider, index) => ({
          provider: "openai",
          id: index === 0 ? "grant-a" : "grant-b",
          api: "openai-completions",
          baseUrl: provider.baseUrl,
          contextWindow: 32768,
          maxTokens: 173,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          apiKeyEnv: index === 0 ? "GRANT_A_KEY" : "GRANT_B_KEY",
        })),
        workspaces: [
          {
            id: descriptor.assignment.agentId,
            path: descriptor.assignment.workspaceDir,
            sessionId: descriptor.admission.sessionId,
            models: ["openai/grant-a"],
          },
        ],
      };
      const trace: Array<{
        stage: string;
        aRequests: number;
        bRequests: number;
        admissions: number;
        credentialNames: string[];
      }> = [];
      const record = (stage: string, credentialNames: string[] = []) =>
        trace.push({
          stage,
          aRequests: a.requests.length,
          bRequests: b.requests.length,
          admissions: gateway.admissions.length,
          credentialNames,
        });
      const configPath = path.join(root, "native-grants.json");
      const bundleRoot = path.join(root, "bundles");
      const gatewayNamespace = "grant-gateway";
      const bundle = path.join(
        bundleRoot,
        gatewayNamespace,
        "bundles",
        descriptor.admission.handshake.bundleHash,
      );
      await mkdir(bundle, { recursive: true });
      const sdkHost = createCompiledSdkHost(
        [
          workerBackgroundExecEntrypoints.providerModelMetadata,
          workerBackgroundExecEntrypoints.stringCoerceRuntime,
        ],
        (prefix) => tempDirs.make(prefix),
        { mode: "link" },
      );
      await writeFile(
        path.join(bundle, "worker.mjs"),
        "process.env.OPENCLAW_DEV_SOURCE_ROOT = " +
          JSON.stringify(sdkHost) +
          ";\n" +
          "process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = " +
          JSON.stringify(path.join(repoRoot, "extensions")) +
          ";\n" +
          "await import(" +
          JSON.stringify(resolveRuntimeWorkerUrl(nativeWorkerTestEntrypoint).href) +
          ");\n",
      );
      const missing = structuredClone(config);
      Reflect.deleteProperty(missing.workspaces[0]!, "models");
      await writeFile(configPath, JSON.stringify(missing), { mode: 0o600 });
      expect(() =>
        createNodeWorkerSupervisor({ bundleRoot, env, nativeInferenceConfig: configPath }),
      ).toThrow("explicit models allowlist");
      expect(a.requests).toEqual([]);
      expect(b.requests).toEqual([]);
      expect(gateway.admissions).toEqual([]);
      record("omitted-grant-rejected");
      await writeFile(configPath, JSON.stringify(config));
      const projections: nativeStartup.NativeInferenceStartup[] = [];
      const project = nativeStartup.projectNativeInferenceStartup;
      vi.spyOn(nativeStartup, "projectNativeInferenceStartup").mockImplementation((...args) => {
        const projected = project(...args);
        projections.push(projected);
        return projected;
      });
      supervisor = createNodeWorkerSupervisor({
        bundleRoot,
        env,
        nativeInferenceConfig: configPath,
      });
      const { connectionEndpoint, ...plan } = descriptor;
      const placement = gateway.placementStore.get(SESSION_ID);
      if (!placement || placement.state !== "active") {
        throw new Error("Missing active placement");
      }
      const input: NodeWorkerLaunchInput = {
        environmentSession: 1,
        gatewayNamespace,
        sessionKey: SESSION_KEY,
        launchId: descriptor.assignment.turnId,
        expectedBundleHash: descriptor.admission.handshake.bundleHash,
        placementGeneration: placement.generation,
        descriptor: plan,
      };
      const denied: NodeWorkerLaunchInput = {
        ...input,
        launchId: "denied-b",
        descriptor: {
          ...plan,
          assignment: {
            ...plan.assignment,
            turnId: "denied-b",
            modelRef: { provider: "openai", model: "grant-b" },
          },
        },
      };
      expect(await supervisor.launch(denied, connectionEndpoint)).toMatchObject({
        state: "failed",
        errorText: expect.stringContaining("not authorized"),
      });
      expect(projections).toEqual([]);
      expect(a.requests).toEqual([]);
      expect(b.requests).toEqual([]);
      expect(gateway.admissions).toEqual([]);
      record("ungranted-b-rejected");
      const completed = createDeferred();
      const finish = vi.spyOn(NodeWorkerTurnStore.prototype, "finish");
      finish.mockImplementation(async function (this: NodeWorkerTurnStore, params) {
        finish.mockRestore();
        const receipt = await this.finish(params);
        if (params.expected.launchId === input.launchId) {
          completed.resolve();
        }
        return receipt;
      });
      await supervisor.launch(input, connectionEndpoint);
      await withTestTimeout(completed.promise, 30_000, "supervised grant turn did not finish");
      expect(await supervisor.status(input.launchId)).toMatchObject({ state: "completed" });
      expect(projections).toHaveLength(1);
      expect(projections[0]?.config.models.map(({ id }) => id)).toEqual(["grant-a"]);
      expect(projections[0]?.credentials).toEqual({ GRANT_A_KEY: env.GRANT_A_KEY });
      expect(a.requests).toEqual([
        { model: "grant-a", authorization: "Bearer " + env.GRANT_A_KEY },
      ]);
      expect(b.requests).toEqual([]);
      expect(gateway.admissions).toHaveLength(1);
      expect(gateway.providerCalls).toBe(0);
      expect(a.errors).toEqual([]);
      expect(b.errors).toEqual([]);
      record("explicit-a-completed", Object.keys(projections[0]!.credentials));
      console.info("native-grant-boundary-proof", JSON.stringify(trace));
      const messages = SessionManager.open(gateway.sessionTarget)
        .getEntries()
        .flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
      expect(messages.at(-1)).toMatchObject({
        role: "assistant",
        content: [{ type: "text", text: "Explicit grant completed." }],
      });
      expect(JSON.stringify(gateway.requests)).not.toContain(env.GRANT_A_KEY);
      expect(JSON.stringify(messages)).not.toContain(env.GRANT_B_KEY);
    } finally {
      await supervisor?.close();
      await Promise.all(servers.map(closeServer));
      await gateway.close();
    }
  },
  45_000,
);
