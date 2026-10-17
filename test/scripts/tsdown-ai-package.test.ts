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

it("streams Mistral from the built AI package without installing the SDK", async () => {
  const root = createTempDir("openclaw-ai-package-");
  const outDir = path.join(root, "dist");
  const { bundles } = await build({
    ...config,
    config: false,
    entry: {
      index: "packages/ai/src/index.ts",
      providers: "packages/ai/src/providers.ts",
    },
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
    expect(fs.readFileSync(path.join(outDir, "mistral.LICENSE"), "utf8")).toContain(
      "Apache License",
    );
    const script = `
      import assert from "node:assert/strict";
      import { registerHooks } from "node:module";
      const loadedDependencies = new Set();
      registerHooks({ resolve(specifier, context, next) {
        assert(!specifier.startsWith("@mistralai/"), "Mistral SDK must be bundled");
        loadedDependencies.add(specifier);
        return next(specifier, context);
      }});
      const { createApiRegistry, createNodeLlmRuntime } = await import("./dist/index.mjs");
      const { registerBuiltInApiProviders } = await import("./dist/providers.mjs");
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
    `;
    for (const mode of ["without-telemetry", "with-telemetry"]) {
      if (mode === "with-telemetry") {
        for (const dependency of Object.keys(manifest.peerDependencies)) {
          const destination = path.join(root, "node_modules", dependency);
          fs.mkdirSync(path.dirname(destination), { recursive: true });
          fs.symlinkSync(
            fs.realpathSync(path.join("packages/ai/node_modules", dependency)),
            destination,
            "junction",
          );
        }
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
