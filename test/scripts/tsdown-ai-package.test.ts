import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { build } from "tsdown";
import { expect, it } from "vitest";
import manifest from "../../packages/ai/package.json" with { type: "json" };
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import config from "../../tsdown.ai.config.ts";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();

it("runs a relocated OpenAI adapter without loading individual OpenAI or ws modules", async () => {
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
    for (const dependency of Object.keys(manifest.dependencies)) {
      const destination = path.join(root, "node_modules", dependency);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.symlinkSync(
        fs.realpathSync(path.join("packages/ai/node_modules", dependency)),
        destination,
        "junction",
      );
    }
    await promisify(execFile)(
      resolveTestNodeExecPath(),
      [
        "--input-type=module",
        "-e",
        `
      import assert from "node:assert/strict";
      import { registerHooks } from "node:module";
      const loadedDependencies = new Set();
      registerHooks({ resolve(specifier, context, next) {
        assert(!["openai", "ws"].some((name) => specifier === name || specifier.startsWith(name + "/")), "SDK modules must be bundled: " + specifier);
        loadedDependencies.add(specifier);
        return next(specifier, context);
      }});
      const { createApiRegistry, createNodeLlmRuntime } = await import("./dist/index.mjs");
      const { registerBuiltInApiProviders } = await import("./dist/providers.mjs");
      await import("./dist/transports.mjs");
      await import("./dist/internal/openai.mjs");
      await import("./dist/validation.mjs");
      const registry = createApiRegistry();
      registerBuiltInApiProviders(registry);
      let request;
      const runtime = createNodeLlmRuntime(registry, { buildModelFetch: () => async (input, init) => {
        request = await new Request(input, init).json();
        return new Response('data: ' + JSON.stringify({
          id: "fixture-response", model: "openai-test",
          choices: [{ index: 0, delta: { content: "bundled response" }, finish_reason: "stop" }]
        }) + '\\n\\ndata: [DONE]\\n\\n', { headers: { "content-type": "text/event-stream" } });
      }});
      const result = await runtime.stream({
        id: "openai-test", name: "OpenAI Test", api: "openai-completions", provider: "openai",
        baseUrl: "https://openai.invalid", reasoning: false, input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192
      }, { messages: [{ role: "user", content: "hello", timestamp: 0 }] }, { apiKey: "fixture-key" }).result();
      assert.equal(result.stopReason, "stop", JSON.stringify(result));
      assert.deepEqual(result.content, [{ type: "text", text: "bundled response" }]);
      assert.equal(request.model, "openai-test");
      assert.equal(request.messages[0].content, "hello");
      assert([...loadedDependencies].some((id) => id === "typebox" || id.startsWith("typebox/")),
        "TypeBox retains its external identity");
    `,
      ],
      { cwd: root, timeout: 30_000 },
    );
    expect(fs.readFileSync(path.join(outDir, "openai.LICENSE"), "utf8")).toContain("Apache");
    expect(fs.readFileSync(path.join(outDir, "ws.LICENSE"), "utf8")).toContain("MIT");
  } finally {
    await Promise.all(bundles.map((bundle) => bundle[Symbol.asyncDispose]()));
  }
});
