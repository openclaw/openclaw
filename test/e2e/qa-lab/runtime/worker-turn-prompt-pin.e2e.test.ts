import path from "node:path";
import { expect, it } from "vitest";
import { createQaGatewayChild } from "../../../../extensions/qa-lab/api.js";
import type { OpenClawConfig } from "../../../../src/config/types.openclaw.js";
import { loadOrCreateDeviceIdentity } from "../../../../src/infra/device-identity.js";
import { stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import { runQaGatewayTestFixture } from "../../../helpers/qa-gateway-test-lifetime.js";
import { MODEL_REF, PROOF_TIMEOUT_MS } from "./cloud-worker-midturn-loss-fixture.js";
import {
  closeNativeProvider,
  createNativeProvider,
  listenNativeProvider,
  nativeModel,
  writeNativeCompletion,
} from "./native-provider-proof-fixture.js";
import {
  closeWireServer,
  connectWireClient,
  createPairedNodeWorkerHost,
  createPublishedWireWorkspace,
  startPairedNodeWorkerGateway,
  type PairedNodeWorkerHost,
} from "./paired-node-worker-wire-fixture.js";

const [providerId, modelId] = MODEL_REF.split("/");
type ChatRequest = { messages: Array<{ role: string; content?: unknown; tool_call_id?: string }> };
const text = (content: unknown) =>
  typeof content === "string" ? content : JSON.stringify(content);

// A workspace instruction change between worker turns must reach the provider as an appended
// prompt update; the session's system prompt, and so the cached prefix, stays unchanged.
it.skipIf(process.platform === "win32")(
  "keeps a worker session's system prompt across a workspace instruction change",
  async (context) => {
    const gatewayOwner = createQaGatewayChild();
    const requests: ChatRequest[] = [];
    const provider = createNativeProvider(
      async (_request, response, body) => {
        const parsed = JSON.parse(body) as ChatRequest;
        requests.push(parsed);
        const user = parsed.messages.findLast((message) => message.role === "user");
        const answered = parsed.messages.at(-1)?.role === "tool";
        if (!answered && text(user?.content).includes("PIN-EDIT")) {
          writeNativeCompletion(
            response,
            `pin-${requests.length}`,
            modelId!,
            {
              role: "assistant",
              tool_calls: [
                {
                  index: 0,
                  id: "edit-agents",
                  type: "function",
                  function: {
                    name: "exec",
                    arguments: JSON.stringify({
                      command: "printf '\\n- PIN-RULE: answer briefly.\\n' >> AGENTS.md",
                    }),
                  },
                },
              ],
            },
            "tool_calls",
          );
          return;
        }
        writeNativeCompletion(response, `pin-${requests.length}`, modelId!, "OK");
      },
      (_error, response) => response.destroy(),
    );
    let published: Awaited<ReturnType<typeof createPublishedWireWorkspace>> | undefined;
    let node: PairedNodeWorkerHost | undefined;
    let operator: Awaited<ReturnType<typeof connectWireClient>> | undefined;
    await runQaGatewayTestFixture(
      context,
      async ({ createTempDir }) => {
        const root = createTempDir("worker-prompt-pin-");
        const providerBaseUrl = await listenNativeProvider(provider);
        published = await createPublishedWireWorkspace(root, [
          { path: "AGENTS.md", content: "# Rules\n- Be brief.\n" },
        ]);
        const identity = loadOrCreateDeviceIdentity({
          env: { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "node-state") },
        });
        const config: OpenClawConfig = {
          models: {
            providers: {
              [providerId!]: {
                apiKey: "synthetic-worker-pin-key",
                api: "openai-completions",
                baseUrl: providerBaseUrl,
                models: [
                  nativeModel(modelId!, {
                    maxTokens: 128,
                    reasoning: true,
                    thinkingLevelMap: { medium: "medium" },
                  }),
                ],
              },
            },
          },
        };
        const gateway = await startPairedNodeWorkerGateway({
          owner: gatewayOwner,
          providerBaseUrl: "http://127.0.0.1:1",
          nativeWorkerDeviceId: identity.deviceId,
          command: {
            executablePath: process.execPath,
            argsPrefix: [path.resolve("dist/index.js")],
            tempParentDir: root,
          },
        });
        operator = await connectWireClient({ gateway, role: "operator", identity: null });
        await operator.request("sessions.subscribe", {});
        node = await createPairedNodeWorkerHost({
          gateway,
          operator,
          root,
          capacity: 1,
          nodeConfig: config,
        });
        const key = "agent:qa:worker-prompt-pin";
        await operator.request("sessions.create", {
          key,
          agentId: "qa",
          worktree: true,
          worktreeName: "worker-prompt-pin",
          worktreeBaseRef: "main",
          cwd: published.source,
        });
        await operator.request(
          "sessions.dispatch",
          { key, profileId: "native" },
          { timeoutMs: PROOF_TIMEOUT_MS },
        );
        const turn = async (runId: string, message: string) => {
          await operator!.request("chat.send", {
            sessionKey: key,
            message,
            deliver: false,
            idempotencyKey: runId,
          });
          // agent.wait reports queue admission as "pending" before the terminal result.
          let result: { status: string };
          do {
            result = await operator!.request<{ status: string }>(
              "agent.wait",
              { runId, timeoutMs: PROOF_TIMEOUT_MS },
              { timeoutMs: PROOF_TIMEOUT_MS + 5000 },
            );
          } while (result.status === "pending");
          expect(result.status).toBe("ok");
          await node!.waitForWorkersIdle();
        };
        await turn("pin-1", "Reply OK");
        await turn("pin-2", "PIN-EDIT the workspace rules");
        await turn("pin-3", "Reply OK again");
        const third = requests.length;
        await turn("pin-4", "Reply OK once more");
        const system = requests.map((request) => text(request.messages[0]?.content));
        expect(system[0]).toContain("Be brief.");
        expect(new Set(system).size).toBe(1);
        // The update rides turn 3's user message and replays unchanged on turn 4.
        const sent = requests[third - 1]!.messages;
        expect(
          sent.some(
            (message) =>
              message.role === "user" &&
              text(message.content).includes("System prompt update") &&
              text(message.content).includes("PIN-RULE"),
          ),
        ).toBe(true);
        expect(requests.at(-1)!.messages.slice(0, sent.length)).toEqual(sent);
      },
      async () => {
        await node?.stop();
      },
      async () => {
        await operator?.stopAndWait({ timeoutMs: 2000 });
      },
      () => stopQaGatewayFixture(gatewayOwner),
      () => closeNativeProvider(provider),
      () => (published ? closeWireServer(published.server) : undefined),
    );
  },
  PROOF_TIMEOUT_MS + 180_000,
);
