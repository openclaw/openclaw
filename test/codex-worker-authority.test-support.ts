import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { TestContext } from "vitest";
import { setManagedCodexPluginRoot } from "../extensions/codex/src/app-server/managed-binary.js";
import {
  listenForNativeResponses,
  sendNativeResponse,
} from "../extensions/codex/src/app-server/thread-native.test-support.js";
import { deriveCodexWorkerConfigurationVersion } from "../extensions/codex/src/node-app-server-command.js";
import { createCodexNodeAppServerCommand } from "../extensions/codex/src/node-app-server.js";
import { saveExecApprovals } from "../src/infra/exec-approvals-store.test-support.js";
import { NodeWorkerWorkspaceRuntime } from "../src/node-host/node-worker-workspace.js";
import { invokeRegisteredNodeHostCommand } from "../src/node-host/plugin-node-host.js";
import { createPluginRuntimeMock } from "../src/plugin-sdk/plugin-test-runtime.js";
import { createEmptyPluginRegistry } from "../src/plugins/registry-empty.js";
import { setActivePluginRegistry } from "../src/plugins/runtime.js";
import { createPluginRecord } from "../src/plugins/status.test-helpers.js";
import type { OpenClawPluginNodeWorkspaceLease } from "../src/plugins/types.node-host.js";
import type { OpenClawTestState } from "../src/test-utils/openclaw-test-state.js";

/** Only the wire is local: node admission, exec policy, workspace leases and Codex are production. */
export async function createWorkerProof(
  state: OpenClawTestState,
  context: Pick<TestContext, "onTestFinished">,
) {
  const requests: Array<{ authorization: string | undefined; model: unknown }> = [];
  const commandReceipt = state.path("auth-command-receipts.txt");
  await fs.writeFile(commandReceipt, "");
  const port = await listenForNativeResponses(context, (request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      if (request.method !== "POST" || request.url !== "/v1/responses") {
        response.writeHead(404).end();
        return;
      }
      const payload: unknown = JSON.parse(body);
      assert(payload && typeof payload === "object" && "model" in payload);
      requests.push({ authorization: request.headers.authorization, model: payload.model });
      sendNativeResponse(response, "proof-response", {
        type: "message",
        id: "proof-message",
        role: "assistant",
        content: [{ type: "output_text", text: "worker-authority-ok" }],
      });
    });
  });
  const directory = state.statePath("codex-runtime");
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const helper = path.join(directory, "token.mjs");
  const helperSource = [
    'import fs from "node:fs";',
    "fs.appendFileSync(" + JSON.stringify(commandReceipt) + ", 'executed\\n');",
    "process.stdout.write('synthetic-worker-bearer');",
  ].join("\n");
  const config =
    [
      'model = "codex-test-model"',
      'model_provider = "worker-proof"',
      "[model_providers.worker-proof]",
      'name = "Local authority proof"',
      'base_url = "http://127.0.0.1:' + port + '/v1"',
      'wire_api = "responses"',
      "requires_openai_auth = false",
      "supports_websockets = false",
      "request_max_retries = 0",
      "stream_max_retries = 0",
      "[model_providers.worker-proof.auth]",
      'command = "node"',
      "args = [" + JSON.stringify(helper) + "]",
    ].join("\n") + "\n";
  await fs.writeFile(helper, helperSource, { mode: 0o600 });
  await fs.writeFile(path.join(directory, "config.toml"), config, { mode: 0o600 });
  await fs.writeFile(
    path.join(directory, "version"),
    deriveCodexWorkerConfigurationVersion(config, helper, helperSource),
    { mode: 0o600 },
  );
  setManagedCodexPluginRoot(fileURLToPath(new URL("../extensions/codex", import.meta.url)));
  saveExecApprovals({ version: 1, defaults: { security: "full", ask: "off" } });
  const workspaces = new NodeWorkerWorkspaceRuntime({
    root: state.path("node-host"),
    env: { HOME: state.home, PATH: process.env.PATH },
  });
  const owner = {
    gatewayNamespace: "codex-proof",
    environmentId: "worker-environment",
    sessionId: "worker-session",
    generation: 1,
  };
  const created = await workspaces.exec({ ...owner, argv: ["node", "-e", ""] });
  const sessionKey = "agent:main:worker-session";
  const command = createCodexNodeAppServerCommand();
  const registry = createEmptyPluginRegistry();
  registry.plugins.push(createPluginRecord({ id: "codex" }));
  registry.nodeHostCommands.push({ pluginId: "codex", source: import.meta.url, command });
  setActivePluginRegistry(registry);
  let lease: OpenClawPluginNodeWorkspaceLease | undefined;
  const admitted = Promise.withResolvers<void>();
  const proceed = Promise.withResolvers<void>();
  const runtime = createPluginRuntimeMock();
  const operations = new Set<Promise<unknown>>();
  const connections = new Set<AbortController>();
  let opens = 0;
  let failure: string | undefined;
  runtime.nodes.openDuplex = async (input) => {
    input.assertCurrent?.();
    opens++;
    const controller = new AbortController();
    connections.add(controller);
    const signal = input.signal
      ? AbortSignal.any([controller.signal, input.signal])
      : controller.signal;
    const frames = new Set<(frame: Uint8Array) => void | Promise<void>>();
    const messages = new Set<(frame: Uint8Array) => void | Promise<void>>();
    const ready = Promise.withResolvers<void>();
    const invocation = invokeRegisteredNodeHostCommand(
      input.command,
      JSON.stringify(input.params),
      {
        signal,
        emitChunk: async () => {
          throw new Error("Expected framed worker transport");
        },
        onInput: () => {
          throw new Error("Expected framed worker transport");
        },
        frames: {
          send: async (frame) => {
            for (const listener of messages) {
              await listener(frame);
            }
          },
          onMessage: (listener) => {
            frames.add(listener);
            ready.resolve();
            return () => {
              frames.delete(listener);
            };
          },
        },
      },
      {
        sessionKey,
        signal,
        sendNodeEvent: async () => undefined,
        acquireManagedWorkspaceAsync: async (request) => {
          lease = await workspaces.acquireManagedWorkspaceAsync(request);
          // Pause after real acquisition, before the production command rechecks authority.
          admitted.resolve();
          await proceed.promise;
          return lease;
        },
      },
    );
    operations.add(invocation);
    void invocation.then(
      () => {
        operations.delete(invocation);
        connections.delete(controller);
      },
      () => {
        operations.delete(invocation);
        connections.delete(controller);
      },
    );
    const closed = invocation.then(
      () => ({ ok: true as const }),
      (error: unknown) => {
        failure = error instanceof Error ? error.message : String(error);
        return { ok: false as const, error: failure };
      },
    );
    await Promise.race([
      ready.promise,
      invocation.then(() => {
        throw new Error("Worker closed before transport readiness");
      }),
    ]);
    return {
      streamId: "worker-proof",
      send: async (frame) => {
        input.assertCurrent?.();
        for (const listener of frames) {
          await listener(frame);
        }
      },
      close: () => {
        controller.abort();
      },
      onMessage: (listener) => {
        messages.add(listener);
        return () => {
          messages.delete(listener);
        };
      },
      closed,
    };
  };
  return {
    runtime,
    admitted: admitted.promise,
    continueAdmission: () => proceed.resolve(),
    sessionKey,
    workspaceDir: created.workspaceDir,
    placement: {
      placementNodeId: "local-proof-node",
      placementEnvironmentId: owner.environmentId,
      placementSessionId: owner.sessionId,
      placementOwnerEpoch: owner.generation,
    },
    requests,
    get failure() {
      return failure;
    },
    get opens() {
      return opens;
    },
    revokePlacement() {
      assert(lease);
      lease.release();
    },
    async commandCount() {
      return (await fs.readFile(commandReceipt, "utf8")).split("\n").filter(Boolean).length;
    },
    async close() {
      for (const controller of connections) {
        controller.abort();
      }
      proceed.resolve();
      await command.onDisconnect?.();
      await Promise.allSettled(operations);
      setManagedCodexPluginRoot(undefined);
    },
  };
}
