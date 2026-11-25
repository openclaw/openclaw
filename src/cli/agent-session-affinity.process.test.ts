import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders } from "node:http";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  closeHttpServer,
  listenLoopback,
} from "../../test/helpers/gateway-integration-fixtures.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createCliProcessFixture } from "./isolated-process-fixture.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const affinityHeaders = ["Session_ID", "X-Client-Request-ID", "X-Session-Affinity"];
const completion = (delta: { role?: string; content?: string }, finish_reason: "stop" | null) => ({
  id: "affinity",
  object: "chat.completion.chunk",
  choices: [{ index: 0, delta, finish_reason }],
});

it.each([
  { name: "enabled", enabled: true, retention: "short", expected: "affinity-enabled:0" },
  { name: "cache-none", enabled: true, retention: "none", expected: undefined },
  { name: "opt-out", enabled: false, retention: "short", expected: undefined },
  { name: "configured", enabled: true, retention: "short", expected: "configured-affinity" },
])("agent --local honors $name affinity at HTTP egress", async (testCase) => {
  const root = tempDirs.make("openclaw-affinity-cli-");
  const fixture = createCliProcessFixture(root, {
    TMPDIR: root,
    OPENCLAW_HOME: root,
    OPENCLAW_STATE_DIR: root,
    ESBUILD_WORKER_THREADS: "0",
    NO_COLOR: "1",
  });
  const requests: Array<{ url: string | undefined; headers: IncomingHttpHeaders; body: string }> =
    [];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      requests.push({ url: request.url, headers: request.headers, body });
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        [completion({ role: "assistant", content: "affinity-ok" }, null), completion({}, "stop")]
          .map((frame) => `data: ${JSON.stringify(frame)}\n\n`)
          .join("") + "data: [DONE]\n\n",
      );
    });
  });
  try {
    const baseUrl = `${await listenLoopback(server)}/v1`;
    const model = {
      id: "affinity-fixture",
      name: "Affinity fixture",
      compat: {
        sendSessionAffinityHeaders: testCase.enabled,
        ...(testCase.name === "cache-none" ? { supportsPromptCacheKey: true } : {}),
      },
      ...(testCase.name === "configured"
        ? { headers: Object.fromEntries(affinityHeaders.map((key) => [key, testCase.expected])) }
        : {}),
    };
    const provider = {
      api: "openai-completions",
      baseUrl,
      apiKey: "synthetic-loopback-key",
      models: [model],
    };
    await fixture.writeConfig({
      agents: {
        defaults: {
          workspace: path.join(root, "workspace"),
          skipBootstrap: true,
          model: { primary: "affinity-fixture/affinity-fixture" },
          params: { cacheRetention: testCase.retention },
        },
        entries: { main: {} },
      },
      models: { mode: "replace", providers: { "affinity-fixture": provider } },
      tools: { profile: "minimal" },
    });
    const result = await fixture.run([
      ..."agent --local --agent main --session-id".split(" "),
      `affinity-${testCase.name}`,
      "--message",
      "Reply affinity-ok",
      ..."--thinking off --json".split(" "),
    ]);
    expect(result, result.stderr).toMatchObject({ code: 0, signal: null });
    expect(JSON.parse(result.stdout)).toMatchObject({ payloads: [{ text: "affinity-ok" }] });
    expect(requests).toMatchObject([
      {
        url: "/v1/chat/completions",
        headers: { authorization: "Bearer synthetic-loopback-key" },
      },
    ]);
    const [request] = requests;
    assert(request, "expected the affinity HTTP request");
    expect(JSON.parse(request.body)).toMatchObject({
      model: "affinity-fixture",
      stream: true,
    });
    expect(
      ["session_id", "x-client-request-id", "x-session-affinity"].map(
        (header) => request.headers[header],
      ),
    ).toEqual(Array<string | undefined>(3).fill(testCase.expected));
  } finally {
    await closeHttpServer(server);
  }
});
