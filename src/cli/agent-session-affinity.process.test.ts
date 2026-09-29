import fs from "node:fs/promises";
import { createServer, type IncomingHttpHeaders } from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { cliRecoveryEntrypoints } from "./cli-entrypoint.test-support.js";
import { runCliProcessChild } from "./cli-process-child.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("agent --local session affinity at HTTP egress", () => {
  it.each([
    { name: "enabled", enabled: true, retention: "short", expected: "affinity-enabled:0" },
    { name: "cache-none", enabled: true, retention: "none", expected: undefined },
    { name: "opt-out", enabled: false, retention: "short", expected: undefined },
    { name: "configured", enabled: true, retention: "short", expected: "configured-affinity" },
  ])("honors $name through the registered CLI and installed transport policy", async (testCase) => {
    const root = tempDirs.make("openclaw-affinity-cli-");
    const configPath = path.join(root, "openclaw.json");
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
          [
            {
              id: "affinity",
              object: "chat.completion.chunk",
              choices: [
                {
                  index: 0,
                  delta: { role: "assistant", content: "affinity-ok" },
                  finish_reason: null,
                },
              ],
            },
            {
              id: "affinity",
              object: "chat.completion.chunk",
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            },
          ]
            .map((frame) => `data: ${JSON.stringify(frame)}\n\n`)
            .join("") + "data: [DONE]\n\n",
        );
      });
    });
    try {
      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Loopback receiver did not bind");
      }
      await fs.writeFile(
        configPath,
        JSON.stringify({
          agents: {
            defaults: {
              workspace: path.join(root, "workspace"),
              skipBootstrap: true,
              model: { primary: "affinity-fixture/affinity-fixture" },
              params: { cacheRetention: testCase.retention },
            },
            entries: { main: { default: true } },
          },
          models: {
            mode: "replace",
            providers: {
              "affinity-fixture": {
                api: "openai-completions",
                baseUrl: `http://127.0.0.1:${address.port}/v1`,
                apiKey: "synthetic-loopback-key",
                models: [
                  {
                    id: "affinity-fixture",
                    name: "Affinity fixture",
                    reasoning: false,
                    input: ["text"],
                    contextWindow: 128000,
                    maxTokens: 4096,
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    compat: {
                      sendSessionAffinityHeaders: testCase.enabled,
                      ...(testCase.name === "cache-none" ? { supportsPromptCacheKey: true } : {}),
                    },
                    ...(testCase.name === "configured"
                      ? {
                          headers: {
                            Session_ID: testCase.expected,
                            "X-Client-Request-ID": testCase.expected,
                            "X-Session-Affinity": testCase.expected,
                          },
                        }
                      : {}),
                  },
                ],
              },
            },
          },
          tools: { profile: "minimal" },
        }),
      );
      const result = await runCliProcessChild({
        nodeArgs: [
          ...resolveRuntimeWorkerArgv(resolveRuntimeWorkerUrl(cliRecoveryEntrypoints.cli)),
          "agent",
          "--local",
          "--agent",
          "main",
          "--session-id",
          `affinity-${testCase.name}`,
          "--message",
          "Reply affinity-ok",
          "--thinking",
          "off",
          "--json",
        ],
        env: {
          PATH: process.env.PATH,
          HOME: root,
          USERPROFILE: root,
          TMPDIR: root,
          OPENCLAW_HOME: root,
          OPENCLAW_STATE_DIR: root,
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_NO_RESPAWN: "1",
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
          ESBUILD_WORKER_THREADS: "0",
          NO_COLOR: "1",
        },
      });
      expect(result, result.stderr).toMatchObject({ code: 0, signal: null });
      expect(JSON.parse(result.stdout)).toMatchObject({ payloads: [{ text: "affinity-ok" }] });
      expect(requests).toHaveLength(1);
      for (const request of requests) {
        expect(request).toMatchObject({
          url: "/v1/chat/completions",
          headers: { authorization: "Bearer synthetic-loopback-key" },
        });
        expect(JSON.parse(request.body)).toMatchObject({
          model: "affinity-fixture",
          stream: true,
        });
        for (const header of ["session_id", "x-client-request-id", "x-session-affinity"]) {
          expect(request.headers[header], header).toBe(testCase.expected);
        }
      }
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
