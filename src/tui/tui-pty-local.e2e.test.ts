// Exercises slower TUI PTY paths against real local and Gateway backends.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createOpenClawTestInstance } from "../../test/helpers/openclaw-test-instance.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { GatewayChatClient } from "./gateway-chat.js";
import { sleep, startPty, waitFor, type PtyRun } from "./tui-pty-test-support.js";

type MockModelServer = {
  baseUrl: string;
  requests: () => MockModelRequest[];
  stop: () => Promise<void>;
};

type MockModelRequest = {
  method: string;
  path: string;
  body: Record<string, unknown>;
};

const activeRuns: PtyRun[] = [];
const LOCAL_STARTUP_TIMEOUT_MS = 60_000;
const LOCAL_OUTPUT_TIMEOUT_MS = 120_000;
const LOCAL_EXIT_TIMEOUT_MS = 4_000;
const LOCAL_TEST_TIMEOUT_MS = 150_000;

async function readRequestBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function writeJson(res: ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  res.end(text);
}

async function writeResponsesSse(res: ServerResponse, text: string, completionDelayMs = 0) {
  const id = "msg_tui_pty_local";
  const events = [
    {
      type: "response.output_item.added",
      item: { type: "message", id, role: "assistant", content: [], status: "in_progress" },
    },
    {
      type: "response.output_text.delta",
      item_id: id,
      output_index: 0,
      content_index: 0,
      delta: text,
    },
    {
      type: "response.output_text.done",
      item_id: id,
      output_index: 0,
      content_index: 0,
      text,
    },
    {
      type: "response.output_item.done",
      item: {
        type: "message",
        id,
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    },
    {
      type: "response.completed",
      response: {
        id: "resp_tui_pty_local",
        status: "completed",
        output: [
          {
            type: "message",
            id,
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text, annotations: [] }],
          },
        ],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ];
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
  res.write(`data: ${JSON.stringify(events[0])}\n\n`);
  if (completionDelayMs > 0) {
    await sleep(completionDelayMs);
  }
  if (res.destroyed) {
    return;
  }
  const completionBody = `${events
    .slice(1)
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .join("")}data: [DONE]\n\n`;
  res.end(completionBody);
}

async function readJsonRequest(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readRequestBody(req);
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

async function startMockModelServer(
  replyText: string,
  opts: { firstResponseDelayMs?: number; followupReplyText?: string } = {},
): Promise<MockModelServer> {
  const requests: MockModelRequest[] = [];
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "GET" && (url.pathname === "/healthz" || url.pathname === "/readyz")) {
        writeJson(res, 200, { ok: true });
        return;
      }
      if (req.method === "GET" && url.pathname === "/v1/models") {
        writeJson(res, 200, { data: [{ id: "gpt-5.5", object: "model" }] });
        return;
      }
      if (req.method === "POST") {
        const body = await readJsonRequest(req);
        const requestIndex = requests.length;
        requests.push({ method: req.method, path: url.pathname, body });
        if (url.pathname === "/v1/responses" || url.pathname === "/responses") {
          await writeResponsesSse(
            res,
            requestIndex === 0 ? replyText : (opts.followupReplyText ?? replyText),
            requestIndex === 0 ? (opts.firstResponseDelayMs ?? 0) : 0,
          );
          return;
        }
        writeJson(res, 404, { error: "not found" });
        return;
      }
      writeJson(res, 404, { error: "not found" });
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("mock model server did not bind");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests: () => requests,
    stop: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

function buildTuiCliScript(args: string[]) {
  const tuiCliModuleUrl = pathToFileURL(path.join(process.cwd(), "src/cli/tui-cli.ts")).href;
  return [
    `import { Command } from "commander";`,
    `import { registerTuiCli } from ${JSON.stringify(tuiCliModuleUrl)};`,
    `const program = new Command();`,
    `program.exitOverride();`,
    `registerTuiCli(program);`,
    `program.parseAsync([process.execPath, "openclaw", ...${JSON.stringify(args)}], { from: "node" }).catch((error) => {`,
    `  console.error(error);`,
    `  process.exit(1);`,
    `});`,
  ].join("\n");
}

function buildLocalModeConfig(params: { workspaceDir: string; providerBaseUrl: string }) {
  return {
    plugins: {
      enabled: false,
      slots: {
        memory: "none",
      },
    },
    agents: {
      defaults: {
        workspace: params.workspaceDir,
        model: { primary: "tui-pty-mock/gpt-5.5" },
        models: {
          "tui-pty-mock/gpt-5.5": { agentRuntime: { id: "openclaw" } },
        },
        skills: [],
        skipBootstrap: true,
      },
      list: [
        {
          id: "main",
          default: true,
          skills: [],
          model: { primary: "tui-pty-mock/gpt-5.5" },
        },
      ],
    },
    tools: {
      profile: "minimal",
    },
    models: {
      mode: "replace",
      providers: {
        "tui-pty-mock": {
          baseUrl: `${params.providerBaseUrl}/v1`,
          apiKey: "test",
          api: "openai-responses",
          request: { allowPrivateNetwork: true },
          models: [
            {
              id: "gpt-5.5",
              name: "gpt-5.5",
              api: "openai-responses",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128000,
              maxTokens: 4096,
            },
          ],
        },
      },
    },
    gateway: {
      mode: "local",
      auth: { mode: "token", token: "tui-pty-local" },
    },
    discovery: { mdns: { mode: "off" } },
  } satisfies OpenClawConfig;
}

async function startLocalModeTui() {
  const replyText = "LOCAL_PTY_RESPONSE";
  const tempDir = await mkdtemp(path.join(tmpdir(), "openclaw-tui-pty-local-"));
  const workspaceDir = path.join(tempDir, "workspace");
  const homeDir = path.join(tempDir, "home");
  const stateDir = path.join(tempDir, "state");
  const xdgConfigHome = path.join(tempDir, "xdg-config");
  const xdgDataHome = path.join(tempDir, "xdg-data");
  const xdgCacheHome = path.join(tempDir, "xdg-cache");
  const configPath = path.join(tempDir, "openclaw.json");
  const mockModel = await startMockModelServer(replyText);
  const config = buildLocalModeConfig({ workspaceDir, providerBaseUrl: mockModel.baseUrl });
  const script = buildTuiCliScript(["tui", "--local"]);
  await Promise.all([
    mkdir(workspaceDir, { recursive: true }),
    mkdir(homeDir, { recursive: true }),
    mkdir(stateDir, { recursive: true }),
    mkdir(xdgConfigHome, { recursive: true }),
    mkdir(xdgDataHome, { recursive: true }),
    mkdir(xdgCacheHome, { recursive: true }),
    writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8"),
  ]);

  const run = startPty(process.execPath, ["--import", "tsx", "--eval", script], {
    activeRuns,
    cwd: process.cwd(),
    env: {
      HOME: homeDir,
      OPENCLAW_HOME: homeDir,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_STATE_DIR: stateDir,
      XDG_CONFIG_HOME: xdgConfigHome,
      XDG_DATA_HOME: xdgDataHome,
      XDG_CACHE_HOME: xdgCacheHome,
      OPENCLAW_THEME: "dark",
      OPENCLAW_CODEX_DISCOVERY_LIVE: "0",
      NO_COLOR: undefined,
    },
    exitTimeoutMs: LOCAL_EXIT_TIMEOUT_MS,
    outputTimeoutMs: LOCAL_OUTPUT_TIMEOUT_MS,
  });

  return {
    run,
    mockModel,
    cleanup: async () => {
      run.dispose();
      await mockModel.stop();
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}

async function startGatewayModeTui(params: {
  queueMode: "followup" | "collect";
  firstResponseDelayMs?: number;
  queueDebounceMs?: number;
}) {
  const tempDir = await mkdtemp(path.join(tmpdir(), "openclaw-tui-pty-gateway-"));
  const workspaceDir = path.join(tempDir, "workspace");
  const mockModel = await startMockModelServer("FIRST_RUN_ACTIVE", {
    firstResponseDelayMs: params.firstResponseDelayMs ?? 2_500,
    followupReplyText: "FOLLOWUP_RUN_COMPLETE",
  });
  const config = {
    ...buildLocalModeConfig({ workspaceDir, providerBaseUrl: mockModel.baseUrl }),
    messages: {
      queue: {
        mode: params.queueMode,
        debounceMs: params.queueDebounceMs ?? 25,
      },
    },
  } satisfies OpenClawConfig;
  const gateway = await createOpenClawTestInstance({
    name: `tui-pty-gateway-${params.queueMode}`,
    gatewayToken: "tui-pty-local",
    config,
    env: {
      OPENCLAW_CODEX_DISCOVERY_LIVE: "0",
      OPENCLAW_SKIP_PROVIDERS: undefined,
    },
  });
  try {
    await mkdir(workspaceDir, { recursive: true });
    await gateway.startGateway();
    const script = buildTuiCliScript([
      "tui",
      "--url",
      gateway.url,
      "--token",
      gateway.gatewayToken,
      "--session",
      "agent:main:main",
    ]);
    const run = startPty(process.execPath, ["--import", "tsx", "--eval", script], {
      activeRuns,
      cwd: process.cwd(),
      env: {
        ...gateway.env,
        OPENCLAW_THEME: "dark",
        NO_COLOR: undefined,
      },
      exitTimeoutMs: LOCAL_EXIT_TIMEOUT_MS,
      outputTimeoutMs: LOCAL_OUTPUT_TIMEOUT_MS,
    });
    return {
      run,
      gateway,
      mockModel,
      cleanup: async () => {
        run.dispose();
        await gateway.cleanup();
        await mockModel.stop();
        await rm(tempDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await gateway.cleanup();
    await mockModel.stop();
    await rm(tempDir, { recursive: true, force: true });
    throw error;
  }
}

describe("TUI PTY real backends", () => {
  afterEach(async () => {
    for (const run of activeRuns.splice(0)) {
      run.dispose();
    }
  });

  it(
    "drives the real local backend with a mocked model endpoint",
    async () => {
      const fixture = await startLocalModeTui();
      try {
        await fixture.run.waitForOutput("local ready", LOCAL_STARTUP_TIMEOUT_MS);
        for (const command of ["/status", "/compact", "/commands", "/context"]) {
          await fixture.run.write(`${command}\r`);
          await fixture.run.waitForOutput(
            `${command} is not available in local embedded mode; message not sent`,
          );
        }
        await fixture.run.write("/side\r");
        await fixture.run.waitForOutput("Usage: /btw [side question]");
        expect(fixture.mockModel.requests()).toHaveLength(0);

        await fixture.run.write("send the local PTY smoke response\r");
        await waitFor({
          timeoutMs: LOCAL_OUTPUT_TIMEOUT_MS,
          read: () => (fixture.mockModel.requests().length > 0 ? true : null),
          onTimeout: () =>
            new Error(
              `mock model server did not receive a request\nrequests=${JSON.stringify(
                fixture.mockModel.requests(),
                null,
                2,
              )}\n${fixture.run.output()}`,
            ),
        });
        const request = fixture.mockModel.requests()[0];
        expect(request?.path).toBe("/v1/responses");
        expect(request?.body.model).toBe("gpt-5.5");
        await fixture.run.waitForOutput("LOCAL_PTY_RESPONSE");

        await fixture.run.write("/exit\r", { delay: false });
        const exit = await fixture.run.waitForExit();
        expect(exit.exitCode).toBe(0);
      } finally {
        await fixture.cleanup();
      }
    },
    LOCAL_TEST_TIMEOUT_MS,
  );

  it(
    "forwards an active-run prompt through the real Gateway followup queue",
    async () => {
      const fixture = await startGatewayModeTui({ queueMode: "followup" });
      try {
        await fixture.run.waitForOutput("gateway connected", LOCAL_STARTUP_TIMEOUT_MS);
        await fixture.run.write("slow first turn\r");
        await waitFor({
          timeoutMs: LOCAL_OUTPUT_TIMEOUT_MS,
          read: () => (fixture.mockModel.requests().length === 1 ? true : null),
          onTimeout: () =>
            new Error(`first prompt did not reach the model\n${fixture.run.output()}`),
        });

        await fixture.run.write("queued followup turn\r");
        await waitFor({
          timeoutMs: LOCAL_OUTPUT_TIMEOUT_MS,
          read: () => (fixture.mockModel.requests().length === 2 ? true : null),
          onTimeout: () =>
            new Error(
              `queued prompt did not reach the model\nrequests=${JSON.stringify(
                fixture.mockModel.requests(),
                null,
                2,
              )}\n${fixture.gateway.logs()}\n${fixture.run.output()}`,
            ),
        });
        await fixture.run.waitForOutput("FOLLOWUP_RUN_COMPLETE");

        await fixture.run.write("turn after queued followup\r");
        await waitFor({
          timeoutMs: LOCAL_OUTPUT_TIMEOUT_MS,
          read: () => (fixture.mockModel.requests().length === 3 ? true : null),
          onTimeout: () =>
            new Error(
              `TUI stayed blocked after queued followup\nrequests=${JSON.stringify(
                fixture.mockModel.requests(),
                null,
                2,
              )}\n${fixture.gateway.logs()}\n${fixture.run.output()}`,
            ),
        });
        expect(JSON.stringify(fixture.mockModel.requests()[2]?.body)).toContain(
          "turn after queued followup",
        );

        await fixture.run.write("/exit\r", { delay: false });
        expect((await fixture.run.waitForExit()).exitCode).toBe(0);
      } finally {
        await fixture.cleanup();
      }
    },
    LOCAL_TEST_TIMEOUT_MS,
  );

  it(
    "cancels an admitted followup with Esc before it reaches the model",
    async () => {
      const fixture = await startGatewayModeTui({
        queueMode: "followup",
        firstResponseDelayMs: 3_000,
      });
      try {
        await fixture.run.waitForOutput("gateway connected", LOCAL_STARTUP_TIMEOUT_MS);
        await fixture.run.write("slow turn to abort\r");
        await waitFor({
          timeoutMs: LOCAL_OUTPUT_TIMEOUT_MS,
          read: () => (fixture.mockModel.requests().length === 1 ? true : null),
          onTimeout: () =>
            new Error(`first prompt did not reach the model\n${fixture.run.output()}`),
        });
        await fixture.run.write("must never reach model\r");
        await sleep(150);
        await fixture.run.write("\u001b", { delay: false });
        await fixture.run.waitForOutput("aborted");
        await sleep(3_250);

        expect(fixture.mockModel.requests()).toHaveLength(1);
        expect(fixture.run.output()).not.toContain("FOLLOWUP_RUN_COMPLETE");

        await fixture.run.write("/exit\r", { delay: false });
        expect((await fixture.run.waitForExit()).exitCode).toBe(0);
      } finally {
        await fixture.cleanup();
      }
    },
    LOCAL_TEST_TIMEOUT_MS,
  );

  it(
    "collects two TUI-client prompts into one real Gateway followup turn",
    async () => {
      const fixture = await startGatewayModeTui({
        queueMode: "collect",
        firstResponseDelayMs: 4_000,
        queueDebounceMs: 1_000,
      });
      const queueClient = new GatewayChatClient({
        url: fixture.gateway.url,
        token: fixture.gateway.gatewayToken,
        allowInsecureLocalOperatorUi: false,
      });
      try {
        let queueClientConnected = false;
        queueClient.onConnected = () => {
          queueClientConnected = true;
        };
        queueClient.start();
        await fixture.run.waitForOutput("gateway connected", LOCAL_STARTUP_TIMEOUT_MS);
        await waitFor({
          timeoutMs: LOCAL_STARTUP_TIMEOUT_MS,
          read: () => (queueClientConnected ? true : null),
          onTimeout: () => new Error("TUI Gateway client did not connect"),
        });
        await fixture.run.write("/queue collect debounce:1s\r", { delay: false });
        await fixture.run.waitForOutput("Queue mode set to collect.");
        await fixture.run.write("slow collect parent\r");
        await waitFor({
          timeoutMs: LOCAL_OUTPUT_TIMEOUT_MS,
          read: () => (fixture.mockModel.requests().length === 1 ? true : null),
          onTimeout: () =>
            new Error(`first prompt did not reach the model\n${fixture.run.output()}`),
        });
        const alphaSend = queueClient.sendChat({
          sessionKey: "agent:main:main",
          message: "collect prompt alpha",
          runId: "collect-alpha",
        });
        await sleep(100);
        const betaSend = queueClient.sendChat({
          sessionKey: "agent:main:main",
          message: "collect prompt beta",
          runId: "collect-beta",
        });
        const sendResults = await Promise.all([alphaSend, betaSend]);
        expect(sendResults.map((result) => result.status)).toEqual(["started", "started"]);
        await waitFor({
          timeoutMs: LOCAL_OUTPUT_TIMEOUT_MS,
          read: () => (fixture.mockModel.requests().length === 2 ? true : null),
          onTimeout: () =>
            new Error(
              `collected prompt did not reach the model\n${fixture.gateway.logs()}\n${fixture.run.output()}`,
            ),
        });
        await sleep(1_000);

        const requests = fixture.mockModel.requests();
        expect(
          requests,
          `collect emitted ${requests.length} model requests\n${JSON.stringify(
            requests.map((request) => request.body.input),
            null,
            2,
          )}\n${fixture.gateway.logs()}`,
        ).toHaveLength(2);
        const collectedBody = JSON.stringify(fixture.mockModel.requests()[1]?.body);
        expect(collectedBody).toContain("collect prompt alpha");
        expect(collectedBody).toContain("collect prompt beta");

        await fixture.run.write("/exit\r", { delay: false });
        expect((await fixture.run.waitForExit()).exitCode).toBe(0);
      } finally {
        queueClient.stop();
        await fixture.cleanup();
      }
    },
    LOCAL_TEST_TIMEOUT_MS,
  );
});
