import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { createQaGatewayChild } from "../../../../extensions/qa-lab/api.js";
import { writeOpenAiResponsesSse } from "../../../helpers/openai-responses-sse.js";
import { stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";

const MODEL_REF = "mock-openai/gpt-5.6-luna";
const RESPONSE_MARKER = "ACTIVE_MEMORY_TRIGGER_STALL_PROOF_OK";
const RECALL_PROMPT_SIGNATURE = "You are a memory search agent.";
const RECALL_SUMMARY =
  "Retrieved from memory: Deploy window decision: Tuesday 02:00 UTC, agreed last week.";
const MEMORY_FACT = "Deploy window decision: Tuesday 02:00 UTC, agreed last week.";
const PREFLIGHT_TIMEOUT_LINE = "before_prompt_build preflight timed out after 1500ms";
const LANE_ONE_FAILED_LINE = "lane-1 trigger recall failed";
const LOCK_RELEASE_FALLBACK_MS = 6_000;
const TEST_TIMEOUT_MS = 600_000;

type GatewayChatRun = { runId?: unknown; status?: unknown };
type ModelRequest = {
  kind: "recall-tool" | "recall-final" | "chat";
  injected: boolean;
};

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup();
  }
});

function writeTextResponse(response: ServerResponse, text: string): void {
  const message = {
    type: "message",
    id: `trigger-stall-proof-${randomUUID()}`,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  writeOpenAiResponsesSse(response, [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...message, status: "in_progress", content: [] },
    },
    { type: "response.output_item.done", output_index: 0, item: message },
    {
      type: "response.completed",
      response: {
        id: `trigger-stall-proof-response-${randomUUID()}`,
        status: "completed",
        output: [message],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      },
    },
  ]);
}

function writeToolCallResponse(
  response: ServerResponse,
  name: string,
  args: Record<string, unknown>,
): void {
  const itemId = `fc_${randomUUID()}`;
  const argumentsText = JSON.stringify(args);
  const item = {
    type: "function_call",
    id: itemId,
    call_id: `call_${randomUUID()}`,
    name,
    arguments: argumentsText,
  };
  writeOpenAiResponsesSse(response, [
    { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } },
    {
      type: "response.function_call_arguments.delta",
      item_id: itemId,
      output_index: 0,
      delta: argumentsText,
    },
    {
      type: "response.function_call_arguments.done",
      item_id: itemId,
      output_index: 0,
      name,
      arguments: argumentsText,
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: `trigger-stall-proof-tool-${randomUUID()}`,
        status: "completed",
        output: [item],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      },
    },
  ]);
}

async function startMockProvider() {
  const requests: ModelRequest[] = [];
  const server = createServer((request, response) => {
    void (async () => {
      let body = "";
      for await (const chunk of request) {
        body += String(chunk);
      }
      if (request.method === "GET" && request.url === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "gpt-5.6-luna", object: "model" }] }));
        return;
      }
      if (request.method === "POST" && request.url === "/v1/embeddings") {
        const inputs = JSON.parse(body) as { input?: string | string[] };
        const texts = Array.isArray(inputs.input) ? inputs.input : [inputs.input ?? ""];
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            object: "list",
            model: "text-embedding-3-small",
            data: texts.map((text, index) => ({
              object: "embedding",
              index,
              // Separate the seeded decision from default workspace templates.
              // Identical vectors let unrelated templates fill the result window.
              embedding: Array.from({ length: 64 }, (_, dimension) =>
                dimension === (text.toLowerCase().includes("deploy") ? 0 : 1) ? 1 : 0,
              ),
            })),
            usage: { prompt_tokens: 1, total_tokens: 1 },
          }),
        );
        return;
      }
      if (request.method !== "POST" || request.url !== "/v1/responses") {
        response.writeHead(404).end();
        return;
      }
      const payload = JSON.parse(body) as { input?: Array<{ type?: string; output?: unknown }> };
      if (!body.includes(RECALL_PROMPT_SIGNATURE)) {
        requests.push({ kind: "chat", injected: body.includes(RECALL_SUMMARY) });
        writeTextResponse(
          response,
          body.includes(RECALL_SUMMARY)
            ? `${RESPONSE_MARKER}: ${RECALL_SUMMARY}`
            : "No Active Memory recall context.",
        );
        return;
      }
      // The recall agent must ground its summary in a real memory_search result,
      // so the first recall round asks for the tool and the second summarizes.
      if (body.includes("function_call_output")) {
        requests.push({ kind: "recall-final", injected: false });
        const grounded =
          payload.input?.some(
            (item) =>
              item.type === "function_call_output" &&
              JSON.stringify(item.output).includes(MEMORY_FACT),
          ) === true;
        writeTextResponse(
          response,
          grounded ? RECALL_SUMMARY : "No indexed fact was returned by the recall tool.",
        );
        return;
      }
      requests.push({ kind: "recall-tool", injected: false });
      writeToolCallResponse(response, "memory_search", { query: "deploy window decision" });
    })().catch((error: unknown) => {
      if (!response.headersSent) {
        response.writeHead(500);
      }
      response.end(error instanceof Error ? error.message : String(error));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("mock provider did not bind a loopback port");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    stop: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

type GatewayLogSource = { workspaceDir: string; tempRoot: string };

async function readLogFiles(gateway: GatewayLogSource): Promise<Map<string, string>> {
  const logsDir = path.join(gateway.workspaceDir, "logs");
  const names = (await fs.readdir(logsDir).catch(() => [])).filter((name) => name.endsWith(".log"));
  const files = [
    ...names.toSorted().map((name) => path.join(logsDir, name)),
    path.join(gateway.tempRoot, "gateway.stdout.log"),
    path.join(gateway.tempRoot, "gateway.stderr.log"),
  ];
  const entries = await Promise.all(
    files.map(async (file) => [file, await fs.readFile(file, "utf8").catch(() => "")] as const),
  );
  return new Map(entries);
}

async function snapshotLogOffsets(gateway: GatewayLogSource): Promise<Map<string, number>> {
  return new Map([...(await readLogFiles(gateway))].map(([file, text]) => [file, text.length]));
}

async function readLogsSince(
  gateway: GatewayLogSource,
  offsets: Map<string, number>,
): Promise<string> {
  return [...(await readLogFiles(gateway))]
    .map(([file, text]) => text.slice(offsets.get(file) ?? 0))
    .join("\n");
}

function holdGenerationLock(lockPath: string) {
  const db = new DatabaseSync(lockPath);
  db.exec("PRAGMA busy_timeout = 0");
  db.exec("BEGIN EXCLUSIVE");
  return () => {
    try {
      db.exec("ROLLBACK");
    } finally {
      db.close();
    }
  };
}

describe.runIf(process.env.OPENCLAW_ACTIVE_MEMORY_TRIGGER_STALL_PROOF === "1")(
  "Active Memory trigger-lookup stall product proof",
  () => {
    it(
      "still runs model recall when the memory index generation lock stalls trigger lookup",
      { timeout: TEST_TIMEOUT_MS },
      async () => {
        const provider = await startMockProvider();
        cleanups.push(() => provider.stop());
        const gatewayOwner = createQaGatewayChild();
        cleanups.push(() => stopQaGatewayFixture(gatewayOwner));
        const gateway = await gatewayOwner.start({
          repoRoot: process.cwd(),
          // Built Gateway: source-mode tsx startup alone exceeds the QA child's
          // 120 s listen deadline on a cold checkout.
          command: {
            executablePath: process.execPath,
            argsPrefix: ["dist/index.js"],
            cwd: process.cwd(),
            usePackagedPlugins: true,
          },
          providerBaseUrl: `${provider.baseUrl}/v1`,
          providerMode: "mock-openai",
          primaryModel: MODEL_REF,
          alternateModel: MODEL_REF,
          transportBaseUrl: "http://127.0.0.1",
          controlUiEnabled: false,
          runtimeEnvPatch: {
            OPENCLAW_SKIP_CHANNELS: "1",
            OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
          },
          mutateConfig: (config) => ({
            ...config,
            logging: { ...config.logging, level: "debug" },
            plugins: {
              ...config.plugins,
              allow: [...(config.plugins?.allow ?? []), "active-memory"],
              entries: {
                ...config.plugins?.entries,
                "active-memory": {
                  enabled: true,
                  config: {
                    enabled: true,
                    mode: "always",
                    agents: ["qa"],
                    timeoutMs: 15_000,
                    logging: true,
                  },
                },
              },
            },
          }),
        });
        const stateDir = path.join(gateway.tempRoot, "state");
        const agentDbPath = path.join(stateDir, "agents", "qa", "agent", "openclaw-agent.sqlite");
        const lockPath = `${agentDbPath}.generation-lock.sqlite`;

        // Seed one curated memory so a grounded memory_search can back the
        // recall summary, then index it through the real CLI.
        await fs.writeFile(
          path.join(gateway.workspaceDir, "MEMORY.md"),
          `# Memory\n\n## Decisions\n\n- ${MEMORY_FACT}\n`,
          "utf8",
        );
        await gateway.runCli(["memory", "index", "--agent", "qa"]);

        const runTurn = async (label: string, releaseLockOnLaneOneFailure?: () => void) => {
          const offsets = await snapshotLogOffsets(gateway);
          const requestsBefore = provider.requests.length;
          const sessionKey = `agent:qa:direct:trigger-stall-${label}-${randomUUID()}`;
          const startedAt = Date.now();
          const started = (await gateway.call(
            "chat.send",
            {
              sessionKey,
              message: "What did we decide about the deploy window last week?",
              deliver: false,
              idempotencyKey: randomUUID(),
            },
            { timeoutMs: 30_000 },
          )) as GatewayChatRun;
          expect(started).toMatchObject({ status: "started" });
          if (releaseLockOnLaneOneFailure) {
            // Keep the lock only until lane one gives up, so the recall agent's
            // own memory_search can then complete: a transient publisher lock.
            while (Date.now() - startedAt < LOCK_RELEASE_FALLBACK_MS) {
              if ((await readLogsSince(gateway, offsets)).includes(LANE_ONE_FAILED_LINE)) {
                break;
              }
              await sleep(50);
            }
            releaseLockOnLaneOneFailure();
          }
          const terminal = (await gateway.call(
            "agent.wait",
            { runId: started.runId, timeoutMs: 120_000 },
            { timeoutMs: 125_000 },
          )) as GatewayChatRun;
          const history = await gateway.call("chat.history", { sessionKey, limit: 20 });
          const replyGrounded = JSON.stringify(history).includes(
            `${RESPONSE_MARKER}: ${RECALL_SUMMARY}`,
          );
          const logText = await readLogsSince(gateway, offsets);
          const modelRequests = provider.requests.slice(requestsBefore);
          const record = {
            phase: label,
            replyGrounded,
            terminalStatus: terminal.status,
            preflightTimedOut: logText.includes(PREFLIGHT_TIMEOUT_LINE),
            laneOneFailed: logText.includes(LANE_ONE_FAILED_LINE),
            recallRounds: modelRequests.filter((entry) => entry.kind !== "chat").length,
            contextInjected: modelRequests.some((entry) => entry.kind === "chat" && entry.injected),
          };
          console.log(JSON.stringify(record));
          return record;
        };

        // Control turn: no lock, trigger lookup completes, grounded recall lands in the prompt.
        const control = await runTurn("control");
        expect(control.terminalStatus).toBe("ok");
        expect(control.preflightTimedOut).toBe(false);
        expect(control.recallRounds).toBeGreaterThanOrEqual(2);
        expect(control.contextInjected).toBe(true);
        expect(control.replyGrounded).toBe(true);
        await fs.access(lockPath);

        // Stalled turn: another process holds the index generation lock, so
        // memory-core's read-generation acquisition spins until lane one aborts.
        const releaseLock = holdGenerationLock(lockPath);
        let released = false;
        const releaseOnce = () => {
          if (!released) {
            released = true;
            releaseLock();
          }
        };
        let stalled: Awaited<ReturnType<typeof runTurn>>;
        try {
          stalled = await runTurn("stalled", releaseOnce);
        } finally {
          releaseOnce();
        }
        console.log(
          JSON.stringify({
            phase: "active-memory-trigger-stall-proof-complete",
            control: {
              recallRounds: control.recallRounds,
              contextInjected: control.contextInjected,
            },
            stalled: {
              preflightTimedOut: stalled.preflightTimedOut,
              laneOneFailed: stalled.laneOneFailed,
              recallRounds: stalled.recallRounds,
              contextInjected: stalled.contextInjected,
            },
            marker: RESPONSE_MARKER,
          }),
        );
        expect(stalled.terminalStatus).toBe("ok");
        expect(stalled.preflightTimedOut).toBe(false);
        expect(stalled.laneOneFailed).toBe(true);
        expect(stalled.recallRounds).toBeGreaterThanOrEqual(2);
        expect(stalled.contextInjected).toBe(true);
        expect(stalled.replyGrounded).toBe(true);
      },
    );
  },
);
