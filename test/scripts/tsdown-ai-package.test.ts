import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { build } from "tsdown";
import { expect, it } from "vitest";
import manifest from "../../packages/ai/package.json" with { type: "json" };
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import config from "../../tsdown.ai.config.ts";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();
function linkDependencies(root: string, dependencies: Record<string, string>) {
  for (const dependency of Object.keys(dependencies)) {
    const destination = path.join(root, "node_modules", dependency);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.symlinkSync(
      fs.realpathSync(path.join("packages/ai/node_modules", dependency)),
      destination,
      "junction",
    );
  }
}

it("loads bundled Mistral and Bun proxy support from production dependencies", async () => {
  const root = createTempDir("openclaw-ai-package-");
  const outDir = path.join(root, "dist");
  const { bundles } = await build({
    ...config,
    config: false,
    outDir,
    dts: false,
    logLevel: "silent",
  });
  try {
    const parserSource = path.resolve("packages/markdown-core/src/reasoning-tags.ts");
    const parserModules = bundles.flatMap((bundle) =>
      bundle.chunks
        .filter(
          (chunk) =>
            chunk.type === "chunk" &&
            Object.keys(chunk.modules).some((id) => path.resolve(id) === parserSource),
        )
        .map(
          (chunk) => pathToFileURL(fs.realpathSync(path.join(chunk.outDir, chunk.fileName))).href,
        ),
    );
    expect(parserModules.length).toBeGreaterThan(0);
    linkDependencies(root, manifest.dependencies);
    expect(fs.readFileSync(path.join(outDir, "mistral.LICENSE"), "utf8")).toContain(
      "Apache License",
    );
    const script = `
      import assert from "node:assert/strict";
      import { registerHooks } from "node:module";
      const loadedDependencies = new Set();
      const parserModules = new Set(${JSON.stringify(parserModules)});
      let startedProvider = false;
      registerHooks({ resolve(specifier, context, next) {
        assert(!specifier.startsWith("@mistralai/"), "Mistral SDK must be bundled");
        loadedDependencies.add(specifier);
        return next(specifier, context);
      }, load(url, context, next) {
        if (!startedProvider) {
          assert(!parserModules.has(url),
            "generic built imports must not load the reasoning parser");
        }
        return next(url, context);
      }});
      const { createApiRegistry, createNodeLlmRuntime } = await import("./dist/index.mjs");
      const { registerBuiltInApiProviders } = await import("./dist/providers.mjs");
      await import("./dist/transports.mjs");
      await import("./dist/internal/runtime.mjs");
      await import("./dist/internal/openai.mjs");
      await import("./dist/internal/anthropic.mjs");
      const registry = createApiRegistry();
      registerBuiltInApiProviders(registry);
      let request;
      const runtime = createNodeLlmRuntime(registry, {
        buildModelFetch: () => async (input, init) => {
          request = await new Request(input, init).json();
          return new Response('data: ' + JSON.stringify({
            id: "fixture-response", model: "mistral-test",
            choices: [{ index: 0, delta: { content: "bundled response" }, finish_reason: "stop" }]
          }) + '\\n\\ndata: [DONE]\\n\\n', {
            headers: { "content-type": "text/event-stream" }
          });
        }
      });
      startedProvider = true;
      const result = await runtime.stream({
        id: "mistral-test", name: "Mistral Test", api: "mistral-conversations",
        provider: "mistral", baseUrl: "https://mistral.invalid", reasoning: false,
        input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000, maxTokens: 8192
      }, {
        messages: [{ role: "user", content: "hello", timestamp: 0 }]
      }, { apiKey: "fixture-key" }).result();
      assert.equal(result.stopReason, "stop", JSON.stringify(result));
      assert.deepEqual(result.content, [{ type: "text", text: "bundled response" }]);
      assert.equal(request.model, "mistral-test");
      assert.equal(request.messages[0].content, "hello");
      assert(loadedDependencies.has("zod-to-json-schema"));
      if (process.argv[1] === "with-telemetry") {
        assert(loadedDependencies.has("@opentelemetry/semantic-conventions/incubating"));
      }
      if (process.argv[1] === "without-telemetry") {
        // Exercise the computed Bun import with only the package's declared dependencies.
        Object.defineProperty(process.versions, "bun", { value: "fixture" });
        for (const name of [
          "HTTPS_PROXY", "http_proxy", "https_proxy", "ALL_PROXY", "all_proxy",
          "NO_PROXY", "no_proxy", "npm_config_http_proxy", "npm_config_https_proxy",
          "npm_config_proxy", "npm_config_no_proxy"
        ]) {
          delete process.env[name];
        }
        process.env.HTTP_PROXY = "http://127.0.0.1:9";
        let reachedProxy = false;
        globalThis.WebSocket = class {
          constructor(_url, options) {
            assert.equal(options.proxy, process.env.HTTP_PROXY);
            reachedProxy = true;
            throw new Error("synthetic socket stop");
          }
        };
        const payload = Buffer.from(JSON.stringify({
          "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account" }
        })).toString("base64url");
        const proxyResult = await createNodeLlmRuntime(registry).stream({
          id: "synthetic-model", name: "Synthetic", api: "openai-chatgpt-responses",
          provider: "openai", baseUrl: "http://proxy-target.invalid/backend-api",
          reasoning: false, input: ["text"], contextWindow: 8192, maxTokens: 128,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
        }, { messages: [{ role: "user", content: "hello", timestamp: 0 }] }, {
          apiKey: "synthetic." + payload + ".synthetic", transport: "websocket", maxRetries: 0
        }).result();
        assert(reachedProxy, JSON.stringify(proxyResult));
        assert(loadedDependencies.has("proxy-from-env"));
      }
    `;
    for (const mode of ["without-telemetry", "with-telemetry"]) {
      if (mode === "with-telemetry") {
        linkDependencies(root, manifest.peerDependencies);
      }
      await promisify(execFile)(
        resolveTestNodeExecPath(),
        ["--input-type=module", "-e", script, mode],
        {
          cwd: root,
          timeout: 30_000,
        },
      );
    }
  } finally {
    await Promise.all(bundles.map((bundle) => bundle[Symbol.asyncDispose]()));
  }
});
