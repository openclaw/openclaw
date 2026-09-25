import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createQaGatewayChild } from "../../../../extensions/qa-lab/api.js";
import { stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";

const MODEL = "anthropic/claude-sonnet-4-6";
const WARNING =
  "Claude Code version probe: command-failed; OAuth requests keep the built-in version floor";
const STDOUT_SENTINEL = "version-proof-stdout-sentinel";
const STDERR_SENTINEL = "version-proof-stderr-sentinel";
const OAUTH_TOKEN = "sk-ant-oat01-version-proof-only";
const cleanups: Array<() => Promise<void>> = [];

type ProviderRequest = {
  method: string | undefined;
  url: string | undefined;
  authorization: boolean;
  apiKey: boolean;
  userAgent: string | undefined;
  model: string | undefined;
  stream: boolean;
};

type GatewayRun = {
  runId?: string;
  status?: string;
};

afterEach(async () => {
  const errors: unknown[] = [];
  for (const cleanup of cleanups.splice(0).toReversed()) {
    try {
      await cleanup();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1 && errors[0] instanceof Error) {
    throw errors[0];
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "Anthropic version proof cleanup failed");
  }
});

async function createFailingClaudeProbe(): Promise<{ binDir: string; markerPath: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-version-proof-"));
  const binDir = path.join(root, "bin");
  const markerPath = path.join(root, "claude-invoked.marker");
  await fs.mkdir(binDir, { recursive: true });
  if (process.platform === "win32") {
    await fs.writeFile(
      path.join(binDir, "claude.cmd"),
      [
        "@echo off",
        '> "%CLAUDE_VERSION_PROOF_MARKER%" echo invoked',
        `echo ${STDOUT_SENTINEL}`,
        `echo ${STDERR_SENTINEL} 1>&2`,
        "exit /b 17",
        "",
      ].join("\r\n"),
      "utf8",
    );
  } else {
    const probePath = path.join(binDir, "claude");
    await fs.writeFile(
      probePath,
      [
        "#!/bin/sh",
        `printf '%s\\n' invoked > "$CLAUDE_VERSION_PROOF_MARKER"`,
        `printf '%s\\n' '${STDOUT_SENTINEL}'`,
        `printf '%s\\n' '${STDERR_SENTINEL}' >&2`,
        "exit 17",
        "",
      ].join("\n"),
      { encoding: "utf8", mode: 0o755 },
    );
    await fs.chmod(probePath, 0o755);
  }
  cleanups.push(async () => fs.rm(root, { recursive: true, force: true }));
  return { binDir, markerPath };
}

async function startLoopbackAnthropicProvider() {
  const requests: ProviderRequest[] = [];
  let resolveRequest: (request: ProviderRequest) => void = () => {};
  const requestReceived = new Promise<ProviderRequest>((resolve) => {
    resolveRequest = resolve;
  });
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    } catch {
      body = {};
    }
    const record: ProviderRequest = {
      method: request.method,
      url: request.url,
      authorization: typeof request.headers.authorization === "string",
      apiKey: typeof request.headers["x-api-key"] === "string",
      userAgent:
        typeof request.headers["user-agent"] === "string"
          ? request.headers["user-agent"]
          : undefined,
      model: typeof body.model === "string" ? body.model : undefined,
      stream: body.stream === true,
    };
    requests.push(record);
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && requestUrl.pathname === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "claude-sonnet-4-6", object: "model" }] }));
      return;
    }
    if (request.method !== "POST" || requestUrl.pathname !== "/v1/messages") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { type: "not_found" } }));
      return;
    }
    const message = {
      id: "msg_version_proof",
      type: "message",
      role: "assistant",
      model: record.model ?? "claude-sonnet-4-6",
      content: [{ type: "text", text: "proof-ok" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    };
    const events = [
      {
        type: "message_start",
        message: {
          ...message,
          content: [],
          stop_reason: null,
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "proof-ok" } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: message.usage },
      { type: "message_stop" },
    ];
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "close",
    });
    for (const event of events) {
      response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    }
    response.end();
    resolveRequest(record);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("version proof provider did not bind loopback");
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });
  return { baseUrl, requests, requestReceived };
}

describe("Anthropic Claude Code version probe real Gateway proof", () => {
  it("logs only the fixed failure category while an OAuth request reaches loopback", async () => {
    const probe = await createFailingClaudeProbe();
    const provider = await startLoopbackAnthropicProvider();
    const gatewayOwner = createQaGatewayChild();
    cleanups.push(() => stopQaGatewayFixture(gatewayOwner));
    const gateway = await gatewayOwner.start({
      repoRoot: process.cwd(),
      command: {
        executablePath: process.execPath,
        argsPrefix: ["dist/entry.js"],
        cwd: process.cwd(),
        usePackagedPlugins: false,
      },
      providerBaseUrl: provider.baseUrl,
      providerMode: "mock-openai",
      primaryModel: MODEL,
      alternateModel: MODEL,
      transportBaseUrl: provider.baseUrl,
      enabledPluginIds: ["anthropic"],
      mockAuthAgentIds: [],
      controlUiEnabled: false,
      runtimeEnvPatch: {
        PATH: `${probe.binDir}${path.delimiter}${process.env.PATH ?? ""}`,
        CLAUDE_VERSION_PROOF_MARKER: probe.markerPath,
        ANTHROPIC_API_KEY: "",
        ANTHROPIC_OAUTH_TOKEN: OAUTH_TOKEN,
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
      },
      mutateConfig: (config) => {
        const anthropic = {
          ...(config.models?.providers?.anthropic ?? {}),
          baseUrl: provider.baseUrl,
          api: "anthropic-messages",
        };
        delete anthropic.apiKey;
        return {
          ...config,
          plugins: {
            allow: ["anthropic"],
            entries: { anthropic: { enabled: true } },
          },
          auth: {
            ...(config.auth ?? {}),
            profiles: {},
            order: {},
          },
          models: {
            ...(config.models ?? {}),
            providers: {
              ...(config.models?.providers ?? {}),
              anthropic,
            },
          },
        };
      },
    });

    const started = (await gateway.call(
      "agent",
      {
        sessionKey: `agent:qa:${randomUUID()}`,
        message: "Return proof-ok.",
        deliver: false,
        idempotencyKey: randomUUID(),
      },
      { timeoutMs: 30_000 },
    )) as GatewayRun;
    expect(started).toMatchObject({ status: "accepted" });
    expect(typeof started.runId).toBe("string");

    const request = await Promise.race([
      provider.requestReceived,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("loopback provider request timeout")), 20_000),
      ),
    ]);
    const terminal = (await gateway.call(
      "agent.wait",
      { runId: started.runId, timeoutMs: 30_000 },
      { timeoutMs: 35_000 },
    )) as GatewayRun;
    expect(terminal.status).toBe("ok");

    const logs = gateway.logs();
    const marker = await fs.readFile(probe.markerPath, "utf8");
    const proof = {
      warning,
      warningCount: logs.split(WARNING).length - 1,
      requestCount: provider.requests.length,
      request: {
        method: request.method,
        path: request.url,
        authorization: request.authorization,
        apiKey: request.apiKey,
        userAgent: request.userAgent,
        model: request.model,
        stream: request.stream,
      },
      fakeProbeInvoked: marker.trim() === "invoked",
      stdoutSentinelInLogs: logs.includes(STDOUT_SENTINEL),
      stderrSentinelInLogs: logs.includes(STDERR_SENTINEL),
    };
    console.log(`[anthropic-version-proof] ${JSON.stringify(proof)}`);
    expect(proof).toMatchObject({
      warning,
      warningCount: 1,
      requestCount: 1,
      fakeProbeInvoked: true,
      stdoutSentinelInLogs: false,
      stderrSentinelInLogs: false,
    });
    expect(proof.request).toMatchObject({
      method: "POST",
      path: "/v1/messages",
      authorization: true,
      apiKey: false,
      model: "claude-sonnet-4-6",
      stream: true,
    });
    expect(proof.request.userAgent ?? "").not.toMatch(/^claude-cli\//u);
  }, 90_000);
});
