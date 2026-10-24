import fs from "node:fs/promises";
import type { Server, ServerResponse } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { createQaGatewayChild } from "../../../../extensions/qa-lab/api.js";
import type { OpenClawConfig } from "../../../../src/config/types.openclaw.js";
import { loadOrCreateDeviceIdentity } from "../../../../src/infra/device-identity.js";
import { resolveRuntimeProcessEntrypointUrl } from "../../../../src/infra/runtime-process-url.js";
import {
  reserveTestPortListener,
  type TestPortClaim,
} from "../../../../src/test-utils/port-claims.js";
import {
  openFixtureReceiptChannel,
  fixtureReceiptClientSource,
} from "../../../helpers/fixture-receipts.js";
import { GATEWAY_RESTART_TEST_STOP_MS } from "../../../helpers/gateway-restart-budget.js";
import { createOpenClawTestProcess } from "../../../helpers/openclaw-test-process.js";
import { awaitGateBeforeSettlement, createDeferred, withinTest } from "../../../helpers/promise.js";
import { stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import { runQaGatewayTestFixture } from "../../../helpers/qa-gateway-test-lifetime.js";
import { MODEL_REF, PROOF_TIMEOUT_MS } from "./cloud-worker-midturn-loss-fixture.js";
import {
  createNativeProvider,
  nativeModel,
  writeNativeCompletion,
} from "./native-provider-proof-fixture.js";
import {
  closeWireServer,
  connectWireClient,
  createPublishedWireWorkspace,
  startPairedNodeWorkerGateway,
  wireMessageText,
} from "./paired-node-worker-wire-fixture.js";

const SESSION_KEY = "agent:qa:midtool-node-loss";
const RUN_ID = "midtool-node-loss-original";
const COMPLETED = "NODE-LOSS-VERIFIED-ONCE";
const [providerId, modelId] = MODEL_REF.split("/");

// This composition proves actual process death across the wire. Owner tests cover
// recovery policy; a disconnect mock cannot prove persisted partial tool calls.
it.skipIf(process.platform === "win32")(
  "continues once after the node host dies mid-tool without replaying its effects",
  async (context) => {
    const gatewayOwner = createQaGatewayChild();
    const receipts = await openFixtureReceiptChannel();
    const hosts: Awaited<ReturnType<typeof createOpenClawTestProcess>>[] = [];
    const processErrors: unknown[] = [];
    const providerErrors: unknown[] = [];
    const heldTools: ServerResponse[] = [];
    const toolEntered = createDeferred();
    void toolEntered.promise.catch(() => {});
    const completed = createDeferred();
    const originalTerminal = createDeferred();
    void originalTerminal.promise.catch(() => {});
    void completed.promise.catch(() => {});
    const runStarts = new Set<string>();
    const terminals: Array<{ runId: string; phase: string; yielded?: boolean }> = [];
    let operator: Awaited<ReturnType<typeof connectWireClient>> | undefined;
    let provider: Server | undefined;
    let providerClaim: TestPortClaim | undefined;
    let published: Awaited<ReturnType<typeof createPublishedWireWorkspace>> | undefined;
    let verificationRequests = 0;
    let toolRequests = 0;
    let stage = "opening fixture";
    let gatewayLogs = () => "";
    const hostLogs = new Map<string, string>();
    const advance = (next: string) => {
      stage = next;
      process.stderr.write(`[midtool-node-loss] ${stage}\n`);
    };
    const diagnose = () => {
      process.stderr.write(
        `[midtool-node-loss] ${JSON.stringify({ stage, toolRequests, verificationRequests, runStarts: [...runStarts], terminals, providerErrors: providerErrors.map(String), processErrors: processErrors.map(String), hostLogs: Object.fromEntries(hostLogs) })}\n${gatewayLogs().slice(-12000)}\n`,
      );
    };
    context.onTestFailed(diagnose);
    await runQaGatewayTestFixture(
      context,
      async ({ signal, createTempDir }) => {
        const root = createTempDir("midtool-node-loss-");
        const counterFile = path.join(root, "side-effects.txt");
        const requests: Array<{
          messages?: Array<{ role?: string; content?: unknown; tool_call_id?: string }>;
        }> = [];
        provider = createNativeProvider(
          async (request, response, rawBody) => {
            if (request.url === "/tool-entered") {
              heldTools.push(response);
              toolEntered.resolve();
              return;
            }
            const body = JSON.parse(rawBody) as (typeof requests)[number];
            expect(request.url).toBe("/v1/chat/completions");
            requests.push(body);
            const unknown = body.messages?.find(
              (message) =>
                message.role === "tool" &&
                /outcome.*unknown|effects.*unknown/iu.test(String(message.content)),
            );
            const verified = body.messages?.find(
              (message) => message.tool_call_id === "verify-state",
            );
            let delta: Record<string, unknown>;
            let finish: string;
            if (verified) {
              expect(String(verified.content)).toContain("effect-once");
              delta = { role: "assistant", content: COMPLETED };
              finish = "stop";
            } else if (unknown) {
              expect(String(unknown.content)).toMatch(/verif/iu);
              verificationRequests++;
              delta = {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: "verify-state",
                    type: "function",
                    function: { name: "read", arguments: JSON.stringify({ path: counterFile }) },
                  },
                ],
              };
              finish = "tool_calls";
            } else {
              toolRequests++;
              const address = provider!.address();
              if (!address || typeof address === "string") {
                throw new Error("provider not listening");
              }
              const script = `require('node:fs').appendFileSync(${JSON.stringify(counterFile)}, 'effect-once\\n'); fetch('http://127.0.0.1:${address.port}/tool-entered').then(r => r.text())`;
              delta = {
                role: "assistant",
                content: "I am recording the operation before checking its result.",
                tool_calls: [
                  {
                    index: 0,
                    id: "interrupted-exec",
                    type: "function",
                    function: {
                      name: "exec",
                      arguments: JSON.stringify({
                        command: `${JSON.stringify(process.execPath)} -e '${script.replaceAll("'", "'\\''")}'`,
                        yieldMs: PROOF_TIMEOUT_MS,
                      }),
                    },
                  },
                ],
              };
              finish = "tool_calls";
            }
            writeNativeCompletion(response, `midtool-${requests.length}`, modelId!, delta, finish);
          },
          (error, response) => {
            providerErrors.push(error);
            toolEntered.reject(error);
            completed.reject(error);
            response.destroy();
          },
        );
        const reservation = await reserveTestPortListener({
          offsets: [0],
          signal,
          createListener: () => provider!,
        });
        providerClaim = reservation.claim;
        const address = provider.address();
        if (!address || typeof address === "string") {
          throw new Error("provider not listening");
        }
        advance("publishing workspace");
        published = await createPublishedWireWorkspace(root);
        const identity = loadOrCreateDeviceIdentity({
          env: { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "node-state") },
        });
        const nodeConfig: OpenClawConfig = {
          models: {
            providers: {
              [providerId!]: {
                apiKey: "synthetic-node-loss-key",
                api: "openai-completions",
                baseUrl: `http://127.0.0.1:${address.port}/v1`,
                models: [
                  nativeModel(modelId!, {
                    maxTokens: 256,
                    reasoning: true,
                    thinkingLevelMap: { medium: "medium" },
                  }),
                ],
              },
            },
          },
        };
        advance("starting Gateway");
        const gateway = await startPairedNodeWorkerGateway({
          owner: gatewayOwner,
          providerBaseUrl: "http://127.0.0.1:1",
          nativeWorkerDeviceId: identity.deviceId,
          fullAccess: true,
          command: {
            executablePath: process.execPath,
            argsPrefix: [path.resolve("dist/index.js")],
            tempParentDir: root,
          },
        });
        gatewayLogs = gateway.logs;
        advance("connecting operator");
        operator = await connectWireClient({
          gateway,
          role: "operator",
          identity: null,
          onEvent(event) {
            if (event.event === "agent") {
              const payload = event.payload as {
                runId: string;
                stream?: string;
                data?: { phase?: string; yielded?: boolean };
              };
              if (payload.stream === "lifecycle") {
                if (payload.data?.phase === "start") {
                  runStarts.add(payload.runId);
                }
                if (payload.data?.phase === "end" || payload.data?.phase === "error") {
                  if (payload.data.phase === "error") {
                    const error = new Error(`worker turn failed: ${JSON.stringify(event.payload)}`);
                    if (payload.runId === RUN_ID) {
                      originalTerminal.reject(error);
                    }
                    completed.reject(error);
                  } else if (payload.runId === RUN_ID) {
                    originalTerminal.resolve();
                  }
                  terminals.push({
                    runId: payload.runId,
                    phase: payload.data.phase,
                    yielded: payload.data.yielded,
                  });
                  if (payload.runId !== RUN_ID && payload.data.phase === "end") {
                    completed.resolve();
                  }
                }
              }
            }
          },
        });
        await operator.request("sessions.messages.subscribe", { key: SESSION_KEY });
        const fixtureUrl = pathToFileURL(
          path.resolve("test/e2e/qa-lab/runtime/paired-node-worker-wire-fixture.ts"),
        ).href;
        const hostScript = path.join(root, "host.mts");
        const optionsFile = path.join(root, "host-options.json");
        await fs.writeFile(
          optionsFile,
          JSON.stringify({
            root,
            gateway: { wsUrl: gateway.wsUrl, token: gateway.token, runtimeEnv: gateway.runtimeEnv },
            nodeConfig,
            processOwnerUrl: resolveRuntimeProcessEntrypointUrl("serviceChildGroupAnchor").href,
          }),
        );
        await fs.writeFile(
          hostScript,
          `${fixtureReceiptClientSource(receipts.endpoint)}
import fs from 'node:fs/promises';
import { connectWireClient, createPairedNodeWorkerHost } from ${JSON.stringify(fixtureUrl)};
import { registerSealedRuntimeProcessEntrypoint } from ${JSON.stringify(pathToFileURL(path.resolve("src/infra/runtime-process-url.ts")).href)};
const options = JSON.parse(await fs.readFile(process.argv[2], 'utf8'));
const source = process.argv[3];
// Linux custody requires the runner's built owner; a source-loader owner cannot reap safely.
registerSealedRuntimeProcessEntrypoint('serviceChildGroupAnchor', new URL(options.processOwnerUrl));
const operator = await connectWireClient({ gateway: options.gateway, role: 'operator', identity: null });
process.stderr.write('operator connected\\n');
let host;
try {
  host = await createPairedNodeWorkerHost({ ...options, operator, onInvoke: (frame) => process.stderr.write(frame.command + '\\n') });
  sendReceipt(source, 'ready');
  await awaitRelease(source, 'stop');
} finally {
  await host?.stop();
  await operator.stopAndWait({ timeoutMs: 2000 });
}
`,
        );
        const startHost = async (source: string) => {
          advance(`starting ${source} node host`);
          const host = await createOpenClawTestProcess({
            argv: [
              process.execPath,
              "--import",
              pathToFileURL(path.resolve("scripts/tsx.mjs")).href,
              hostScript,
              optionsFile,
              source,
            ],
            cwd: process.cwd(),
            env: gateway.runtimeEnv,
            signal,
            onError: (error) => processErrors.push(error),
            onSpawnCleanup: (cleanup) =>
              void cleanup.catch((error: unknown) => processErrors.push(error)),
          });
          hosts.push(host);
          host.process.stdout.resume();
          let stderr = "";
          host.process.stderr.on("data", (chunk: Buffer) => {
            stderr = (stderr + chunk.toString()).slice(-8000);
            hostLogs.set(source, stderr);
          });
          const exited = new Promise<never>((_resolve, reject) => {
            host.process.once("exit", (code, reason) =>
              reject(new Error(`node host exited before ready (${code}/${reason}): ${stderr}`)),
            );
          });
          await withinTest(Promise.race([receipts.waitFor(source, "ready"), exited]), signal);
          advance(`${source} node host ready`);
          return host;
        };
        const original = await startHost("original");
        advance("creating and dispatching session");
        await operator.request("sessions.create", {
          key: SESSION_KEY,
          agentId: "qa",
          worktree: true,
          worktreeName: "midtool-loss",
          worktreeBaseRef: "main",
          cwd: published.source,
        });
        expect(
          await operator.request(
            "sessions.dispatch",
            { key: SESSION_KEY, profileId: "native" },
            { timeoutMs: PROOF_TIMEOUT_MS },
          ),
        ).toMatchObject({ placement: { state: "active" } });
        advance("starting original chat turn");
        expect(
          await operator.request("chat.send", {
            sessionKey: SESSION_KEY,
            message: "Record one operation, verify its state, and reply with the result.",
            deliver: false,
            idempotencyKey: RUN_ID,
          }),
        ).toMatchObject({ runId: RUN_ID, status: "started" });
        advance("waiting for physical exec barrier");
        await withinTest(
          awaitGateBeforeSettlement(
            toolEntered.promise,
            originalTerminal.promise,
            "original turn ended before its exec reached the physical barrier",
          ),
          signal,
        );
        expect(await fs.readFile(counterFile, "utf8")).toBe("effect-once\n");
        // Kill only the node host, leaving the interrupted worker/tool to real recovery.
        // The custody owner is retained below to collect every orphan at teardown.
        advance("killing original node host");
        process.kill(original.process.pid!, "SIGKILL");
        await withinTest(receipts.waitForExit("original"), signal);
        await startHost("replacement");
        advance("waiting for automatic continuation completion");
        await withinTest(completed.promise, signal);
        advance("verifying completed transcript and execution count");
        const history = await operator.request<{
          messages: Array<{ role?: string; toolCallId?: string }>;
        }>("chat.history", { sessionKey: SESSION_KEY, limit: 100 });
        const unknown = history.messages.filter(
          (message) =>
            message.role === "toolResult" &&
            /outcome.*unknown|effects.*unknown/iu.test(wireMessageText(message)),
        );
        expect(unknown).toHaveLength(1);
        expect(wireMessageText(unknown[0])).toMatch(/node.*disconnect|disconnect.*node/iu);
        expect(history.messages.some((message) => wireMessageText(message) === COMPLETED)).toBe(
          true,
        );
        expect(runStarts.size).toBe(2);
        expect(terminals.filter((event) => event.phase === "error")).toEqual([]);
        expect(terminals.find((event) => event.runId === RUN_ID)).toMatchObject({
          phase: "end",
          yielded: true,
        });
        expect(toolRequests).toBe(1);
        expect(verificationRequests).toBe(1);
        expect(await fs.readFile(counterFile, "utf8")).toBe("effect-once\n");
        expect(providerErrors).toEqual([]);
        expect(processErrors).toEqual([]);
      },
      async () => {
        for (const response of heldTools) {
          response.end("released");
        }
        receipts.release("original", "stop");
        receipts.release("replacement", "stop");
        await Promise.all(
          hosts.map((host) =>
            host.stop(Date.now() + GATEWAY_RESTART_TEST_STOP_MS, (warning) =>
              processErrors.push(new Error(warning)),
            ),
          ),
        );
      },
      async () => {
        await operator?.stopAndWait({ timeoutMs: 2000 });
        await stopQaGatewayFixture(gatewayOwner);
      },
      async () => {
        if (published) {
          await closeWireServer(published.server);
        }
        if (provider) {
          await closeWireServer(provider);
        }
        await providerClaim?.release();
        await receipts.close();
      },
    );
  },
  PROOF_TIMEOUT_MS + GATEWAY_RESTART_TEST_STOP_MS,
);
