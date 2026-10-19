import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const repo = process.cwd();
const token = "pr135296-loopback-cli-token";
const modelRef = "pr135296-proof/gpt-proof";
const tasks = {
  explicit: "PR135296_CHILD_EXPLICIT_HIGH",
  omitted: "PR135296_CHILD_OMITTED_THINKING",
  corrected: "PR135296_CHILD_CORRECTED_RETRY",
} as const;
const labels = {
  explicit: "PR135296 CLI explicit high",
  omitted: "PR135296 CLI omitted thinking",
  corrected: "PR135296 CLI corrected retry",
} as const;
const expectBase = process.argv.includes("--expect-base");
type Scenario = keyof typeof tasks | "invalid";
const scenarioArg = process.argv
  .find((arg) => arg.startsWith("--scenario="))
  ?.slice("--scenario=".length);
function isScenario(value: string | undefined): value is Scenario {
  return (
    value === "explicit" || value === "omitted" || value === "corrected" || value === "invalid"
  );
}
if (!isScenario(scenarioArg)) {
  throw new Error("Pass --scenario=explicit|omitted|corrected|invalid");
}
const scenario = scenarioArg;

type Child = {
  exitCode: number | null;
  kill(signal: NodeJS.Signals): boolean;
  once(event: "error", listener: (error: Error) => void): Child;
  once(event: "exit", listener: (code: number | null) => void): Child;
  output: string;
  stderr: { on(event: "data", listener: (chunk: Buffer) => void): unknown } | null;
  stdout: { on(event: "data", listener: (chunk: Buffer) => void): unknown } | null;
};
type InputItem = {
  call_id?: string;
  content?: unknown;
  output?: unknown;
  role?: string;
  type?: string;
};
type ProviderRequest = {
  reasoning: unknown;
  sessionsSpawnHasThinking: boolean;
};
type ProviderServer = {
  address(): { port: number } | string | null;
  close(callback?: (error?: Error) => void): ProviderServer;
  closeAllConnections(): void;
  listen(port: number, host: string, callback: () => void): ProviderServer;
  listening: boolean;
  once(event: "error", listener: (error: Error) => void): ProviderServer;
};

function child(command: string, args: string[], env: NodeJS.ProcessEnv, label: string): Child {
  const proc = spawn(command, args, {
    cwd: repo,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  }) as unknown as Child;
  proc.output = "";
  proc.stdout?.on("data", (chunk) => {
    proc.output = `${proc.output}${chunk}`.slice(-64_000);
  });
  proc.stderr?.on("data", (chunk) => {
    proc.output = `${proc.output}${chunk}`.slice(-64_000);
  });
  proc.once("error", (error) => {
    proc.output = `${proc.output}\n${label}: ${error.message}`;
  });
  return proc;
}

async function capture(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<{ exitCode: number | null; output: string }> {
  const proc = child(command, args, env, "cli");
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`Command timed out after ${timeoutMs}ms: ${proc.output}`));
    }, timeoutMs);
    proc.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    proc.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, output: proc.output });
    });
  });
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", (error: Error) => reject(error));
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => {
        if (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        } else {
          resolve(port);
        }
      });
    });
  });
}

async function waitForHttp(url: string, proc: Child, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "not ready";
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new Error(`Gateway exited: ${proc.output}`);
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) {
        return;
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await delay(100);
  }
  throw new Error(`Gateway health check did not pass (${lastError}): ${proc.output}`);
}

async function stop(proc: Child | undefined): Promise<void> {
  if (!proc || proc.exitCode !== null) {
    return;
  }
  proc.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve();
    }, 5_000);
    proc.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function inputText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part: unknown) =>
      typeof part === "object" && part !== null && "text" in part && typeof part.text === "string"
        ? part.text
        : "",
    )
    .join("\n");
}

function hasThinkingInSpawnTool(tools: unknown): boolean {
  if (!Array.isArray(tools)) {
    return false;
  }
  const spawnTool = tools.find(
    (tool): tool is Record<string, unknown> =>
      typeof tool === "object" && tool !== null && "name" in tool && tool.name === "sessions_spawn",
  );
  if (!spawnTool || typeof spawnTool.parameters !== "object" || spawnTool.parameters === null) {
    return false;
  }
  const properties = (spawnTool.parameters as Record<string, unknown>).properties;
  return typeof properties === "object" && properties !== null && "thinking" in properties;
}

function sendToolCall(
  writeSse: (response: ServerResponse, events: Array<Record<string, unknown>>) => void,
  response: ServerResponse,
  id: string,
  args: Record<string, unknown>,
): void {
  const item = {
    type: "function_call",
    id: `fc_${id}`,
    call_id: `call_${id}`,
    name: "sessions_spawn",
    arguments: JSON.stringify(args),
    status: "completed",
  };
  writeSse(response, [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, status: "in_progress", arguments: "" },
    },
    {
      type: "response.function_call_arguments.done",
      item_id: item.id,
      output_index: 0,
      arguments: item.arguments,
    },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: `resp_${id}`,
        status: "completed",
        output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ]);
}

async function readRequest(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function parseCliJson(output: string): Record<string, unknown> {
  for (let start = output.indexOf("{"); start >= 0; start = output.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < output.length; index += 1) {
      const char = output[index];
      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === '"') {
          inString = false;
        }
        continue;
      }
      if (char === '"') {
        inString = true;
        continue;
      }
      if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          try {
            const value: unknown = JSON.parse(output.slice(start, index + 1));
            if (typeof value === "object" && value !== null && !Array.isArray(value)) {
              return value as Record<string, unknown>;
            }
          } catch {
            break;
          }
        }
      }
    }
  }
  throw new Error(`CLI did not emit a JSON result: ${output.slice(-2000)}`);
}

function findSessions(value: unknown): Array<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.sessions)) {
    return record.sessions as Array<Record<string, unknown>>;
  }
  for (const key of ["result", "payload", "data"]) {
    const found = findSessions(record[key]);
    if (found.length > 0) {
      return found;
    }
  }
  return [];
}

async function main(): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-pr135296-shipped-cli-"));
  const stateDir = path.join(root, ".openclaw");
  const workspace = path.join(root, "workspace");
  const configPath = path.join(stateDir, "openclaw.json");
  const gatewayPort = await freePort();
  const providerRequests: ProviderRequest[] = [];
  const childRequests: Array<{ task: string; reasoning: unknown }> = [];
  const toolFailureOutputs: string[] = [];
  let toolCallsSent = 0;
  let providerServer: ProviderServer | undefined;
  let gateway: Child | undefined;
  let sequence = 0;

  try {
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(stateDir, { recursive: true });
    const providerAddress = await new Promise<number>((resolve, reject) => {
      const server = createServer((request, response) => {
        void (async () => {
          if (request.method !== "POST" || request.url !== "/v1/responses") {
            response.writeHead(404).end();
            return;
          }
          const body = await readRequest(request);
          const input = Array.isArray(body.input) ? (body.input as InputItem[]) : [];
          const id = String(++sequence);
          providerRequests.push({
            reasoning: body.reasoning,
            sessionsSpawnHasThinking: hasThinkingInSpawnTool(body.tools),
          });
          const finish = (text: string) =>
            writeText(response, {
              text,
              messageId: `msg_${id}`,
              responseId: `resp_${id}`,
            });
          const sendSpawn = (args: Record<string, unknown>) => {
            toolCallsSent += 1;
            sendToolCall(writeSse, response, id, args);
          };
          const childTask = Object.values(tasks).find((task) =>
            input.some((item) => item?.role === "user" && inputText(item.content).includes(task)),
          );
          if (childTask) {
            childRequests.push({ task: childTask, reasoning: body.reasoning });
            finish(`Completed ${childTask}.`);
            return;
          }
          let lastOutput: InputItem | undefined;
          for (let index = input.length - 1; index >= 0; index -= 1) {
            if (input[index]?.type === "function_call_output") {
              lastOutput = input[index];
              break;
            }
          }
          if (lastOutput) {
            const output = JSON.stringify(lastOutput.output);
            if (
              output.includes("Parameters require visible=true: group") ||
              output.includes("Invalid thinking level")
            ) {
              toolFailureOutputs.push(output.slice(0, 500));
            }
            if (
              scenario === "corrected" &&
              output.includes("Parameters require visible=true: group")
            ) {
              sendSpawn({
                task: `Return ${tasks.corrected}.`,
                runtime: "subagent",
                mode: "run",
                group: "pr135296-cli-proof",
                label: labels.corrected,
                visible: true,
                thinking: "HIGH",
              });
              return;
            }
            finish(`sessions_spawn response: ${output}`);
            return;
          }

          if (scenario === "explicit") {
            sendSpawn({
              task: `Return ${tasks.explicit}.`,
              runtime: "subagent",
              mode: "run",
              label: labels.explicit,
              visible: true,
              thinking: "high",
            });
            return;
          }
          if (scenario === "omitted") {
            sendSpawn({
              task: `Return ${tasks.omitted}.`,
              runtime: "subagent",
              mode: "run",
              label: labels.omitted,
              visible: true,
            });
            return;
          }
          if (scenario === "corrected") {
            sendSpawn({
              task: `Return ${tasks.corrected}.`,
              runtime: "subagent",
              mode: "run",
              group: "pr135296-cli-proof",
              label: labels.corrected,
              thinking: "HIGH",
            });
            return;
          }
          if (scenario === "invalid") {
            sendSpawn({
              task: "This invalid request must not create a session.",
              runtime: "subagent",
              mode: "run",
              label: "PR135296 CLI invalid thinking",
              visible: true,
              thinking: "not-a-thinking-level",
            });
            return;
          }
          finish("Completed scenario; no further parent action.");
        })().catch((error: unknown) => {
          response.writeHead(500, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { message: String(error) } }));
        });
      }) as unknown as ProviderServer;
      providerServer = server;
      server.once("error", (error) => reject(error));
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("Loopback model listener missing"));
          return;
        }
        resolve(address.port);
      });
    });
    const config = {
      plugins: { allow: ["openai"] },
      agents: {
        ownership: "explicit",
        defaults: {
          workspace,
          skipBootstrap: true,
          systemAgent: { agentId: "main" },
          model: { primary: modelRef },
          subagents: { allowAgents: ["worker"] },
        },
        entries: { main: { subagents: { allowAgents: ["worker"] } }, worker: {} },
      },
      tools: { profile: "coding", codeMode: false, toolSearch: false, allow: ["sessions_spawn"] },
      models: {
        mode: "replace",
        providers: {
          "pr135296-proof": {
            baseUrl: `http://127.0.0.1:${providerAddress}/v1`,
            apiKey: "loopback-test-key",
            api: "openai-responses",
            request: { allowPrivateNetwork: true },
            models: [
              {
                id: "gpt-proof",
                name: "gpt-proof",
                api: "openai-responses",
                reasoning: true,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128_000,
                maxTokens: 4096,
              },
            ],
          },
        },
      },
      gateway: {
        mode: "local",
        bind: "loopback",
        port: gatewayPort,
        auth: { mode: "token", token },
        controlUi: { enabled: false },
      },
    };
    await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
    const env = {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      OPENCLAW_HOME: root,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_GATEWAY_TOKEN: token,
      OPENCLAW_GATEWAY_PORT: String(gatewayPort),
      OPENAI_API_KEY: "loopback-test-key",
      OPENCLAW_NO_RESPAWN: "1",
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_SKIP_GMAIL_WATCHER: "1",
      OPENCLAW_SKIP_CRON: "1",
      OPENCLAW_SKIP_STARTUP_MODEL_PREWARM: "1",
      NO_PROXY: "localhost,127.0.0.1,::1",
      no_proxy: "localhost,127.0.0.1,::1",
    };
    const { openOpenClawStateDatabase, closeOpenClawStateDatabaseByPathAsync } = await import(
      pathToFileURL(path.join(repo, "src/state/openclaw-state-db.ts")).href
    );
    const initializedState = openOpenClawStateDatabase();
    await closeOpenClawStateDatabaseByPathAsync(initializedState.path);

    gateway = child(
      process.execPath,
      [
        "--import",
        "./scripts/tsx.mjs",
        "src/index.ts",
        "gateway",
        "run",
        "--force",
        "--port",
        String(gatewayPort),
        "--bind",
        "loopback",
      ],
      env,
      "gateway",
    );
    await waitForHttp(`http://127.0.0.1:${gatewayPort}/health`, gateway);

    const cli = async (args: string[]) => {
      const result = await capture(
        process.execPath,
        ["--import", "./scripts/tsx.mjs", "src/index.ts", ...args],
        env,
        120_000,
      );
      if (result.exitCode !== 0) {
        throw new Error(`OpenClaw CLI exited ${result.exitCode}: ${result.output}`);
      }
      return result.output;
    };
    const runAgent = async (marker: string) => {
      const sessionKey = `agent:main:pr135296-cli-${marker.slice(0, marker.indexOf(":")).toLowerCase()}`;
      return await cli([
        "agent",
        "--agent",
        "main",
        "--session-key",
        sessionKey,
        "--message",
        marker,
        "--timeout",
        "100",
        "--json",
      ]);
    };
    const marker = `PR135296_${scenario.toUpperCase()}`;
    await runAgent(`${marker}: run the ${scenario} visible sessions_spawn case.`);
    const sessionsResult = parseCliJson(
      await cli([
        "gateway",
        "call",
        "sessions.list",
        "--url",
        `ws://127.0.0.1:${gatewayPort}`,
        "--token",
        token,
        "--params",
        JSON.stringify({ includeGlobal: true, limit: 100 }),
        "--json",
      ]),
    );
    const sessions = findSessions(sessionsResult);
    const byLabel = (label: string) => sessions.find((session) => session.label === label);
    const expectedLabel =
      scenario === "invalid" ? "PR135296 CLI invalid thinking" : labels[scenario];
    const observed = byLabel(expectedLabel);
    const shouldCreate = scenario === "omitted" || (!expectBase && scenario !== "invalid");
    const children = Object.fromEntries(
      Object.entries(tasks).map(([name, task]) => [
        name,
        childRequests.find((request) => request.task === task)?.reasoning ?? null,
      ]),
    );
    const headSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repo,
      encoding: "utf8",
    }).trim();
    const result = {
      passed: true,
      mode: expectBase ? "pinned-base" : "exact-head",
      scenario,
      headSha,
      entrypoint:
        "openclaw agent CLI → separate production Gateway process → sessions_spawn tool → Gateway sessions.create → Gateway sessions.list",
      gateway: "production Gateway child process, authenticated loopback WebSocket",
      provider: "deterministic OpenAI Responses endpoint bound to 127.0.0.1",
      externalProviderAccess: false,
      cliExitStatus: 0,
      visibleToolCalls: {
        sessionCreated: Boolean(observed),
        thinkingLevel: observed?.thinkingLevel ?? null,
        thinkingOverridePersisted: Object.hasOwn(observed ?? {}, "thinkingLevel"),
      },
      childAgentReasoning: scenario === "invalid" ? null : children[scenario],
      providerRequestCount: providerRequests.length,
      sessionsSpawnToolAvailable: providerRequests.some(
        ({ sessionsSpawnHasThinking }) => sessionsSpawnHasThinking,
      ),
      toolCallsSent,
      toolFailureOutputs,
      agentCommandAndDiscoveryMocks: false,
      sessionsObservedBy: "production gateway call sessions.list",
    };

    if (shouldCreate !== Boolean(observed)) {
      throw new Error(`CLI session creation mismatch for ${scenario}: ${JSON.stringify(result)}`);
    }
    if (scenario === "explicit" && !expectBase && observed?.thinkingLevel !== "high") {
      throw new Error(`CLI did not persist explicit high: ${JSON.stringify(result)}`);
    }
    if (scenario === "omitted" && Object.hasOwn(observed ?? {}, "thinkingLevel")) {
      throw new Error(`CLI changed omitted defaults: ${JSON.stringify(result)}`);
    }
    if (scenario === "corrected" && !expectBase && observed?.thinkingLevel !== "high") {
      throw new Error(`CLI did not preserve corrected retry: ${JSON.stringify(result)}`);
    }
    const expectedChildEffort = scenario === "omitted" ? "medium" : "high";
    if (shouldCreate) {
      const childReasoning = children[scenario];
      if (
        typeof childReasoning !== "object" ||
        childReasoning === null ||
        (childReasoning as Record<string, unknown>).effort !== expectedChildEffort
      ) {
        throw new Error(
          `CLI child run did not inherit ${expectedChildEffort}: ${JSON.stringify(result)}`,
        );
      }
    }
    if (
      scenario === "corrected" &&
      !toolFailureOutputs.some((text) => text.includes("Parameters require"))
    ) {
      throw new Error(
        `Corrected retry did not follow the expected validation error: ${JSON.stringify(result)}`,
      );
    }
    if (
      scenario === "invalid" &&
      !toolFailureOutputs.some((text) => text.includes("Invalid thinking level"))
    ) {
      throw new Error(
        `Invalid level was not rejected by the production tool: ${JSON.stringify(result)}`,
      );
    }
    const expectedToolCalls = scenario === "corrected" ? 2 : 1;
    if (toolCallsSent !== expectedToolCalls || !result.sessionsSpawnToolAvailable) {
      throw new Error(`Unexpected CLI tool calls for ${scenario}: ${JSON.stringify(result)}`);
    }
    const proofJson = `${JSON.stringify(result)}\n`;
    const outputPath = process.env.PR135296_PROOF_OUTPUT;
    if (outputPath) {
      await fs.writeFile(outputPath, proofJson);
    }
    console.log(proofJson.trimEnd());
  } finally {
    await stop(gateway);
    if (providerServer?.listening) {
      providerServer.closeAllConnections();
      await new Promise<void>((resolve) => {
        providerServer?.close(() => resolve());
      });
    }
    await fs.rm(root, { recursive: true, force: true });
  }
}

const openAiHelpers = await import(
  pathToFileURL(path.join(repo, "test/helpers/openai-responses-sse.js")).href
);
const writeSse = openAiHelpers.writeOpenAiResponsesSse as (
  response: ServerResponse,
  events: Array<Record<string, unknown>>,
) => void;
const writeText = openAiHelpers.writeOpenAiResponsesText as (
  response: ServerResponse,
  params: { text: string; messageId: string; responseId: string },
) => void;

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
