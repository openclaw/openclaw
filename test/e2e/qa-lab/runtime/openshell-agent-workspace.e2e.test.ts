import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createQaGatewayChild } from "../../../../extensions/qa-lab/api.js";
import type { OpenClawConfig } from "../../../../src/config/types.openclaw.js";
import { validateConfigObject } from "../../../../src/config/validation-core.js";
import type { AgentJobTerminalSnapshot } from "../../../../src/gateway/agent-turn/types.js";
import { loadOrCreateDeviceIdentity } from "../../../../src/infra/device-identity.js";
import { NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND } from "../../../../src/infra/node-commands.js";
import { prepareNodeHostRuntime } from "../../../../src/node-host/runtime.js";
import { parseNodeWorkerLaunchInput } from "../../../../src/worker/node-supervisor-protocol.js";
import { createDeferred, withinTest } from "../../../helpers/promise.js";
import { runQaGatewayFixture, stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";
import { MODEL_REF, PROOF_TIMEOUT_MS } from "./cloud-worker-midturn-loss-fixture.js";
import {
  closeWireServer,
  connectWireClient,
  createPairedNodeWorkerHost,
  startPairedNodeWorkerGateway,
  wireMessageText,
  type PairedNodeWorkerHost,
} from "./paired-node-worker-wire-fixture.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const sandboxRoot = process.env.OPENCLAW_TEST_OPENSHELL_ROOT;
const [providerId, modelId] = MODEL_REF.split("/");
const ORIGINAL = "# Agent instructions\nCANONICAL_OPEN_SHELL_BEFORE\n";
const UPDATED = "# Agent instructions\nCANONICAL_OPEN_SHELL_AFTER\n";
const DECOY = "# Agent instructions\nGATEWAY_LOCAL_DECOY_MUST_NOT_LOAD\n";
const COMMANDS = [
  "file.fetch",
  "file.stat",
  "file.write",
  "file.create",
  "dir.list",
  "workspace.memory",
  "workspace.skills",
];

type ModelRequest = {
  messages: Array<{ role: string; content?: unknown; tool_call_id?: string }>;
  tools?: Array<{ function?: { name: string } }>;
};

// Opt-in release E2E: supply an existing, writable, non-symlink directory below
// /agent or /sandbox (e.g. a container mount) as OPENCLAW_TEST_OPENSHELL_ROOT.
// The schema's real sandbox-path restriction is not bypassed for a host temp dir.
// Only OpenShell's external exec/identity transport and model HTTP are fixtures;
// configure, pairing, native processes, File Transfer, bootstrap and restart are real.
it.skipIf(process.platform === "win32" || !sandboxRoot)(
  "keeps configured agent files canonical across native sessions and Gateway restart",
  async ({ signal }) => {
    const root = await fs.realpath(tempDirs.make("openshell-agent-", sandboxRoot));
    expect(root).toMatch(/^\/(?:agent|sandbox)\//u);
    const remoteRoot = path.join(root, "canonical");
    const localRoot = path.join(root, "gateway-agent");
    const stateDir = path.join(root, "node-state");
    for (const directory of [remoteRoot, localRoot, path.join(stateDir, "node-host")]) {
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    }
    const document = path.join(remoteRoot, "AGENTS.md");
    const localDocument = path.join(localRoot, "AGENTS.md");
    await fs.writeFile(document, ORIGINAL, { mode: 0o600 });
    await fs.writeFile(localDocument, DECOY, { mode: 0o600 });
    const identity = loadOrCreateDeviceIdentity({ path: path.join(root, "node-identity.sqlite") });
    const executable = path.join(root, "openshell-fixture");
    await fs.writeFile(
      executable,
      [
        "#!" + process.execPath,
        'const { spawnSync } = require("node:child_process");',
        "const args = process.argv.slice(2);",
        'if (args[0] !== "sandbox" || args[1] !== "exec" || args[2] !== "binding-proof") throw new Error("unexpected OpenShell operation");',
        'const command = args.slice(args.indexOf("--") + 1);',
        'if (JSON.stringify(command) === JSON.stringify(["openclaw", "node", "identity", "--json"])) {',
        "  console.log(JSON.stringify({deviceId:" + JSON.stringify(identity.deviceId) + "}));",
        '} else if (command[0] === process.execPath && command[1] === "-e" && command.length === 3) {',
        // Execute the production validation script, rather than supplying its expected answer.
        '  const result = spawnSync(process.execPath, command.slice(1), { stdio: "inherit" });',
        "  if (result.error) throw result.error;",
        "  process.exitCode = result.status ?? 1;",
        '} else { throw new Error("unexpected sandbox command"); }',
      ].join("\n"),
      { mode: 0o700 },
    );
    const requests: Array<{ marker: string; body: ModelRequest }> = [];
    const providerErrors: unknown[] = [];
    const failed = createDeferred<never>();
    // Mark rejection handled even if a provider assertion fails between awaited RPCs.
    void failed.promise.catch(() => {});
    const checked = <T>(promise: Promise<T>) =>
      withinTest(Promise.race([promise, failed.promise]), signal);
    const provider = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) {
          chunks.push(Buffer.from(chunk));
        }
        const body = JSON.parse(Buffer.concat(chunks).toString()) as ModelRequest;
        expect(request.url).toBe("/v1/chat/completions");
        expect(request.headers.authorization).toBe("Bearer synthetic-openshell-native-key");
        const marker = body.messages
          .filter((message) => message.role === "user")
          .map((message) => JSON.stringify(message.content).match(/OPEN-SHELL-SESSION-[AB]/u)?.[0])
          .findLast((value) => value !== undefined);
        expect(marker).toMatch(/^OPEN-SHELL-SESSION-[AB]$/u);
        requests.push({ marker: marker!, body });
        const tools = body.messages.filter((message) => message.role === "tool");
        const lastTool = tools.at(-1);
        let name: "file_fetch" | "file_write" | undefined;
        let callId = "";
        let args: Record<string, unknown> = {};
        if (!lastTool) {
          const bootstrap = JSON.stringify(body.messages);
          expect(bootstrap).toContain(
            marker!.endsWith("A") ? "CANONICAL_OPEN_SHELL_BEFORE" : "CANONICAL_OPEN_SHELL_AFTER",
          );
          expect(bootstrap).not.toContain("GATEWAY_LOCAL_DECOY_MUST_NOT_LOAD");
          name = "file_fetch";
          callId = marker + "-fetch";
          args = { node: identity.deviceId, path: document };
        } else if (marker!.endsWith("A") && lastTool.tool_call_id === marker + "-fetch") {
          expect(JSON.stringify(lastTool.content)).toContain("CANONICAL_OPEN_SHELL_BEFORE");
          name = "file_write";
          callId = marker + "-write";
          args = {
            node: identity.deviceId,
            path: document,
            contentBase64: Buffer.from(UPDATED).toString("base64"),
            overwrite: true,
          };
        } else {
          expect(lastTool.tool_call_id).toBe(
            marker + (marker!.endsWith("A") ? "-write" : "-fetch"),
          );
          expect(JSON.stringify(lastTool.content)).toContain(
            marker!.endsWith("A") ? "Wrote " + document : "CANONICAL_OPEN_SHELL_AFTER",
          );
        }
        if (name) {
          expect(
            body.tools?.some((tool) => tool.function?.name === name),
            JSON.stringify(body.tools?.map((tool) => tool.function?.name)),
          ).toBe(true);
        }
        const delta = name
          ? {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: callId,
                  type: "function",
                  function: { name, arguments: JSON.stringify(args) },
                },
              ],
            }
          : { role: "assistant", content: marker + "-OK" };
        response.writeHead(200, { "content-type": "text/event-stream" });
        for (const [part, finish] of [
          [delta, null],
          [{}, name ? "tool_calls" : "stop"],
        ]) {
          response.write(
            "data: " +
              JSON.stringify({
                id: marker,
                object: "chat.completion.chunk",
                created: 1,
                model: modelId,
                choices: [{ index: 0, delta: part, finish_reason: finish }],
              }) +
              "\n\n",
          );
        }
        response.end("data: [DONE]\n\n");
      })().catch((error: unknown) => {
        providerErrors.push(error);
        failed.reject(error);
        response.destroy();
      });
    });
    const owner = createQaGatewayChild();
    let node: PairedNodeWorkerHost | undefined;
    let operator: Awaited<ReturnType<typeof connectWireClient>> | undefined;
    let operatorReady = createDeferred();
    await runQaGatewayFixture(
      async () => {
        await new Promise<void>((resolve, reject) => {
          provider.once("error", reject);
          provider.listen(0, "127.0.0.1", resolve);
        });
        const address = provider.address();
        if (!address || typeof address === "string") {
          throw new Error("native model listener unavailable");
        }
        const nodeConfig = validateConfigObject({
          agents: { defaults: { skipBootstrap: true }, entries: { qa: { workspace: remoteRoot } } },
          plugins: { allow: ["file-transfer"], entries: { "file-transfer": { enabled: true } } },
          models: {
            providers: {
              [providerId!]: {
                api: "openai-completions",
                baseUrl: "http://127.0.0.1:" + address.port + "/v1",
                apiKey: "synthetic-openshell-native-key",
                models: [
                  {
                    id: modelId!,
                    name: modelId!,
                    contextWindow: 32768,
                    maxTokens: 1024,
                    reasoning: false,
                    input: ["text"],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  },
                ],
              },
            },
          },
        });
        if (!nodeConfig.ok) {
          throw new Error(JSON.stringify(nodeConfig.issues));
        }
        await fs.writeFile(
          path.join(stateDir, "openclaw.json"),
          JSON.stringify(nodeConfig.config),
          { mode: 0o600 },
        );
        const policy = {
          allowReadPaths: [remoteRoot, remoteRoot + "/**"],
          allowWritePaths: [document],
          followSymlinks: false,
          ask: "off",
        };
        const gateway = await startPairedNodeWorkerGateway({
          owner,
          providerBaseUrl: "http://127.0.0.1:1",
          mockAuthAgentIds: [],
          command: {
            executablePath: process.execPath,
            argsPrefix: [path.resolve("dist/index.js")],
            tempParentDir: root,
          },
          mutateConfig: (config) => {
            config.agents!.defaults!.skipBootstrap = true;
            // The fixed endpoint declares a non-reasoning model on the node.
            config.agents!.defaults!.thinkingDefault = "off";
            config.agents!.entries!.qa!.workspace = localRoot;
            config.agents!.entries!.qa!.tools = {
              profile: "coding",
              alsoAllow: ["file_fetch", "file_write"],
            };
            config.tools = {
              ...config.tools,
              codeMode: false,
              toolSearch: false,
              alsoAllow: ["file_fetch", "file_write"],
            };
            config.gateway = {
              ...config.gateway,
              nodes: {
                ...config.gateway?.nodes,
                commands: {
                  ...config.gateway?.nodes?.commands,
                  allow: [...(config.gateway?.nodes?.commands?.allow ?? []), ...COMMANDS],
                },
              },
            };
            config.plugins = {
              ...config.plugins,
              allow: [...(config.plugins?.allow ?? []), "openshell", "file-transfer"],
              entries: {
                ...config.plugins?.entries,
                openshell: {
                  enabled: true,
                  config: {
                    command: executable,
                    providers: ["fixture-provider"],
                    worker: {
                      stateDir,
                      nodeExecutable: process.execPath,
                      agentWorkspace: { agentId: "qa", remoteRoot },
                      model: {
                        provider: providerId!,
                        id: modelId!,
                        api: "openai-completions",
                        baseUrl: "https://model.example.invalid/v1",
                        credentialEnv: "SYNTHETIC_NATIVE_KEY",
                        contextWindow: 32768,
                        maxTokens: 1024,
                      },
                    },
                  },
                },
                // Existing least-privilege operator policy must survive configure unchanged.
                "file-transfer": {
                  enabled: true,
                  config: { policyVersion: 2, nodes: { [identity.deviceId]: policy } },
                },
              },
            };
            delete config.auth;
            for (const model of Object.values(config.models?.providers ?? {})) {
              delete model.apiKey;
            }
            return config;
          },
        });
        operator = await connectWireClient({
          gateway,
          role: "operator",
          identity: null,
          onHelloOk: () => operatorReady.resolve(),
        });
        const pluginRuntime = await prepareNodeHostRuntime({
          config: nodeConfig.config,
          env: {
            ...process.env,
            OPENCLAW_DISABLE_BUNDLED_PLUGINS: "0",
            OPENCLAW_STATE_DIR: stateDir,
          },
          commands: COMMANDS,
        });
        node = await createPairedNodeWorkerHost({
          gateway,
          operator,
          root,
          nodeConfig: nodeConfig.config,
          pluginRuntime,
          capacity: 1,
          capacityWaitMs: 0,
        });
        expect(node.identity.deviceId).toBe(identity.deviceId);
        const readConfig = async () =>
          JSON.parse(await fs.readFile(gateway.configPath, "utf8")) as OpenClawConfig;
        expect((await readConfig()).cloudWorkers?.requiredProfile).toBeUndefined();
        await node.disconnect();
        operatorReady = createDeferred();
        await gateway.restartAfterStateMutation(async () => {
          const output = await gateway.runCli([
            "openshell",
            "worker",
            "configure",
            "binding-proof",
            "--worker-profile",
            "native",
            "--required",
            "--apply",
          ]);
          expect(output).toContain('"applied": true');
          const configured = await readConfig();
          expect(configured.cloudWorkers).toMatchObject({
            requiredProfile: "native",
            profiles: {
              native: {
                provider: "device",
                settings: { device: identity.deviceId, inference: "worker" },
              },
            },
          });
          const fileTransfer = configured.plugins?.entries?.["file-transfer"]?.config;
          expect(fileTransfer?.workspaces).toEqual({
            qa: { nodeId: identity.deviceId, remoteRoot },
          });
          expect(fileTransfer?.nodes).toEqual({ [identity.deviceId]: policy });
        });
        await checked(operatorReady.promise);
        await node.connect();
        const readDocument = () =>
          operator!.request<{ file: { content: string; missing: boolean } }>("agents.files.get", {
            agentId: "qa",
            name: "AGENTS.md",
          });
        expect((await checked(readDocument())).file).toMatchObject({
          content: ORIGINAL,
          missing: false,
        });
        for (const suffix of ["A", "B"]) {
          const key = "agent:qa:openshell-" + suffix.toLowerCase();
          const marker = "OPEN-SHELL-SESSION-" + suffix;
          await checked(
            operator.request(
              "sessions.create",
              { key, agentId: "qa" },
              { timeoutMs: PROOF_TIMEOUT_MS },
            ),
          );
          const started = await checked(
            operator.request<{ runId: string }>("chat.send", {
              sessionKey: key,
              message: marker + ": read the canonical agent document; A updates it, B verifies it.",
              deliver: false,
              idempotencyKey: marker,
            }),
          );
          const terminal = await checked(
            operator.request<AgentJobTerminalSnapshot>(
              "agent.wait",
              { runId: started.runId, timeoutMs: PROOF_TIMEOUT_MS },
              { timeoutMs: PROOF_TIMEOUT_MS + 5000 },
            ),
          );
          expect(
            terminal,
            JSON.stringify({
              terminal,
              nodeErrors: node.invokeErrors,
              logs: gateway.logs().slice(-12000),
            }),
          ).toMatchObject({ status: "ok" });
          await node.waitForWorkersIdle();
          const history = await checked(
            operator.request<{ messages: unknown[] }>("chat.history", { sessionKey: key }),
          );
          expect(
            history.messages.filter((message) => wireMessageText(message) === marker + "-OK"),
          ).toHaveLength(1);
          expect((await checked(readDocument())).file.content).toBe(UPDATED);
        }
        const launches = node.frames
          .filter((frame) => frame.command === NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND)
          .map((frame) => parseNodeWorkerLaunchInput(frame.paramsJSON));
        expect(launches).toHaveLength(2);
        const workspaces = launches.map((launch) => {
          expect(launch.descriptor.assignment.inference).toBe("runtime-local");
          expect(launch.descriptor.assignment.workspaceDir).not.toBe(remoteRoot);
          return launch.descriptor.assignment.workspaceDir;
        });
        expect(new Set(workspaces).size).toBe(2);
        expect(await fs.readFile(localDocument, "utf8")).toBe(DECOY);
        expect(await fs.readFile(document, "utf8")).toBe(UPDATED);
        expect(requests.filter((request) => request.marker.endsWith("A"))).toHaveLength(3);
        expect(requests.filter((request) => request.marker.endsWith("B"))).toHaveLength(2);
        expect(providerErrors).toEqual([]);
        expect(node.invokeErrors).toEqual([]);
        await node.disconnect();
        await expect(checked(readDocument())).rejects.toThrow(
          /node not connected|unavailable|disconnected/i,
        );
        const before = await readConfig();
        const previousPid = gateway.pid;
        operatorReady = createDeferred();
        await gateway.restartAfterStateMutation(async ({ configPath }) => {
          const next = await readConfig();
          delete next.cloudWorkers!.requiredProfile;
          await fs.writeFile(configPath, JSON.stringify(next), { mode: 0o600 });
        });
        expect(gateway.pid).not.toBe(previousPid);
        expect((await readConfig()).cloudWorkers?.requiredProfile).toBeUndefined();
        expect((await readConfig()).plugins?.entries?.["file-transfer"]).toEqual(
          before.plugins?.entries?.["file-transfer"],
        );
        await checked(operatorReady.promise);
        await node.connect();
        expect((await checked(readDocument())).file.content).toBe(UPDATED);
        expect(await fs.readFile(localDocument, "utf8")).toBe(DECOY);
      },
      async () => {
        await node?.stop();
      },
      async () => {
        await operator?.stopAndWait({ timeoutMs: 2000 });
      },
      () => stopQaGatewayFixture(owner),
      () => closeWireServer(provider),
    );
  },
  PROOF_TIMEOUT_MS + 180_000,
);
