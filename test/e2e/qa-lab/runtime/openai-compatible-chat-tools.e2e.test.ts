import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import { createServer, type RequestListener, type Server } from "node:http";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { resolveSlotSelection } from "../../../../src/plugins/slots.js";
import { runNodeScript } from "../../../helpers/run-node-script.js";
import { cleanupTempDirs, makeTempDir } from "../../../helpers/temp-dir.js";

const clientPath = path.resolve("scripts/e2e/lib/openai-chat-tools/client.mjs");
const dockerRunnerPath = path.resolve("scripts/e2e/openai-chat-tools-docker.sh");
const tempDirs: string[] = [];
afterEach(() => cleanupTempDirs(tempDirs));

async function listen(server: Server): Promise<number> {
  await once(server.listen(0, "127.0.0.1"), "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("test server did not expose a TCP port");
  }
  return address.port;
}

async function runClient(
  handler: RequestListener,
  env: Record<string, string> = {},
  timeout = 5_000,
) {
  const server = createServer(handler);
  try {
    return await runNodeScript(
      clientPath,
      {
        ...process.env,
        MODEL_REF: "openai/gpt-5.4-mini",
        OPENCLAW_GATEWAY_TOKEN: "test-token",
        OPENCLAW_OPENAI_CHAT_TOOLS_TIMEOUT_SECONDS: "1",
        PORT: String(await listen(server)),
        ...env,
      },
      timeout,
    );
  } finally {
    server.close();
  }
}

function runFixture(command: string, script: string, env: Record<string, string>) {
  return spawnSync(command, [script], { encoding: "utf8", env: { ...process.env, ...env } });
}

it("keeps full profile exports out of the Docker build phase", () => {
  const runner = readFileSync(dockerRunnerPath, "utf8");
  const preflightSourceIndex = runner.indexOf('source "$profile_file"');
  const buildIndex = runner.indexOf("docker_e2e_build_or_reuse");
  const fullProfileSourceIndex = runner.indexOf('source "$PROFILE_FILE"', buildIndex);

  expect(preflightSourceIndex).toBeGreaterThanOrEqual(0);
  expect(buildIndex).toBeGreaterThan(preflightSourceIndex);
  expect(fullProfileSourceIndex).toBeGreaterThan(buildIndex);
});

it("treats placeholder profile auth as missing before Docker build work starts", () => {
  const root = makeTempDir(tempDirs, "openclaw-openai-chat-tools-");
  const profile = path.join(root, "profile");
  writeFileSync(profile, "OPENAI_API_KEY=undefined\n");
  const result = runFixture("bash", dockerRunnerPath, {
    HOME: root,
    OPENAI_API_KEY: "",
    OPENAI_BASE_URL: "",
    OPENCLAW_OPENAI_CHAT_TOOLS_PROFILE_FILE: profile,
  });
  const output = `${result.stdout}\n${result.stderr}`;

  expect(result.status).toBe(1);
  expect(output).toContain("OPENAI_API_KEY was not available");
  expect(output).not.toContain("Building Docker image:");
  expect(output).not.toContain("Reusing Docker image:");
  expect(output).not.toContain("Running OpenAI Chat Completions tools Docker E2E");
});

it("disables background memory indexing while keeping the OpenAI provider enabled", () => {
  const root = makeTempDir(tempDirs, "openclaw-openai-chat-tools-");
  const result = runFixture(
    process.execPath,
    path.resolve("scripts/e2e/lib/openai-chat-tools/write-config.mjs"),
    {
      OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
      OPENCLAW_GATEWAY_TOKEN: "test-token",
      OPENCLAW_OPENAI_CHAT_TOOLS_MODEL: "openai/gpt-5.6-luna",
      OPENCLAW_STATE_DIR: path.join(root, "state"),
      OPENCLAW_TEST_WORKSPACE_DIR: path.join(root, "workspace"),
      PORT: "18789",
    },
  );
  expect(result.status, result.stderr).toBe(0);
  const config = JSON.parse(readFileSync(path.join(root, "openclaw.json"), "utf8"));
  // An allowlist alone does not disable the implicit memory slot. Its startup
  // catch-up reads would restore the fixture before the chat recall boundary.
  expect(resolveSlotSelection("memory", config.plugins.slots?.memory)).toEqual({ kind: "off" });
  expect(config.plugins.enabled).toBe(true);
  expect(config.plugins.entries.openai.enabled).toBe(true);
  expect(config.session.maintenance.coldStorage.enabled).toBe(true);
});

it.each([undefined, "I will call the tool now."])(
  "requires a tool-only response (content=%s)",
  async (content) => {
    const result = await runClient((request, response) => {
      expect(request).toMatchObject({
        method: "POST",
        url: "/v1/chat/completions",
        headers: { authorization: "Bearer test-token", "x-openclaw-model": "openai/gpt-5.4-mini" },
      });
      response.writeHead(200, { "content-type": "application/json" });
      const toolCall = {
        type: "function",
        function: { name: "get_weather", arguments: JSON.stringify({ city: "Paris, France" }) },
      };
      const message = { ...(content ? { content } : {}), tool_calls: [toolCall] };
      response.end(JSON.stringify({ choices: [{ finish_reason: "tool_calls", message }] }));
    });
    if (content) {
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("expected tool call only response");
      return;
    }
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      args: { city: "Paris, France" },
      finishReason: "tool_calls",
      ok: true,
      toolName: "get_weather",
    });
  },
);

it("keeps the request timeout active while reading the response body", async () => {
  let responseClosed = false;
  const startedAt = Date.now();
  const result = await runClient(
    (_request, response) => {
      response.on("close", () => {
        responseClosed = true;
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"choices":');
    },
    {},
    4_000,
  );
  expect(result.error).toBeUndefined();
  expect(result.status).not.toBe(0);
  expect(result.stderr).toMatch(/timed out|aborted|AbortError/iu);
  expect(Date.now() - startedAt).toBeLessThan(3_500);
  expect(responseClosed).toBe(true);
});

it("rejects unsafe declared chat completion body lengths before waiting on the stream", async () => {
  const startedAt = Date.now();
  const result = await runClient(
    (_request, response) => {
      response.writeHead(200, {
        "content-length": "9007199254740993",
        "content-type": "application/json",
      });
      response.flushHeaders();
    },
    { OPENCLAW_OPENAI_CHAT_TOOLS_MAX_BODY_BYTES: "64" },
  );
  expect(result.error).toBeUndefined();
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("chat completions response body exceeded 64 bytes");
  expect(result.stderr).not.toContain("timed out");
  expect(Date.now() - startedAt).toBeLessThan(3_500);
});
